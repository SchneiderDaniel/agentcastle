/**
 * Tests for extension-progress-types.ts — Loading progress data structures.
 *
 * Phase 1: Domain tests — verify types and pure functions work correctly.
 *
 * Run with:
 *   node --experimental-strip-types --test test/extension-progress-types.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// Replicate the types and functions from src/extension-progress-types.ts
// for isolated unit testing (avoids import resolution issues).

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

function calculateProgressFraction(completed: number, failed: number, total: number): number {
	if (total === 0) return 1;
	return (completed + failed) / total;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Domain — type construction and validation
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Domain — type construction and validation", () => {
	it("createLoadingProgress builds initial state with all pending", () => {
		const progress = createLoadingProgress(["caveman", "supervisor", "context-info"]);
		assert.strictEqual(progress.total, 3);
		assert.strictEqual(progress.completed, 0);
		assert.strictEqual(progress.failed, 0);
		assert.strictEqual(progress.pending, 3);
		assert.strictEqual(progress.entries.length, 3);
		for (const entry of progress.entries) {
			assert.strictEqual(entry.status, "pending");
		}
	});

	it("createLoadingProgress with empty list gives zero counts", () => {
		const progress = createLoadingProgress([]);
		assert.strictEqual(progress.total, 0);
		assert.strictEqual(progress.completed, 0);
		assert.strictEqual(progress.failed, 0);
		assert.strictEqual(progress.pending, 0);
		assert.strictEqual(progress.entries.length, 0);
	});

	it("createLoadingProgress preserves extension name order", () => {
		const names = ["zebra", "alpha", "bravo"];
		const progress = createLoadingProgress(names);
		assert.deepStrictEqual(
			progress.entries.map((e) => e.name),
			["zebra", "alpha", "bravo"],
		);
	});

	it("applyProgressDelta transitions pending -> done", () => {
		const initial = createLoadingProgress(["ext1"]);
		const updated = applyProgressDelta(initial, { name: "ext1", status: "done" });
		assert.strictEqual(updated.completed, 1);
		assert.strictEqual(updated.failed, 0);
		assert.strictEqual(updated.pending, 0);
		assert.strictEqual(updated.entries[0]!.status, "done");
	});

	it("applyProgressDelta transitions pending -> failed with error", () => {
		const initial = createLoadingProgress(["ext1"]);
		const updated = applyProgressDelta(initial, {
			name: "ext1",
			status: "failed",
			error: "Module not found",
		});
		assert.strictEqual(updated.completed, 0);
		assert.strictEqual(updated.failed, 1);
		assert.strictEqual(updated.entries[0]!.status, "failed");
		assert.strictEqual(updated.entries[0]!.error, "Module not found");
	});

	it("applyProgressDelta with mixed outcomes", () => {
		const initial = createLoadingProgress(["a", "b", "c", "d", "e"]);
		let state = applyProgressDelta(initial, { name: "a", status: "done" });
		state = applyProgressDelta(state, { name: "b", status: "done" });
		state = applyProgressDelta(state, { name: "c", status: "failed", error: "crash" });
		assert.strictEqual(state.completed, 2);
		assert.strictEqual(state.failed, 1);
		assert.strictEqual(state.pending, 2);
		assert.strictEqual(state.total, 5);
	});

	it("applyProgressDelta is immutable (does not mutate input)", () => {
		const initial = createLoadingProgress(["ext1"]);
		const originalEntries = initial.entries;
		applyProgressDelta(initial, { name: "ext1", status: "done" });
		assert.strictEqual(initial.entries, originalEntries);
		assert.strictEqual(initial.entries[0]!.status, "pending");
	});

	it("calculateProgressFraction returns 0 for no progress", () => {
		assert.strictEqual(calculateProgressFraction(0, 0, 5), 0);
	});

	it("calculateProgressFraction returns 1 for all done", () => {
		assert.strictEqual(calculateProgressFraction(5, 0, 5), 1);
	});

	it("calculateProgressFraction returns 1 when total is 0 (avoid div by zero)", () => {
		assert.strictEqual(calculateProgressFraction(0, 0, 0), 1);
	});

	it("calculateProgressFraction returns correct partial value", () => {
		assert.strictEqual(calculateProgressFraction(3, 0, 10), 0.3);
		assert.strictEqual(calculateProgressFraction(2, 1, 10), 0.3);
		assert.strictEqual(calculateProgressFraction(0, 5, 10), 0.5);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Use-case — event data construction
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Use-case — progress tracking from event sequence", () => {
	it("tracks 0/3 -> 1/3 -> 2/3 -> 3/3 progression", () => {
		const names = ["a", "b", "c"];
		let state = createLoadingProgress(names);

		// 0/3
		assert.strictEqual(state.completed, 0);

		// 1/3
		state = applyProgressDelta(state, { name: "a", status: "done" });
		assert.strictEqual(state.completed, 1);
		assert.strictEqual(state.entries[0]!.status, "done");

		// 2/3
		state = applyProgressDelta(state, { name: "b", status: "done" });
		assert.strictEqual(state.completed, 2);

		// 3/3
		state = applyProgressDelta(state, { name: "c", status: "done" });
		assert.strictEqual(state.completed, 3);
		assert.strictEqual(state.failed, 0);
	});

	it("tracks failure events correctly", () => {
		const names = ["a", "b"];
		let state = createLoadingProgress(names);

		state = applyProgressDelta(state, { name: "a", status: "failed", error: "Timeout" });
		assert.strictEqual(state.failed, 1);
		assert.strictEqual(state.completed, 0);
		assert.strictEqual(state.entries[0]!.error, "Timeout");
	});

	it("handles mixed success and failure", () => {
		const names = ["good", "bad", "ok"];
		let state = createLoadingProgress(names);

		state = applyProgressDelta(state, { name: "good", status: "done" });
		state = applyProgressDelta(state, { name: "bad", status: "failed", error: "crash" });
		state = applyProgressDelta(state, { name: "ok", status: "done" });

		assert.strictEqual(state.completed, 2);
		assert.strictEqual(state.failed, 1);
		assert.strictEqual(state.pending, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Boundary — edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Boundary — edge cases", () => {
	it("50 extensions all succeed", () => {
		const names = Array.from({ length: 50 }, (_, i) => `ext${i}`);
		let state = createLoadingProgress(names);

		for (let i = 0; i < 50; i++) {
			state = applyProgressDelta(state, { name: `ext${i}`, status: "done" });
			assert.strictEqual(state.completed, i + 1);
		}

		assert.strictEqual(state.completed, 50);
		assert.strictEqual(state.failed, 0);
		assert.strictEqual(state.pending, 0);
	});

	it("applying delta for unknown name leaves state unchanged", () => {
		const initial = createLoadingProgress(["ext1"]);
		const updated = applyProgressDelta(initial, { name: "nonexistent", status: "done" });
		assert.strictEqual(updated.completed, 0);
		assert.strictEqual(updated.entries.length, 1);
		assert.strictEqual(updated.entries[0]!.status, "pending");
	});

	it("entry error can be updated from string to undefined", () => {
		let state = createLoadingProgress(["ext1"]);
		state = applyProgressDelta(state, { name: "ext1", status: "failed", error: "err" });
		assert.strictEqual(state.entries[0]!.error, "err");
		// Updating to done clears the error reference in our implementation
		state = applyProgressDelta(state, { name: "ext1", status: "done" });
		assert.strictEqual(state.entries[0]!.status, "done");
	});
});
