/**
 * Tests for harness-state.ts — integration-scoped factory tests.
 *
 * Shallow ReadCache/ErrorTracker/CallCounter unit tests removed (covered by
 * .pi/lib/timed-map.test.ts for generic TimedMap behavior and by AgentHarness
 * integration tests for specialized wrapper behavior).
 *
 * Keeps:
 *  - HarnessState factory isolation tests
 *  - Constants sanity check
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessState } from "./harness-state.ts";
import { CACHE_TTL_TURNS } from "./harness-rules.ts";

// ── HarnessState ──

describe("HarnessState", () => {
	it("createHarnessState returns isolated state", () => {
		const s1 = createHarnessState();
		const s2 = createHarnessState();

		s1.toolCallIndex = 5;
		s1.readCache.set("k", "v", 0);

		assert.equal(s2.toolCallIndex, 0);
		assert.equal(s2.readCache.get("k", 0), null);
	});

	it("toolCallIndex starts at 0", () => {
		const state = createHarnessState();
		assert.equal(state.toolCallIndex, 0);
	});

	it("sessionTurn starts at 0", () => {
		const state = createHarnessState();
		assert.equal(state.sessionTurn, 0);
	});

	it("toolCallIndex and sessionTurn are independent", () => {
		const state = createHarnessState();
		state.toolCallIndex = 5;
		assert.equal(state.sessionTurn, 0); // not affected

		state.sessionTurn = 3;
		assert.equal(state.toolCallIndex, 5); // not affected
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
