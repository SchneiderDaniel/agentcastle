/**
 * Tests for harness-state.ts — Runtime mutable state
 *
 * Phase 2: Use case layer unit tests.
 * In-memory state: read cache, error tracker, call counter.
 * No pi, no I/O. Fast unit tests.
 *
 * Run with:
 *   node --experimental-strip-types --test test/agent-harness-state.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createHarnessState } from "../.pi/lib/harness-state.ts";

// ─── ReadCache ─────────────────────────────────────────────────────

describe("ReadCache", () => {
	it("returns null on cache miss (empty cache)", () => {
		const state = createHarnessState();
		assert.strictEqual(state.readCache.get("a|0|100", 0), null);
	});

	it("stores and retrieves a value", () => {
		const state = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		const entry = state.readCache.get("a|0|100", 0);
		assert.ok(entry !== null);
		assert.strictEqual(entry.content, "content");
		assert.strictEqual(entry.turn, 0);
	});

	it("returns null when TTL expires (turn difference >= CACHE_TTL_TURNS=6)", () => {
		const state = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		const entry = state.readCache.get("a|0|100", 6);
		assert.strictEqual(entry, null);
	});

	it("returns cached value when within TTL bounds", () => {
		const state = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		const entry = state.readCache.get("a|0|100", 2);
		assert.ok(entry !== null);
		assert.strictEqual(entry.content, "content");
	});

	it("overwrites existing key with newer value", () => {
		const state = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		state.readCache.set("a|0|100", "new", 1);
		const entry = state.readCache.get("a|0|100", 1);
		assert.ok(entry !== null);
		assert.strictEqual(entry.content, "new");
	});

	it("handles empty string key", () => {
		const state = createHarnessState();
		state.readCache.set("", "x", 0);
		const entry = state.readCache.get("", 0);
		assert.ok(entry !== null);
		assert.strictEqual(entry.content, "x");
	});

	it("returns correct timestamp", () => {
		const state = createHarnessState();
		state.readCache.set("k", "v", 5);
		const entry = state.readCache.get("k", 5);
		assert.ok(entry !== null);
		assert.ok(entry.timestamp > 0);
	});

	it("cache miss for different keys", () => {
		const state = createHarnessState();
		state.readCache.set("a|0|100", "content", 0);
		assert.strictEqual(state.readCache.get("b|0|100", 0), null);
	});
});

// ─── ErrorTracker ──────────────────────────────────────────────────

describe("ErrorTracker", () => {
	it("returns empty array for tool with no errors", () => {
		const state = createHarnessState();
		assert.deepStrictEqual(state.errorTracker.getLastErrors("bash"), []);
	});

	it("stores and retrieves a single error", () => {
		const state = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		const errors = state.errorTracker.getLastErrors("bash");
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(errors[0].turn, 0);
	});

	it("stores errors for different tools separately", () => {
		const state = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		assert.deepStrictEqual(state.errorTracker.getLastErrors("read"), []);
	});

	it("limits to 3 entries maximum", () => {
		const state = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 1, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 2, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 3, toolName: "bash" });
		const errors = state.errorTracker.getLastErrors("bash");
		assert.strictEqual(errors.length, 3);
		assert.strictEqual(errors[0].turn, 1);
		assert.strictEqual(errors[1].turn, 2);
		assert.strictEqual(errors[2].turn, 3);
	});

	it("evicts oldest when exceeding 3 entries", () => {
		const state = createHarnessState();
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 1, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 2, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 3, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 4, toolName: "bash" });
		const errors = state.errorTracker.getLastErrors("bash");
		assert.strictEqual(errors.length, 3);
		assert.strictEqual(errors[0].turn, 2);
		assert.strictEqual(errors[1].turn, 3);
		assert.strictEqual(errors[2].turn, 4);
	});

	it("handles empty string tool key", () => {
		const state = createHarnessState();
		state.errorTracker.push("", { turn: 0, toolName: "" });
		const errors = state.errorTracker.getLastErrors("");
		assert.strictEqual(errors.length, 1);
	});
});

// ─── CallCounter ───────────────────────────────────────────────────

describe("CallCounter", () => {
	it("starts at 0 for any tool", () => {
		const state = createHarnessState();
		const info = state.callCounter.getConsecutive("bash");
		assert.strictEqual(info.count, 0);
	});

	it("records first call for a tool", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0);
		const info = state.callCounter.getConsecutive("bash");
		assert.strictEqual(info.toolName, "bash");
		assert.strictEqual(info.count, 1);
		assert.strictEqual(info.sinceTurn, 0);
	});

	it("increments count on consecutive same-tool calls", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 0);
		const info = state.callCounter.getConsecutive("bash");
		assert.strictEqual(info.count, 3);
	});

	it("resets count when tool changes", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 0);
		state.callCounter.record("read", 0);
		const bashInfo = state.callCounter.getConsecutive("bash");
		const readInfo = state.callCounter.getConsecutive("read");
		assert.strictEqual(readInfo.count, 1);
		assert.strictEqual(bashInfo.count, 0);
	});

	it("tracks last tool name", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("read", 1);
		state.callCounter.record("read", 2);
		const readInfo = state.callCounter.getConsecutive("read");
		assert.strictEqual(readInfo.count, 2);
		assert.strictEqual(readInfo.sinceTurn, 1);
	});

	it("reset() clears all counters", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("read", 1);
		state.callCounter.reset();
		assert.strictEqual(state.callCounter.getConsecutive("bash").count, 0);
		assert.strictEqual(state.callCounter.getConsecutive("read").count, 0);
		assert.strictEqual(state.callCounter.getConsecutive("bash").toolName, "");
	});

	it("sinceTurn tracks when streak started", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 5);
		state.callCounter.record("bash", 5);
		const info = state.callCounter.getConsecutive("bash");
		assert.strictEqual(info.sinceTurn, 5);
	});

	// ── subKey support (Bug 3 fix) ──

	it("records first subKey call", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "ls");
		const info = state.callCounter.getConsecutive("bash", "ls");
		assert.strictEqual(info.toolName, "bash");
		assert.strictEqual(info.count, 1);
		assert.strictEqual(info.sinceTurn, 0);
	});

	it("different subKey resets counter", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "ls");
		state.callCounter.record("bash", 1, "cd");
		const cdInfo = state.callCounter.getConsecutive("bash", "cd");
		assert.strictEqual(cdInfo.count, 1);
	});

	it("same subKey increments counter", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "ls");
		state.callCounter.record("bash", 0, "ls");
		state.callCounter.record("bash", 0, "ls");
		const info = state.callCounter.getConsecutive("bash", "ls");
		assert.strictEqual(info.count, 3);
	});

	it("stale subKey returns count 0", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "ls");
		state.callCounter.record("bash", 1, "cd");
		const lsInfo = state.callCounter.getConsecutive("bash", "ls");
		assert.strictEqual(lsInfo.count, 0);
	});

	it("no subKey maintains backward compat", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0);
		state.callCounter.record("bash", 1);
		const info = state.callCounter.getConsecutive("bash");
		assert.strictEqual(info.count, 2);
	});

	it("subKey resets on tool switch", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "ls");
		state.callCounter.record("read", 1);
		const readInfo = state.callCounter.getConsecutive("read");
		assert.strictEqual(readInfo.count, 1);
		const bashLsInfo = state.callCounter.getConsecutive("bash", "ls");
		assert.strictEqual(bashLsInfo.count, 0);
	});

	it("no subKey tools maintain backward compat count", () => {
		const state = createHarnessState();
		state.callCounter.record("write", 0);
		state.callCounter.record("write", 1);
		state.callCounter.record("write", 2);
		const info = state.callCounter.getConsecutive("write");
		assert.strictEqual(info.count, 3);
	});

	it("reset clears subKey counters", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "ls");
		state.callCounter.record("bash", 1, "cd");
		state.callCounter.record("read", 2);
		state.callCounter.reset();
		assert.strictEqual(state.callCounter.getConsecutive("bash", "ls").count, 0);
		assert.strictEqual(state.callCounter.getConsecutive("bash", "cd").count, 0);
		assert.strictEqual(state.callCounter.getConsecutive("read").count, 0);
	});
});

// ─── Factory isolation ────────────────────────────────────────────

describe("createHarnessState factory isolation", () => {
	it("each call creates independent state", () => {
		const state1 = createHarnessState();
		const state2 = createHarnessState();

		state1.readCache.set("k", "v1", 0);
		state2.readCache.set("k", "v2", 0);

		assert.strictEqual(state1.readCache.get("k", 0)?.content, "v1");
		assert.strictEqual(state2.readCache.get("k", 0)?.content, "v2");
	});

	it("error trackers are isolated", () => {
		const state1 = createHarnessState();
		const state2 = createHarnessState();

		state1.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		assert.strictEqual(state2.errorTracker.getLastErrors("bash").length, 0);
	});

	it("call counters are isolated", () => {
		const state1 = createHarnessState();
		const state2 = createHarnessState();

		state1.callCounter.record("bash", 0);
		assert.strictEqual(state2.callCounter.getConsecutive("bash").count, 0);
	});
});
