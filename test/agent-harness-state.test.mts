/**
 * Tests for harness-state.ts — runtime mutable state.
 *
 * Phase 2: Use case layer. In-memory state per session.
 *
 * Run with:
 *   node --experimental-strip-types --test test/agent-harness-state.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createHarnessState } from "../src/harness-state.ts";
import type { HarnessState } from "../src/harness-state.ts";

// ---------------------------------------------------------------------------
// ReadCache
// ---------------------------------------------------------------------------

describe("HarnessState → ReadCache", () => {
	it("returns null on cache miss", () => {
		const state: HarnessState = createHarnessState();
		assert.strictEqual(state.readCache.get("a|0|100", 0), null);
	});

	it("stores and retrieves value within TTL", () => {
		const state: HarnessState = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		const result = state.readCache.get("a|0|100", 0);
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.content, "content");
		assert.strictEqual(result!.turn, 0);
	});

	it("returns null when TTL (3 turns) exceeded", () => {
		const state: HarnessState = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		assert.strictEqual(state.readCache.get("a|0|100", 3), null);
	});

	it("returns value within TTL at turn 2", () => {
		const state: HarnessState = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		const result = state.readCache.get("a|0|100", 2);
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.content, "content");
	});

	it("overwrites on subsequent set with same key", () => {
		const state: HarnessState = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		state.readCache.set("a|0|100", "new", 1);
		const result = state.readCache.get("a|0|100", 1);
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.content, "new");
	});

	it("handles empty-string key", () => {
		const state: HarnessState = createHarnessState();
		assert.strictEqual(state.readCache.get("", 0), null);
		state.readCache.set("", "x", 0);
		const result = state.readCache.get("", 0);
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.content, "x");
	});

	it("clearCache empties all entries", () => {
		const state: HarnessState = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		state.readCache.clear();
		assert.strictEqual(state.readCache.get("a|0|100", 1), null);
	});
});

// ---------------------------------------------------------------------------
// ErrorTracker
// ---------------------------------------------------------------------------

describe("HarnessState → ErrorTracker", () => {
	it("returns empty array for tool with no errors", () => {
		const state: HarnessState = createHarnessState();
		assert.deepStrictEqual(state.errorTracker.getLastErrors("bash"), []);
	});

	it("stores and retrieves single error", () => {
		const state: HarnessState = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		const errors = state.errorTracker.getLastErrors("bash");
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(errors[0]!.turn, 0);
	});

	it("returns empty array for different tool", () => {
		const state: HarnessState = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		assert.deepStrictEqual(state.errorTracker.getLastErrors("read"), []);
	});

	it("keeps max 3 entries (oldest evicted)", () => {
		const state: HarnessState = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 1, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 2, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 3, toolName: "bash" });

		const errors = state.errorTracker.getLastErrors("bash");
		assert.strictEqual(errors.length, 3);
		// Oldest (turn 0) is evicted
		assert.strictEqual(errors[0]!.turn, 1);
		assert.strictEqual(errors[1]!.turn, 2);
		assert.strictEqual(errors[2]!.turn, 3);
	});

	it("handles empty-string toolName", () => {
		const state: HarnessState = createHarnessState();
		state.errorTracker.push("", { turn: 0, toolName: "" });
		const errors = state.errorTracker.getLastErrors("");
		assert.strictEqual(errors.length, 1);
	});

	it("clearErrors empties all trackers", () => {
		const state: HarnessState = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		state.errorTracker.clear();
		assert.deepStrictEqual(state.errorTracker.getLastErrors("bash"), []);
	});
});

// ---------------------------------------------------------------------------
// CallCounter
// ---------------------------------------------------------------------------

describe("HarnessState → CallCounter", () => {
	it("returns count 0 for missing tool", () => {
		const state: HarnessState = createHarnessState();
		const result = state.callCounter.getConsecutive("bash");
		assert.strictEqual(result.toolName, "bash");
		assert.strictEqual(result.count, 0);
	});

	it("tracks consecutive calls to same tool", () => {
		const state: HarnessState = createHarnessState();
		state.callCounter.record("bash", 0);
		const result = state.callCounter.getConsecutive("bash");
		assert.strictEqual(result.toolName, "bash");
		assert.strictEqual(result.count, 1);
		assert.strictEqual(result.sinceTurn, 0);
	});

	it("increments count for consecutive same-tool calls", () => {
		const state: HarnessState = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 0);
		const result = state.callCounter.getConsecutive("bash");
		assert.strictEqual(result.count, 3);
	});

	it("resets count on tool change", () => {
		const state: HarnessState = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 0);
		state.callCounter.record("read", 0);
		const bashResult = state.callCounter.getConsecutive("bash");
		const readResult = state.callCounter.getConsecutive("read");
		assert.strictEqual(bashResult.count, 0, "bash should reset");
		assert.strictEqual(readResult.count, 1, "read should be 1");
	});

	it("reset() clears all counters", () => {
		const state: HarnessState = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 0);
		state.callCounter.reset();
		const result = state.callCounter.getConsecutive("bash");
		assert.strictEqual(result.count, 0);
	});
});
