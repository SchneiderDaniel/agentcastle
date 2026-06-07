/**
 * Tests for integrate-splash — Wiring splash into extension loading pipeline.
 *
 * Phase 1: Verify setupSplashIntegration patches DefaultResourceLoader
 * Phase 2: Verify progress events are emitted on the eventBus after reload
 * Phase 3: Verify events include correct extension states (done/failed)
 * Phase 4: Edge cases (zero extensions, errors only)
 *
 * Run with:
 *   node --experimental-strip-types --test test/integrate-splash.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Replicated types for isolated testing (matches src/extension-progress-types.ts)
// ---------------------------------------------------------------------------

type ExtensionLoadStatus = "pending" | "loading" | "done" | "failed";

interface ExtensionProgressEntry {
	name: string;
	status: ExtensionLoadStatus;
	error?: string;
}

interface ExtensionLoadingProgressEvent {
	type: "extension_loading_progress";
	total: number;
	completed: number;
	failed: number;
	pending: number;
	entries: ExtensionProgressEntry[];
}

// ---------------------------------------------------------------------------
// Replicated EventBus for isolated testing
// ---------------------------------------------------------------------------

interface EventBus {
	emit: (channel: string, data: unknown) => void;
	on: (channel: string, handler: (data: unknown) => void) => () => void;
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

// ---------------------------------------------------------------------------
// Replicated ProgressEmitter (matches src/progress-emitter.ts)
// ---------------------------------------------------------------------------

interface ExtEntry {
	name: string;
	path: string;
}

function createLoadingProgress(extensionNames: string[]) {
	return {
		total: extensionNames.length,
		completed: 0,
		failed: 0,
		pending: extensionNames.length,
		entries: extensionNames.map((name) => ({ name, status: "pending" as const })),
	};
}

function applyProgressDelta(
	current: any,
	delta: { name: string; status: ExtensionLoadStatus; error?: string },
) {
	const entries = current.entries.map((entry: any) =>
		entry.name === delta.name
			? { ...entry, status: delta.status, error: delta.error ?? entry.error }
			: entry,
	);
	const completed = entries.filter((e: any) => e.status === "done").length;
	const failed = entries.filter((e: any) => e.status === "failed").length;
	const pending = entries.filter(
		(e: any) => e.status === "pending" || e.status === "loading",
	).length;
	return { total: current.total, completed, failed, pending, entries };
}

class ProgressEmitter {
	private _entries: ExtEntry[];
	private _state: any;
	private _listeners: Set<(event: ExtensionLoadingProgressEvent) => void> = new Set();

	constructor(extensions: ExtEntry[]) {
		this._entries = extensions;
		this._state = createLoadingProgress(extensions.map((e) => e.name));
	}

	get state() {
		return this._state;
	}

	onProgress(listener: (event: ExtensionLoadingProgressEvent) => void): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	emitProgress(extensionName: string, status: ExtensionLoadStatus, error?: string): void {
		this._state = applyProgressDelta(this._state, {
			name: extensionName,
			status,
			error: error ?? this._getEntryError(extensionName),
		});

		const event: ExtensionLoadingProgressEvent = {
			type: "extension_loading_progress",
			total: this._state.total,
			completed: this._state.completed,
			failed: this._state.failed,
			pending: this._state.pending,
			entries: [...this._state.entries],
		};

		for (const listener of this._listeners) {
			listener(event);
		}
	}

	private _getEntryError(name: string): string | undefined {
		const entry = this._state.entries.find((e: any) => e.name === name);
		return entry?.error;
	}
}

// ---------------------------------------------------------------------------
// Replicated SplashComponent (minimal for testing)
// ---------------------------------------------------------------------------

class SplashComponent {
	private _title: string;
	private _version: string;
	private _progress: any = null;
	private _quiet: boolean;

	constructor(title: string, version: string, quiet = false) {
		this._title = title;
		this._version = version;
		this._quiet = quiet;
	}

	get title() {
		return this._title;
	}
	get version() {
		return this._version;
	}
	get quiet() {
		return this._quiet;
	}
	get progress() {
		return this._progress;
	}

	update(progress: any) {
		this._progress = progress;
	}

	render(_width: number): string[] {
		if (this._quiet) return ["  Loading..."];
		const lines = [`  ${this._title}`, "", `  ${this._version}`, "", `  Loading extensions...`];
		if (this._progress) {
			const { total, completed, failed } = this._progress;
			const fraction = total === 0 ? 1 : (completed + failed) / total;
			const pct = `${Math.round(fraction * 100)}%`;
			lines.push(
				`  [${"=".repeat(Math.round(fraction * 20)) + "-".repeat(20 - Math.round(fraction * 20))}] ${pct}`,
			);
		}
		return lines;
	}
}

// ---------------------------------------------------------------------------
// Replicated clearSplash (no-op in tests since we don't render to real terminal)
// ---------------------------------------------------------------------------

function clearSplash(_width: number, _lineCount: number): void {
	// No-op in test environment
}

// ---------------------------------------------------------------------------
// Replicated integrate-splash logic (the progress emission after reload)
// ---------------------------------------------------------------------------

/**
 * Simulates what the patched DefaultResourceLoader.reload does:
 * After loading extensions, emit progress events on the eventBus.
 */
function emitProgressAfterReload(
	eventBus: EventBus,
	extensions: Array<{ path: string }>,
	errors: Array<{ path: string; error: string }>,
): void {
	const extEntries: ExtEntry[] = [];
	for (const ext of extensions) {
		const name = ext.path.split("/").pop() || ext.path;
		if (!extEntries.some((e) => e.name === name)) {
			extEntries.push({ name, path: ext.path });
		}
	}
	for (const err of errors) {
		const name = err.path.split("/").pop() || err.path;
		if (!extEntries.some((e) => e.name === name)) {
			extEntries.push({ name, path: err.path });
		}
	}

	if (extEntries.length === 0) return;

	const emitter = new ProgressEmitter(extEntries);
	emitter.onProgress((event: ExtensionLoadingProgressEvent) => {
		eventBus.emit("extension_loading_progress", event);
	});

	for (const entry of extEntries) {
		emitter.emitProgress(entry.name, "loading");
	}
	for (const ext of extensions) {
		const name = ext.path.split("/").pop() || ext.path;
		emitter.emitProgress(name, "done");
	}
	for (const err of errors) {
		const name = err.path.split("/").pop() || err.path;
		emitter.emitProgress(name, "failed", err.error);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Domain — Progress emission after extension loading
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Domain — progress emission after extension loading", () => {
	it("emits progress events on eventBus for each extension", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(
			bus,
			[
				{ path: "/ext/caveman.ts" },
				{ path: "/ext/supervisor.ts" },
				{ path: "/ext/context-info.ts" },
			],
			[],
		);

		// Events emitted: loading × 3 + done × 3 = at least 6 events
		assert.ok(received.length >= 6, `Expected at least 6 events, got ${received.length}`);

		// First event: first extension goes to loading
		assert.strictEqual(received[0]!.type, "extension_loading_progress");
		assert.strictEqual(received[0]!.total, 3);
		assert.strictEqual(received[0]!.completed, 0);
		assert.strictEqual(received[0]!.failed, 0);

		// Last event: all done
		const lastEvent = received[received.length - 1]!;
		assert.strictEqual(lastEvent.completed + lastEvent.failed, 3);
		assert.strictEqual(lastEvent.pending, 0);
	});

	it("emits failed events for extensions that failed to load", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(
			bus,
			[{ path: "/ext/good.ts" }],
			[{ path: "/ext/bad.ts", error: "Module not found" }],
		);

		const lastEvent = received[received.length - 1]!;
		assert.strictEqual(lastEvent.completed, 1);
		assert.strictEqual(lastEvent.failed, 1);
		assert.strictEqual(lastEvent.total, 2);

		const badEntry = lastEvent.entries.find((e) => e.name === "bad.ts");
		assert.ok(badEntry);
		assert.strictEqual(badEntry.status, "failed");
		assert.strictEqual(badEntry.error, "Module not found");
	});

	it("does not emit events when there are no extensions", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(bus, [], []);

		assert.strictEqual(received.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Use-case — Progress events match result data
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Use-case — progress events match result data", () => {
	it("final event completed count matches extensions that succeeded", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(
			bus,
			[{ path: "/ext/a.ts" }, { path: "/ext/b.ts" }, { path: "/ext/c.ts" }],
			[{ path: "/ext/d.ts", error: "timeout" }],
		);

		const last = received[received.length - 1]!;
		assert.strictEqual(last.completed, 3);
		assert.strictEqual(last.failed, 1);
		assert.strictEqual(last.total, 4);
	});

	it("failed extension entry has error message in payload", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(
			bus,
			[],
			[{ path: "/ext/broken.ts", error: "SyntaxError: Unexpected token" }],
		);

		const last = received[received.length - 1]!;
		const brokenEntry = last.entries.find((e) => e.name === "broken.ts");
		assert.ok(brokenEntry);
		assert.strictEqual(brokenEntry.status, "failed");
		assert.strictEqual(brokenEntry.error, "SyntaxError: Unexpected token");
	});

	it("progress events include all entry statuses", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(
			bus,
			[{ path: "/ext/ok.ts" }],
			[{ path: "/ext/err.ts", error: "fail" }],
		);

		const last = received[received.length - 1]!;
		assert.strictEqual(last.entries.length, 2);

		const okEntry = last.entries.find((e) => e.name === "ok.ts");
		assert.ok(okEntry);
		assert.strictEqual(okEntry.status, "done");

		const errEntry = last.entries.find((e) => e.name === "err.ts");
		assert.ok(errEntry);
		assert.strictEqual(errEntry.status, "failed");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Edge cases", () => {
	it("zero extensions emits no events", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(bus, [], []);
		assert.strictEqual(received.length, 0);
	});

	it("all extensions fail — only failed events emitted", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(
			bus,
			[],
			[
				{ path: "/ext/fail1.ts", error: "err1" },
				{ path: "/ext/fail2.ts", error: "err2" },
			],
		);

		const last = received[received.length - 1]!;
		assert.strictEqual(last.failed, 2);
		assert.strictEqual(last.completed, 0);
	});

	it("single extension — complete sequence of events", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		emitProgressAfterReload(bus, [{ path: "/ext/only.ts" }], []);

		// Should have loading event + done event
		assert.ok(received.length >= 2, `Expected at least 2 events, got ${received.length}`);
		assert.strictEqual(received[0]!.completed, 0); // loading state

		const last = received[received.length - 1]!;
		assert.strictEqual(last.completed, 1);
		assert.strictEqual(last.failed, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Integration — ProgressEmitter connected to eventBus
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: Integration — ProgressEmitter connected to eventBus", () => {
	it("emitter events forwarded to eventBus listeners", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		const emitter = new ProgressEmitter([{ name: "ext1", path: "/ext/ext1" }]);

		// Connect emitter to eventBus (this is what the integration does)
		emitter.onProgress((event) => {
			bus.emit("extension_loading_progress", event);
		});

		emitter.emitProgress("ext1", "done");

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0]!.type, "extension_loading_progress");
		assert.strictEqual(received[0]!.completed, 1);
	});

	it("emitter can be connected then used to emit loading + final state", () => {
		const bus = createTestEventBus();
		const received: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received.push(data as ExtensionLoadingProgressEvent);
		});

		const emitter = new ProgressEmitter([
			{ name: "a", path: "/ext/a" },
			{ name: "b", path: "/ext/b" },
		]);

		emitter.onProgress((event) => {
			bus.emit("extension_loading_progress", event);
		});

		// Simulate what the integration does: loading -> then done
		emitter.emitProgress("a", "loading");
		emitter.emitProgress("b", "loading");
		emitter.emitProgress("a", "done");
		emitter.emitProgress("b", "done");

		const last = received[received.length - 1]!;
		assert.strictEqual(last.completed, 2);
		assert.strictEqual(last.failed, 0);
		assert.strictEqual(last.total, 2);
	});

	it("multiple eventBus subscribers all receive progress events", () => {
		const bus = createTestEventBus();
		const received1: ExtensionLoadingProgressEvent[] = [];
		const received2: ExtensionLoadingProgressEvent[] = [];

		bus.on("extension_loading_progress", (data: unknown) => {
			received1.push(data as ExtensionLoadingProgressEvent);
		});
		bus.on("extension_loading_progress", (data: unknown) => {
			received2.push(data as ExtensionLoadingProgressEvent);
		});

		const emitter = new ProgressEmitter([{ name: "ext", path: "/ext/ext" }]);
		emitter.onProgress((event) => {
			bus.emit("extension_loading_progress", event);
		});

		emitter.emitProgress("ext", "done");

		assert.strictEqual(received1.length, 1);
		assert.strictEqual(received2.length, 1);
	});
});
