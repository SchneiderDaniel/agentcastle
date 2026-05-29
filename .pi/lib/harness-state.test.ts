/**
 * Tests for harness-state.ts — pure factory tests.
 * No infra, no pi runtime, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessState } from "./harness-state.ts";
import { CACHE_TTL_TURNS } from "./harness-rules.ts";

// ── Read Cache ──

describe("ReadCache", () => {
	it("get returns null for missing key", () => {
		const state = createHarnessState();
		assert.equal(state.readCache.get("missing", 0), null);
	});

	it("set then get returns entry", () => {
		const state = createHarnessState();
		state.readCache.set("key1", "content1", 0);
		const entry = state.readCache.get("key1", 0);
		assert.notEqual(entry, null);
		assert.equal(entry!.content, "content1");
		assert.equal(entry!.turn, 0);
	});

	it("get respects turn-based TTL", () => {
		const state = createHarnessState();
		state.readCache.set("key1", "content1", 0);

		// Within TTL
		const entry = state.readCache.get("key1", CACHE_TTL_TURNS - 1);
		assert.notEqual(entry, null);

		// At TTL boundary — >= CACHE_TTL_TURNS means expired
		const expired = state.readCache.get("key1", CACHE_TTL_TURNS);
		assert.equal(expired, null);
	});

	it("get respects time-based TTL (Date.now)", () => {
		const state = createHarnessState();
		const realNow = Date.now;

		try {
			// Set entry with a timestamp far in the past
			Date.now = () => 1000;
			state.readCache.set("key1", "content1", 0);

			// Now get with current time far in the future
			Date.now = () => 1000 + 31_000; // 31s > CACHE_TTL_MS (30s)
			const expired = state.readCache.get("key1", 1);
			assert.equal(expired, null, "entry should expire based on real time");
		} finally {
			Date.now = realNow;
		}
	});

	it("clear removes all entries", () => {
		const state = createHarnessState();
		state.readCache.set("k1", "v1", 0);
		state.readCache.set("k2", "v2", 0);
		state.readCache.clear();
		assert.equal(state.readCache.get("k1", 0), null);
		assert.equal(state.readCache.get("k2", 0), null);
	});

	it("batchId-aware get — same batchId returns entry", () => {
		const state = createHarnessState();
		state.readCache.set("k1", "v1", 0, 42);

		// Same batchId, different turn — still valid
		const entry = state.readCache.get("k1", 5, 42);
		assert.notEqual(entry, null);
		assert.equal(entry!.content, "v1");
	});

	it("batchId-aware get — different batchId uses turn-based TTL", () => {
		const state = createHarnessState();
		state.readCache.set("k1", "v1", 0, 42);

		// Different batchId — falls back to turn-based TTL
		// Turn diff 5 < CACHE_TTL_TURNS (6) → still valid
		const entry = state.readCache.get("k1", 5, 99);
		assert.notEqual(entry, null);

		// Turn diff >= CACHE_TTL_TURNS → expired
		const expired = state.readCache.get("k1", CACHE_TTL_TURNS, 99);
		assert.equal(expired, null);
	});

	it("batchId-aware get — no batchId in current call, entry has batchId", () => {
		const state = createHarnessState();
		state.readCache.set("k1", "v1", 0, 42);

		// No batchId passed to get — falls back to turn-based
		const entry = state.readCache.get("k1", 0);
		assert.notEqual(entry, null);
	});

	it("batchId-aware get — entry has no batchId, current call has batchId", () => {
		const state = createHarnessState();
		state.readCache.set("k1", "v1", 0); // no batchId

		// Current call has batchId — falls back to turn-based
		const entry = state.readCache.get("k1", 0, 42);
		assert.notEqual(entry, null);
	});
});

// ── Error Tracker ──

describe("ErrorTracker", () => {
	it("starts empty", () => {
		const state = createHarnessState();
		assert.deepEqual(state.errorTracker.getLastErrors("read"), []);
	});

	it("push adds entry", () => {
		const state = createHarnessState();
		state.errorTracker.push("read", { turn: 0, toolName: "read" });
		assert.equal(state.errorTracker.getLastErrors("read").length, 1);
	});

	it("evicts oldest when over MAX_ERRORS_PER_TOOL", () => {
		const state = createHarnessState();
		for (let i = 0; i < 4; i++) {
			state.errorTracker.push("read", { turn: i, toolName: "read" });
		}
		const errors = state.errorTracker.getLastErrors("read");
		assert.equal(errors.length, 3);
		assert.equal(errors[0].turn, 1); // oldest (turn 0) evicted
	});

	it("clear removes all", () => {
		const state = createHarnessState();
		state.errorTracker.push("read", { turn: 0, toolName: "read" });
		state.errorTracker.clear();
		assert.deepEqual(state.errorTracker.getLastErrors("read"), []);
	});
});

// ── Call Counter ──

describe("CallCounter", () => {
	it("starts with no consecutive", () => {
		const state = createHarnessState();
		const info = state.callCounter.getConsecutive("read");
		assert.equal(info.count, 0);
	});

	it("record tracks consecutive calls", () => {
		const state = createHarnessState();
		state.callCounter.record("read", 0);
		assert.equal(state.callCounter.getConsecutive("read").count, 1);
		state.callCounter.record("read", 1);
		assert.equal(state.callCounter.getConsecutive("read").count, 2);
	});

	it("different tools reset consecutive", () => {
		const state = createHarnessState();
		state.callCounter.record("read", 0);
		state.callCounter.record("write", 1);
		assert.equal(state.callCounter.getConsecutive("read").count, 0);
		assert.equal(state.callCounter.getConsecutive("write").count, 1);
	});

	it("subKey creates separate counter for bash", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "git status");
		assert.equal(state.callCounter.getConsecutive("bash", "git status").count, 1);

		state.callCounter.record("bash", 1, "git diff");
		// Different subKey resets the "git status" chain
		assert.equal(state.callCounter.getConsecutive("bash", "git status").count, 0);
		assert.equal(state.callCounter.getConsecutive("bash", "git diff").count, 1);
	});

	it("same subKey increments consecutive", () => {
		const state = createHarnessState();
		state.callCounter.record("bash", 0, "ls");
		state.callCounter.record("bash", 1, "ls");
		assert.equal(state.callCounter.getConsecutive("bash", "ls").count, 2);
	});

	it("reset clears all", () => {
		const state = createHarnessState();
		state.callCounter.record("read", 0);
		state.callCounter.reset();
		assert.equal(state.callCounter.getConsecutive("read").count, 0);
	});
});

// ── HarnessState ──

describe("HarnessState", () => {
	it("createHarnessState returns isolated state", () => {
		const s1 = createHarnessState();
		const s2 = createHarnessState();

		s1.currentTurn = 5;
		s1.readCache.set("k", "v", 0);

		assert.equal(s2.currentTurn, 0);
		assert.equal(s2.readCache.get("k", 0), null);
	});

	it("batchId is undefined by default", () => {
		const state = createHarnessState();
		assert.equal(state.batchId, undefined);
	});
});

// ── CACHE_TTL_TURNS ──

describe("Constants", () => {
	it("CACHE_TTL_TURNS is at least 6", () => {
		assert.ok(CACHE_TTL_TURNS >= 6);
	});
});
