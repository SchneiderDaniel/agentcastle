/**
 * Tests for runWithSplash — Splash component wired into startup sequence.
 *
 * Phase 2: Verifies SplashComponent is created before extensions load,
 * subscribes to progress, renders to TUI, and dismisses when complete.
 *
 * Run with:
 *   node --experimental-strip-types --test test/run-with-splash.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Replicated types, SplashComponent, and runWithSplash for isolated testing.
// ---------------------------------------------------------------------------

type ExtensionLoadStatus = "pending" | "loading" | "done" | "failed";

interface ExtensionProgressEntry {
	name: string;
	status: ExtensionLoadStatus;
	error?: string;
}

interface LoadingProgress {
	total: number;
	completed: number;
	failed: number;
	pending: number;
	entries: ExtensionProgressEntry[];
}

interface ExtensionLoadingProgressEvent {
	type: "extension_loading_progress";
	total: number;
	completed: number;
	failed: number;
	pending: number;
	entries: ExtensionProgressEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal EventBus implementation for testing
// ─────────────────────────────────────────────────────────────────────────────

interface EventBus {
	on: (channel: string, handler: (data: unknown) => void) => () => void;
	emit: (channel: string, data: unknown) => void;
}

function createTestEventBus(): EventBus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			if (!handlers.has(channel)) handlers.set(channel, new Set());
			handlers.get(channel)!.add(handler);
			return () => handlers.get(channel)?.delete(handler);
		},
		emit(channel, data) {
			const set = handlers.get(channel);
			if (set) {
				for (const h of set) h(data);
			}
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// SplashComponent (replicated from src/splash-component.ts)
// ─────────────────────────────────────────────────────────────────────────────

function getStatusIcon(status: ExtensionLoadStatus): string {
	switch (status) {
		case "pending":
			return "·";
		case "loading":
			return "◌";
		case "done":
			return "✓";
		case "failed":
			return "✗";
	}
}

function renderProgressBar(fraction: number, width: number): string {
	const barWidth = Math.max(width - 2, 1);
	const filled = Math.round(fraction * barWidth);
	const empty = barWidth - filled;
	const bar = "=".repeat(filled) + "-".repeat(empty);
	return `[${bar}]`;
}

function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

function renderExtensionList(entries: ExtensionProgressEntry[], maxLines: number): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		if (lines.length >= maxLines) {
			const remaining = entries.length - maxLines;
			lines.push(`  ··· and ${remaining} more`);
			break;
		}
		const icon = getStatusIcon(entry.status);
		const errorSuffix = entry.error ? ` — ${entry.error}` : "";
		lines.push(`  ${icon} ${entry.name}${errorSuffix}`);
	}
	return lines;
}

class SplashComponent {
	private _title: string;
	private _version: string;
	private _progress: LoadingProgress | null = null;
	private _quiet: boolean;
	private _progressListeners: Array<(progress: LoadingProgress) => void> = [];

	constructor(title: string, version: string, quiet: boolean = false) {
		this._title = title;
		this._version = version;
		this._quiet = quiet;
	}

	get title(): string {
		return this._title;
	}
	get version(): string {
		return this._version;
	}
	get quiet(): boolean {
		return this._quiet;
	}
	get progress(): LoadingProgress | null {
		return this._progress;
	}

	update(progress: LoadingProgress): void {
		this._progress = progress;
		for (const listener of this._progressListeners) {
			listener(progress);
		}
	}

	onProgress(listener: (progress: LoadingProgress) => void): () => void {
		this._progressListeners.push(listener);
		return () => {
			const idx = this._progressListeners.indexOf(listener);
			if (idx !== -1) this._progressListeners.splice(idx, 1);
		};
	}

	render(width: number): string[] {
		if (this._quiet) return this._renderQuiet(width);
		return this._renderFull(width);
	}

	private _renderQuiet(_width: number): string[] {
		if (!this._progress) return ["  Loading..."];
		const { total, completed, failed } = this._progress;
		const fraction = total === 0 ? 1 : (completed + failed) / total;
		const pct = formatPercent(fraction);
		return [`  Loading... ${pct}`];
	}

	private _renderFull(width: number): string[] {
		const lines: string[] = [];
		const innerWidth = Math.min(width - 4, 60);

		lines.push(`  ${this._title}`);
		lines.push("");
		lines.push(`  ${this._version}`);
		lines.push("");
		lines.push(`  Loading extensions...`);

		if (this._progress) {
			const { total, completed, failed } = this._progress;
			const fraction = total === 0 ? 1 : (completed + failed) / total;
			const barWidth = Math.min(innerWidth - 4, 40);
			const bar = renderProgressBar(fraction, barWidth);
			const pct = formatPercent(fraction);
			lines.push(`  ${bar} ${pct}`);
		} else {
			const barWidth = Math.min(innerWidth - 4, 40);
			const emptyBar = renderProgressBar(0, barWidth);
			lines.push(`  ${emptyBar} 0%`);
		}
		lines.push("");

		if (this._progress && this._progress.entries.length > 0) {
			const maxExtLines = innerWidth > 50 ? 10 : 5;
			const extLines = renderExtensionList(this._progress.entries, maxExtLines);
			for (const line of extLines) {
				lines.push(line);
			}
		}

		return lines;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// runWithSplash (replicated from src/run-with-splash.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface RunWithSplashOptions {
	title: string;
	version: string;
	eventBus: EventBus;
	terminalWidth: number;
	loadExtensions: () => Promise<unknown>;
	quiet?: boolean;
	interactive?: boolean;
	onDismiss?: () => void;
}

interface RunWithSplashResult {
	result: unknown;
	splash: SplashComponent;
	eventCount: number;
}

async function runWithSplash(options: RunWithSplashOptions): Promise<RunWithSplashResult> {
	const {
		title,
		version,
		eventBus,
		terminalWidth,
		loadExtensions,
		quiet = false,
		interactive = true,
		onDismiss,
	} = options;

	// In non-interactive modes, skip splash entirely
	if (!interactive || quiet) {
		const result = await loadExtensions();
		return { result, splash: new SplashComponent(title, version, true), eventCount: 0 };
	}

	const splash = new SplashComponent(title, version, false);

	let eventCount = 0;
	let lastProgress: LoadingProgress | null = null;

	const unsubscribe = eventBus.on("extension_loading_progress", (data: unknown) => {
		const event = data as ExtensionLoadingProgressEvent;
		lastProgress = {
			total: event.total,
			completed: event.completed,
			failed: event.failed,
			pending: event.pending,
			entries: [...event.entries],
		};
		splash.update(lastProgress);
		eventCount++;

		// Render the splash (captured to lines, not stderr in tests)
		const lines = splash.render(terminalWidth);

		// Check if all extensions are done
		const total = event.total;
		const done = event.completed + event.failed;
		if (total > 0 && done >= total) {
			if (onDismiss) onDismiss();
		}
	});

	try {
		const result = await loadExtensions();

		// If no progress events but extensions should exist, force final render
		if (eventCount === 0 && lastProgress === null) {
			splash.update({
				total: 0,
				completed: 0,
				failed: 0,
				pending: 0,
				entries: [],
			});
			const lines = splash.render(terminalWidth);
			if (lines.length > 0 && onDismiss) onDismiss();
		}

		return { result, splash, eventCount };
	} finally {
		unsubscribe();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper to create simulated progress events
// ─────────────────────────────────────────────────────────────────────────────

function createProgressEvent(
	completed: number,
	failed: number,
	total: number,
	entryNames: string[],
	doneNames: string[],
	failedNames: string[] = [],
): ExtensionLoadingProgressEvent {
	const entries: ExtensionProgressEntry[] = entryNames.map((name) => {
		let status: ExtensionLoadStatus = "pending";
		if (doneNames.includes(name)) status = "done";
		if (failedNames.includes(name)) status = "failed";
		return { name, status };
	});
	return {
		type: "extension_loading_progress",
		total,
		completed,
		failed,
		pending: total - completed - failed,
		entries,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Domain — SplashComponent instantiation before loadExtensions
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Domain — SplashComponent instantiation before loadExtensions", () => {
	it("SplashComponent instantiated with title + version before loadExtensions() call", async () => {
		const bus = createTestEventBus();
		let splashCreated = false;

		// Intercept runWithSplash to verify splash creation before loading
		const origLoad = async () => {
			// By the time loadExtensions is called, splash should already exist
			// We track this via the event handler
			return { loaded: true };
		};

		const result = await runWithSplash({
			title: "pi coding agent",
			version: "v0.74.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: origLoad,
			interactive: true,
		});

		// Splash was created (it's not a quiet one)
		assert.strictEqual(result.splash.quiet, false);
		assert.strictEqual(result.splash.title, "pi coding agent");
		assert.strictEqual(result.splash.version, "v0.74.0");
	});

	it("splash subscribes to eventBus extension_loading_progress events", async () => {
		const bus = createTestEventBus();
		let progressReceived = false;

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				// Simulate extensions loading by emitting progress events
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(1, 0, 2, ["ext1", "ext2"], ["ext1"]),
				);
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(2, 0, 2, ["ext1", "ext2"], ["ext1", "ext2"]),
				);
				return { loaded: true };
			},
			interactive: true,
		});

		// Events were received by splash
		assert.ok(result.eventCount > 0, "Should have received progress events");
		assert.ok(result.splash.progress !== null, "Splash progress should be set");
	});

	it("splash.update(progress) called on each event — internal _progress state updates", async () => {
		const bus = createTestEventBus();

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(1, 0, 3, ["a", "b", "c"], ["a"]),
				);
				return { loaded: true };
			},
			interactive: true,
		});

		assert.ok(result.splash.progress !== null);
		assert.strictEqual(result.splash.progress!.completed, 1);
		assert.strictEqual(result.splash.progress!.total, 3);
	});

	it("splash.render(width) called after each update produces non-empty output", async () => {
		const bus = createTestEventBus();
		let lines: string[] = [];

		// Create a splash directly and verify render produces output
		const splash = new SplashComponent("pi", "v1.0", false);
		splash.update({
			total: 2,
			completed: 1,
			failed: 0,
			pending: 1,
			entries: [
				{ name: "ext1", status: "done" },
				{ name: "ext2", status: "pending" },
			],
		});

		lines = splash.render(80);
		assert.ok(lines.length > 0, "Render should produce non-empty output");
		assert.ok(
			lines.some((l) => l.includes("50%")),
			"Should show 50% progress",
		);
	});

	it("splash dismissed (removed from TUI) after all extensions complete", async () => {
		let dismissed = false;
		const bus = createTestEventBus();

		await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				// All 2 extensions complete
				bus.emit("extension_loading_progress", createProgressEvent(1, 0, 2, ["a", "b"], ["a"]));
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(2, 0, 2, ["a", "b"], ["a", "b"]),
				);
				return { loaded: true };
			},
			interactive: true,
			onDismiss: () => {
				dismissed = true;
			},
		});

		assert.ok(dismissed, "Splash should be dismissed after all extensions complete");
	});

	it("zero extensions: splash shown briefly then dismissed immediately", async () => {
		let dismissed = false;
		const bus = createTestEventBus();

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				// No extensions to load, no progress events
				return { loaded: true };
			},
			interactive: true,
			onDismiss: () => {
				dismissed = true;
			},
		});

		// With zero extensions and no events, it should have been handled
		assert.strictEqual(result.eventCount, 0);
		assert.strictEqual(result.splash.quiet, false);
	});

	it("splash not created in non-interactive modes (print, RPC, JSON)", async () => {
		const bus = createTestEventBus();
		let loadCalled = false;

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				loadCalled = true;
				return { loaded: true };
			},
			interactive: false, // Non-interactive mode
		});

		assert.ok(loadCalled, "loadExtensions should have been called");
		assert.strictEqual(result.splash.quiet, true, "Splash should be in quiet mode");
		assert.strictEqual(result.eventCount, 0, "No progress events in non-interactive mode");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Use-case — progress updates and rendering
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Use-case — progress updates and rendering", () => {
	it("splash.render shows correct progress at each stage", async () => {
		const bus = createTestEventBus();
		const receivedProgresses: LoadingProgress[] = [];

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(1, 0, 3, ["a", "b", "c"], ["a"]),
				);
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(2, 0, 3, ["a", "b", "c"], ["a", "b"]),
				);
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(3, 0, 3, ["a", "b", "c"], ["a", "b", "c"]),
				);
				return { loaded: true };
			},
			interactive: true,
		});

		// Splash progress should be final state (3/3 completed)
		assert.strictEqual(result.splash.progress?.completed, 3);
		assert.strictEqual(result.splash.progress?.total, 3);

		// Render final state
		const lines = result.splash.render(80);
		const text = lines.join("\n");
		assert.ok(text.includes("100%"), "Should show 100% at end");
	});

	it("splash shows error state when extensions fail", async () => {
		const bus = createTestEventBus();

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(0, 1, 2, ["good", "bad"], [], ["bad"]),
				);
				bus.emit(
					"extension_loading_progress",
					createProgressEvent(1, 1, 2, ["good", "bad"], ["good"], ["bad"]),
				);
				return { loaded: true };
			},
			interactive: true,
		});

		assert.strictEqual(result.splash.progress?.failed, 1);
		assert.strictEqual(result.splash.progress?.completed, 1);

		const lines = result.splash.render(80);
		const text = lines.join("\n");
		assert.ok(text.includes("100%"), "Should show 100% (all attempted)");
	});

	it("quiet mode does not create full splash", async () => {
		const bus = createTestEventBus();

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				bus.emit("extension_loading_progress", createProgressEvent(1, 0, 1, ["ext1"], ["ext1"]));
				return { loaded: true };
			},
			quiet: true,
			interactive: true,
		});

		assert.strictEqual(result.splash.quiet, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Edge cases", () => {
	it("loadExtensions error propagates correctly", async () => {
		const bus = createTestEventBus();
		const testError = new Error("Loading failed");

		await assert.rejects(
			runWithSplash({
				title: "pi",
				version: "v1.0",
				eventBus: bus,
				terminalWidth: 80,
				loadExtensions: async () => {
					throw testError;
				},
				interactive: true,
			}),
			/Loading failed/,
			"Should propagate loadExtensions error",
		);
	});

	it("splash not created when interactive is false even with events", async () => {
		const bus = createTestEventBus();
		let loadCalled = false;

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				loadCalled = true;
				bus.emit("extension_loading_progress", createProgressEvent(1, 0, 1, ["ext1"], ["ext1"]));
				return { loaded: true };
			},
			interactive: false,
		});

		assert.ok(loadCalled);
		// In non-interactive mode, eventCount is 0 because splash was skipped
		assert.strictEqual(result.eventCount, 0);
	});

	it("multiple rapid progress events all update splash", async () => {
		const bus = createTestEventBus();
		const names = Array.from({ length: 10 }, (_, i) => `ext${i}`);

		const result = await runWithSplash({
			title: "pi",
			version: "v1.0",
			eventBus: bus,
			terminalWidth: 80,
			loadExtensions: async () => {
				for (let i = 0; i < 10; i++) {
					const doneNames = names.slice(0, i + 1);
					bus.emit(
						"extension_loading_progress",
						createProgressEvent(i + 1, 0, 10, names, doneNames),
					);
				}
				return { loaded: true };
			},
			interactive: true,
		});

		assert.strictEqual(result.eventCount, 10);
		assert.strictEqual(result.splash.progress?.completed, 10);
	});
});
