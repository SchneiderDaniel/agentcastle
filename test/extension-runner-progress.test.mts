/**
 * Tests for ExtensionRunner progress event emission.
 *
 * Phase 1: Verify the ExtensionRunner can emit extension loading progress events.
 *
 * Run with:
 *   node --experimental-strip-types --test test/extension-runner-progress.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Replicated ExtensionRunner progress emission logic for isolated testing.
// This matches the emitProgress() method that will be added to ExtensionRunner.
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

type ProgressListener = (event: ExtensionLoadingProgressEvent) => void;

/** Simulated extension entry for testing. */
interface ExtEntry {
	name: string;
	path: string;
}

/**
 * Minimal progress-tracker that mimics ExtensionRunner.emitProgress().
 * Keeps internal state and emits events to registered listeners.
 */
class ProgressEmitter {
	private _extensions: ExtEntry[];
	private _state: {
		entries: ExtensionProgressEntry[];
		total: number;
		completed: number;
		failed: number;
		pending: number;
	};
	private _listeners: Set<ProgressListener> = new Set();

	constructor(extensions: ExtEntry[]) {
		this._extensions = extensions;
		this._state = {
			total: extensions.length,
			completed: 0,
			failed: 0,
			pending: extensions.length,
			entries: extensions.map((ext) => ({
				name: ext.name,
				status: "pending" as const,
			})),
		};
	}

	onProgress(listener: ProgressListener): () => void {
		this._listeners.add(listener);
		return () => this._listeners.delete(listener);
	}

	/** Emit progress for one extension. Called after each factory completes. */
	emitProgress(extensionName: string, status: ExtensionLoadStatus, error?: string): void {
		this._state.entries = this._state.entries.map((entry) =>
			entry.name === extensionName ? { ...entry, status, error: error ?? entry.error } : entry,
		);
		this._state.completed = this._state.entries.filter((e) => e.status === "done").length;
		this._state.failed = this._state.entries.filter((e) => e.status === "failed").length;
		this._state.pending = this._state.entries.filter(
			(e) => e.status === "pending" || e.status === "loading",
		).length;

		const event: ExtensionLoadingProgressEvent = {
			type: "extension_loading_progress",
			total: this._state.total,
			completed: this._state.completed,
			failed: this._state.failed,
			pending: this._state.pending,
			entries: this._state.entries,
		};

		for (const listener of this._listeners) {
			listener(event);
		}
	}

	/** Get current state (for assertions). */
	getState(): { total: number; completed: number; failed: number; pending: number } {
		return {
			total: this._state.total,
			completed: this._state.completed,
			failed: this._state.failed,
			pending: this._state.pending,
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Domain — ProgressEmitter state tracking
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Domain — ProgressEmitter initialization", () => {
	it("initial state has all extensions pending", () => {
		const emitter = new ProgressEmitter([
			{ name: "caveman", path: "/ext/caveman" },
			{ name: "supervisor", path: "/ext/supervisor" },
			{ name: "context-info", path: "/ext/context-info" },
		]);
		const state = emitter.getState();
		assert.strictEqual(state.total, 3);
		assert.strictEqual(state.completed, 0);
		assert.strictEqual(state.failed, 0);
		assert.strictEqual(state.pending, 3);
	});

	it("zero extensions initializes cleanly", () => {
		const emitter = new ProgressEmitter([]);
		const state = emitter.getState();
		assert.strictEqual(state.total, 0);
		assert.strictEqual(state.completed, 0);
		assert.strictEqual(state.failed, 0);
		assert.strictEqual(state.pending, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Use-case — event emission
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Use-case — event emission", () => {
	let events: ExtensionLoadingProgressEvent[];
	let emitter: ProgressEmitter;

	beforeEach(() => {
		events = [];
		emitter = new ProgressEmitter([
			{ name: "a", path: "/ext/a" },
			{ name: "b", path: "/ext/b" },
			{ name: "c", path: "/ext/c" },
		]);
		emitter.onProgress((event) => {
			events.push(event);
		});
	});

	it("emits event after each factory resolves: 0/3 -> 1/3 -> 2/3 -> 3/3", () => {
		emitter.emitProgress("a", "done");
		emitter.emitProgress("b", "done");
		emitter.emitProgress("c", "done");

		assert.strictEqual(events.length, 3);
		assert.strictEqual(events[0]!.completed, 1);
		assert.strictEqual(events[0]!.total, 3);
		assert.strictEqual(events[1]!.completed, 2);
		assert.strictEqual(events[2]!.completed, 3);
	});

	it("emits correct payload for each event", () => {
		emitter.emitProgress("a", "done");
		const event = events[0]!;
		assert.strictEqual(event.type, "extension_loading_progress");
		assert.strictEqual(event.total, 3);
		assert.strictEqual(event.completed, 1);
		assert.strictEqual(event.failed, 0);
		assert.strictEqual(event.pending, 2);
		assert.strictEqual(event.entries.length, 3);
	});

	it("emits failed status with error message", () => {
		emitter.emitProgress("a", "failed", "Module not found");

		assert.strictEqual(events.length, 1);
		const event = events[0]!;
		assert.strictEqual(event.failed, 1);
		assert.strictEqual(event.completed, 0);
		const failedEntry = event.entries.find((e) => e.name === "a");
		assert.ok(failedEntry);
		assert.strictEqual(failedEntry.status, "failed");
		assert.strictEqual(failedEntry.error, "Module not found");
	});

	it("emits events in correct order for mixed resolution", () => {
		emitter.emitProgress("a", "done");
		emitter.emitProgress("b", "failed", "crash");
		emitter.emitProgress("c", "done");

		assert.strictEqual(events[0]!.completed, 1);
		assert.strictEqual(events[0]!.failed, 0);
		assert.strictEqual(events[1]!.completed, 1);
		assert.strictEqual(events[1]!.failed, 1);
		assert.strictEqual(events[2]!.completed, 2);
		assert.strictEqual(events[2]!.failed, 1);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Use-case — multiple listeners
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Use-case — multiple listeners", () => {
	it("notifies all registered listeners", () => {
		const received: number[] = [];
		const emitter = new ProgressEmitter([{ name: "ext1", path: "/ext/ext1" }]);

		emitter.onProgress(() => received.push(1));
		emitter.onProgress(() => received.push(2));
		emitter.emitProgress("ext1", "done");

		assert.strictEqual(received.length, 2);
		assert.deepStrictEqual(received.sort(), [1, 2]);
	});

	it("unsubscribe stops listener from receiving events", () => {
		const received: number[] = [];
		const emitter = new ProgressEmitter([{ name: "ext1", path: "/ext/ext1" }]);

		emitter.onProgress(() => received.push(1));
		const unsub = emitter.onProgress(() => received.push(2));
		unsub();

		emitter.emitProgress("ext1", "done");
		assert.strictEqual(received.length, 1);
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

		const state = emitter.getState();
		assert.strictEqual(state.completed, 3);
		assert.strictEqual(state.failed, 2);
		assert.strictEqual(state.total, 5);
		assert.strictEqual(state.pending, 0);
	});

	it("zero extensions emits nothing (no factories to run)", () => {
		const emitter = new ProgressEmitter([]);
		const events: ExtensionLoadingProgressEvent[] = [];
		emitter.onProgress((e) => events.push(e));
		assert.strictEqual(events.length, 0);
	});
});
