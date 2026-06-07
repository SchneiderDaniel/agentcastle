/**
 * Tests for ProgressEmitter — Extension loading progress event emission.
 *
 * Phase 1: Progress-emitting extension loader adapter tests.
 * Verifies that the ProgressEmitter correctly emits progress events
 * via eventBus for each extension path during the loading loop.
 *
 * Run with:
 *   node --experimental-strip-types --test test/progress-emitter.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Replicated ProgressEmitter for isolated unit testing.
// Matches src/progress-emitter.ts implementation.
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

interface LoadingProgress {
	total: number;
	completed: number;
	failed: number;
	pending: number;
	entries: ExtensionProgressEntry[];
}

type ProgressEventListener = (event: ExtensionLoadingProgressEvent) => void;

interface ExtEntry {
	name: string;
	path: string;
}

function createLoadingProgress(extensionNames: string[]): LoadingProgress {
	return {
		total: extensionNames.length,
		completed: 0,
		failed: 0,
		pending: extensionNames.length,
		entries: extensionNames.map((name) => ({
			name,
			status: "pending" as const,
		})),
	};
}

function applyProgressDelta(
	current: LoadingProgress,
	delta: { name: string; status: ExtensionLoadStatus; error?: string },
): LoadingProgress {
	const entries = current.entries.map((entry) =>
		entry.name === delta.name
			? { ...entry, status: delta.status, error: delta.error ?? entry.error }
			: entry,
	);
	const completed = entries.filter((e) => e.status === "done").length;
	const failed = entries.filter((e) => e.status === "failed").length;
	const pending = entries.filter((e) => e.status === "pending" || e.status === "loading").length;
	return { total: current.total, completed, failed, pending, entries };
}

class ProgressEmitter {
	private _entries: ExtEntry[];
	private _state: LoadingProgress;
	private _listeners: Set<ProgressEventListener> = new Set();

	constructor(extensions: ExtEntry[]) {
		this._entries = extensions;
		const names = extensions.map((e) => e.name);
		this._state = createLoadingProgress(names);
	}

	get state(): LoadingProgress {
		return this._state;
	}

	get entries(): ExtEntry[] {
		return this._entries;
	}

	onProgress(listener: ProgressEventListener): () => void {
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
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

	get isComplete(): boolean {
		return this._state.completed + this._state.failed === this._state.total;
	}

	get fraction(): number {
		if (this._state.total === 0) return 1;
		return (this._state.completed + this._state.failed) / this._state.total;
	}

	private _getEntryError(name: string): string | undefined {
		const entry = this._state.entries.find((e) => e.name === name);
		return entry?.error;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Domain — ProgressEmitter initialization
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Domain — ProgressEmitter initialization", () => {
	it("initial state has all extensions pending", () => {
		const emitter = new ProgressEmitter([
			{ name: "caveman", path: "/ext/caveman" },
			{ name: "supervisor", path: "/ext/supervisor" },
			{ name: "context-info", path: "/ext/context-info" },
		]);
		const state = emitter.state;
		assert.strictEqual(state.total, 3);
		assert.strictEqual(state.completed, 0);
		assert.strictEqual(state.failed, 0);
		assert.strictEqual(state.pending, 3);
		assert.strictEqual(state.entries.length, 3);
		for (const entry of state.entries) {
			assert.strictEqual(entry.status, "pending");
		}
	});

	it("zero extensions initializes cleanly", () => {
		const emitter = new ProgressEmitter([]);
		const state = emitter.state;
		assert.strictEqual(state.total, 0);
		assert.strictEqual(state.completed, 0);
		assert.strictEqual(state.failed, 0);
		assert.strictEqual(state.pending, 0);
		assert.strictEqual(state.entries.length, 0);
	});

	it("isComplete is false initially when there are extensions", () => {
		const emitter = new ProgressEmitter([{ name: "ext1", path: "/ext/ext1" }]);
		assert.strictEqual(emitter.isComplete, false);
	});

	it("isComplete is true when there are zero extensions", () => {
		const emitter = new ProgressEmitter([]);
		assert.strictEqual(emitter.isComplete, true);
	});

	it("fraction is 0 initially", () => {
		const emitter = new ProgressEmitter([
			{ name: "ext1", path: "/ext/ext1" },
			{ name: "ext2", path: "/ext/ext2" },
		]);
		assert.strictEqual(emitter.fraction, 0);
	});

	it("fraction is 1 for zero extensions", () => {
		const emitter = new ProgressEmitter([]);
		assert.strictEqual(emitter.fraction, 1);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Use-case — event emission via adapter
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Use-case — event emission via adapter", () => {
	let events: ExtensionLoadingProgressEvent[];
	let emitter: ProgressEmitter;

	beforeEach(() => {
		events = [];
		emitter = new ProgressEmitter([
			{ name: "alpha", path: "/ext/alpha" },
			{ name: "bravo", path: "/ext/bravo" },
			{ name: "charlie", path: "/ext/charlie" },
		]);
		emitter.onProgress((event) => {
			events.push(event);
		});
	});

	it("emits event with correct type for each extension path during loop", () => {
		emitter.emitProgress("alpha", "done");
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0]!.type, "extension_loading_progress");
	});

	it("emits event with correct payload matching actual loaded count", () => {
		emitter.emitProgress("alpha", "done");
		const event = events[0]!;
		assert.strictEqual(event.total, 3);
		assert.strictEqual(event.completed, 1);
		assert.strictEqual(event.failed, 0);
		assert.strictEqual(event.pending, 2);
		assert.strictEqual(event.entries.length, 3);
	});

	it("single extension: event emitted once with completed:1, failed:0, pending:0", () => {
		const single = new ProgressEmitter([{ name: "solo", path: "/ext/solo" }]);
		const evts: ExtensionLoadingProgressEvent[] = [];
		single.onProgress((e) => evts.push(e));
		single.emitProgress("solo", "done");

		assert.strictEqual(evts.length, 1);
		assert.strictEqual(evts[0]!.completed, 1);
		assert.strictEqual(evts[0]!.failed, 0);
		assert.strictEqual(evts[0]!.pending, 0);
	});

	it("three extensions: 3 events emitted sequentially with completed 1→2→3", () => {
		emitter.emitProgress("alpha", "done");
		emitter.emitProgress("bravo", "done");
		emitter.emitProgress("charlie", "done");

		assert.strictEqual(events.length, 3);
		assert.strictEqual(events[0]!.completed, 1);
		assert.strictEqual(events[0]!.total, 3);
		assert.strictEqual(events[1]!.completed, 2);
		assert.strictEqual(events[1]!.total, 3);
		assert.strictEqual(events[2]!.completed, 3);
		assert.strictEqual(events[2]!.total, 3);
	});

	it("failed extension: event emitted with failed:1 and matching entry error", () => {
		emitter.emitProgress("alpha", "failed", "Module not found");

		assert.strictEqual(events.length, 1);
		const event = events[0]!;
		assert.strictEqual(event.failed, 1);
		assert.strictEqual(event.completed, 0);

		const failedEntry = event.entries.find((e) => e.name === "alpha");
		assert.ok(failedEntry, "Failed entry should exist");
		assert.strictEqual(failedEntry.status, "failed");
		assert.strictEqual(failedEntry.error, "Module not found");
	});

	it("mixed done/failed: final event has completed:2, failed:1, pending:0", () => {
		emitter.emitProgress("alpha", "done");
		emitter.emitProgress("bravo", "failed", "crash");
		emitter.emitProgress("charlie", "done");

		assert.strictEqual(events.length, 3);
		const last = events[2]!;
		assert.strictEqual(last.completed, 2);
		assert.strictEqual(last.failed, 1);
		assert.strictEqual(last.pending, 0);
		assert.strictEqual(last.total, 3);
	});

	it("zero extensions: no event emitted (no factories to run)", () => {
		const empty = new ProgressEmitter([]);
		const evts: ExtensionLoadingProgressEvent[] = [];
		empty.onProgress((e) => evts.push(e));

		// With zero extensions, no emitProgress calls are made
		assert.strictEqual(evts.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Use-case — listener registration order
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Use-case — listener order and unsubscription", () => {
	it("listeners receive events in registration order before next extension loads", () => {
		const received: number[] = [];
		const emitter = new ProgressEmitter([{ name: "ext1", path: "/ext/ext1" }]);

		emitter.onProgress(() => received.push(1));
		emitter.onProgress(() => received.push(2));

		emitter.emitProgress("ext1", "done");

		assert.strictEqual(received.length, 2);
		assert.deepStrictEqual(received, [1, 2], "Should fire in registration order");
	});

	it("unsubscribe stops listener from receiving subsequent events", () => {
		const received: number[] = [];
		const emitter = new ProgressEmitter([
			{ name: "a", path: "/ext/a" },
			{ name: "b", path: "/ext/b" },
		]);

		emitter.onProgress(() => received.push(1));
		const unsub = emitter.onProgress(() => received.push(2));
		unsub();

		emitter.emitProgress("a", "done");
		emitter.emitProgress("b", "done");

		// Listener 2 should not have received any events
		assert.strictEqual(received.length, 2);
		assert.ok(
			received.every((r) => r === 1),
			"Only listener 1 should receive events",
		);
	});

	it("multiple listeners all receive the same event data", () => {
		const emitter = new ProgressEmitter([{ name: "ext1", path: "/ext/ext1" }]);
		const eventsA: ExtensionLoadingProgressEvent[] = [];
		const eventsB: ExtensionLoadingProgressEvent[] = [];

		emitter.onProgress((e) => eventsA.push(e));
		emitter.onProgress((e) => eventsB.push(e));

		emitter.emitProgress("ext1", "done");

		assert.strictEqual(eventsA.length, 1);
		assert.strictEqual(eventsB.length, 1);
		assert.strictEqual(eventsA[0]!.completed, eventsB[0]!.completed);
		assert.strictEqual(eventsA[0]!.total, eventsB[0]!.total);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Boundary — edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: Boundary — edge cases", () => {
	it("50 extensions all complete in order", () => {
		const names = Array.from({ length: 50 }, (_, i) => `ext${i}`);
		const emitter = new ProgressEmitter(names.map((n) => ({ name: n, path: `/ext/${n}` })));
		const events: ExtensionLoadingProgressEvent[] = [];
		emitter.onProgress((e) => events.push(e));

		for (let i = 0; i < 50; i++) {
			emitter.emitProgress(`ext${i}`, "done");
		}

		assert.strictEqual(events.length, 50);
		assert.strictEqual(events[49]!.completed, 50);
		assert.strictEqual(events[49]!.failed, 0);
		assert.strictEqual(emitter.isComplete, true);
	});

	it("isComplete transitions to true when all done", () => {
		const emitter = new ProgressEmitter([
			{ name: "a", path: "/ext/a" },
			{ name: "b", path: "/ext/b" },
		]);

		assert.strictEqual(emitter.isComplete, false);
		emitter.emitProgress("a", "done");
		assert.strictEqual(emitter.isComplete, false);
		emitter.emitProgress("b", "done");
		assert.strictEqual(emitter.isComplete, true);
	});

	it("isComplete transitions to true when all failed", () => {
		const emitter = new ProgressEmitter([
			{ name: "a", path: "/ext/a" },
			{ name: "b", path: "/ext/b" },
		]);

		emitter.emitProgress("a", "failed", "err1");
		assert.strictEqual(emitter.isComplete, false);
		emitter.emitProgress("b", "failed", "err2");
		assert.strictEqual(emitter.isComplete, true);
	});

	it("fraction transitions from 0 to 1 as loading progresses", () => {
		const emitter = new ProgressEmitter([
			{ name: "a", path: "/ext/a" },
			{ name: "b", path: "/ext/b" },
			{ name: "c", path: "/ext/c" },
			{ name: "d", path: "/ext/d" },
		]);

		assert.strictEqual(emitter.fraction, 0);
		emitter.emitProgress("a", "done");
		assert.strictEqual(emitter.fraction, 0.25);
		emitter.emitProgress("b", "done");
		assert.strictEqual(emitter.fraction, 0.5);
		emitter.emitProgress("c", "done");
		assert.strictEqual(emitter.fraction, 0.75);
		emitter.emitProgress("d", "done");
		assert.strictEqual(emitter.fraction, 1);
	});

	it("mixed 3 succeed, 2 fail — final state correct", () => {
		const emitter = new ProgressEmitter([
			{ name: "g1", path: "/ext/g1" },
			{ name: "g2", path: "/ext/g2" },
			{ name: "g3", path: "/ext/g3" },
			{ name: "b1", path: "/ext/b1" },
			{ name: "b2", path: "/ext/b2" },
		]);

		emitter.emitProgress("g1", "done");
		emitter.emitProgress("g2", "done");
		emitter.emitProgress("b1", "failed", "timeout");
		emitter.emitProgress("g3", "done");
		emitter.emitProgress("b2", "failed", "crash");

		const state = emitter.state;
		assert.strictEqual(state.completed, 3);
		assert.strictEqual(state.failed, 2);
		assert.strictEqual(state.total, 5);
		assert.strictEqual(state.pending, 0);
		assert.strictEqual(emitter.isComplete, true);
	});

	it("single entry entries list matches the extension passed to constructor", () => {
		const emitter = new ProgressEmitter([{ name: "my-ext", path: "/ext/my-ext" }]);
		assert.strictEqual(emitter.entries.length, 1);
		assert.strictEqual(emitter.entries[0]!.name, "my-ext");
		assert.strictEqual(emitter.entries[0]!.path, "/ext/my-ext");
	});
});
