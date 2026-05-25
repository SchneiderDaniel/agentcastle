/**
 * Tests for agent-harness tool call handler.
 *
 * Pure-function unit tests: no infra, no pi runtime, no network.
 * Verify the 5 bugs from issue #207 are fixed:
 *   Bug 1: record() called for all tools (including pass-through)
 *   Bug 2: currentTurn advances on block paths
 *   Bug 3: currentTurn advances on bash empty-command
 *   Bug 4: CASCADE_THRESHOLD raised to 8
 *   Bug 5: CACHE_TTL_TURNS unified and raised to 6
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessState } from "../../lib/harness-state.ts";
import { createToolCallHandler } from "./index.ts";
import { CASCADE_THRESHOLD, CACHE_TTL_TURNS } from "../../lib/harness-rules.ts";
import type { ToolCallResult } from "./index.ts";
import type { HarnessState } from "../../lib/harness-state.ts";

// ── Helpers ──

function makeEvent(toolName: string, args: Record<string, unknown> = {}, isError = false) {
	return {
		input: { toolName, args },
		isError,
	};
}

function makeCtx() {
	return {};
}

function callNTimes(
	handler: ReturnType<typeof createToolCallHandler>,
	toolName: string,
	n: number,
	args: Record<string, unknown> = {},
) {
	const results: (ToolCallResult | null)[] = [];
	for (let i = 0; i < n; i++) {
		results.push(handler(makeEvent(toolName, args), makeCtx()));
	}
	return results;
}

// ── Tests ──

describe("agent-harness handler", () => {
	// ── Bug 1: record() called before pass-through check ──

	it("record() is called for pass-through tools — resets consecutive counter", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Call read twice → consecutive count for read should be 2
		handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		handler(makeEvent("read", { path: "b.ts" }), makeCtx());

		// Now call pass-through tool → should reset consecutive
		handler(makeEvent("ripgrep_search"), makeCtx());

		// Now call read again → consecutive should be 1 (reset by pass-through)
		handler(makeEvent("read", { path: "c.ts" }), makeCtx());

		// Get consecutive info: after the most recent read, count should be 1
		const info = state.callCounter.getConsecutive("read");
		assert.equal(info.toolName, "read");
		assert.equal(info.count, 1, "pass-through tool should reset consecutive counter");
	});

	it("record() is called for pass-through tools independently", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Call a pass-through tool — should record
		handler(makeEvent("structural_search"), makeCtx());

		// Check that getConsecutive for it works (it's the last recorded tool)
		const info = state.callCounter.getConsecutive("structural_search");
		assert.equal(info.toolName, "structural_search");
		assert.equal(info.count, 1);
	});

	// ── Bug 2: currentTurn advances on block paths ──

	it("currentTurn advances on error retry block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Push 2 errors for read
		state.errorTracker.push("read", { turn: 0, toolName: "read" });
		state.errorTracker.push("read", { turn: 1, toolName: "read" });

		// Next read call should be blocked (error retry)
		const result = handler(makeEvent("read"), makeCtx());
		assert.ok(result?.block, "should block on error retry");

		// currentTurn should advance
		assert.equal(state.currentTurn, 1, "currentTurn should advance on error retry block");
	});

	it("currentTurn advances on read cache block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First call: not cached, passes through
		handler(makeEvent("read", { path: "x.ts" }), makeCtx());

		// Second call: same path+offset+limit → cache hit, block
		const result = handler(makeEvent("read", { path: "x.ts" }), makeCtx());
		assert.ok(result?.block, "should block on cache hit");

		// currentTurn should advance to 2 (first call incremented to 1, second to 2)
		assert.equal(state.currentTurn, 2, "currentTurn should advance on read cache block");
	});

	it("currentTurn advances on cascade block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Call read repeatedly until blocked by cascade
		let result: ToolCallResult | null = null;
		for (let i = 0; i < CASCADE_THRESHOLD; i++) {
			result = handler(makeEvent("read", { path: `file${i}.ts` }), makeCtx());
		}

		// Last call should be blocked
		assert.ok(result?.block, "should block on cascade");
		// currentTurn should equal CASCADE_THRESHOLD
		assert.equal(
			state.currentTurn,
			CASCADE_THRESHOLD,
			"currentTurn should advance on cascade block",
		);
	});

	it("currentTurn advances on bash mismatch block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "| grep something" }), makeCtx());
		assert.ok(result?.block, "should block bash grep");

		assert.equal(state.currentTurn, 1, "currentTurn should advance on bash mismatch block");
	});

	// ── Bug 3: currentTurn advances on bash empty-command ──

	it("currentTurn advances on bash empty command", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Empty command should pass through (result null) but still increment turn
		const result = handler(makeEvent("bash", {}), makeCtx());
		assert.equal(result, null, "empty bash command should pass through");
		assert.equal(state.currentTurn, 1, "currentTurn should advance on empty bash command");
	});

	it("currentTurn advances on bash null command", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "" }), makeCtx());
		assert.equal(result, null, "null bash command should pass through");
		assert.equal(state.currentTurn, 1, "currentTurn should advance on null bash command");
	});

	// ── currentTurn advances on normal paths (regression) ──

	it("currentTurn advances on pass-through tool call", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		handler(makeEvent("ripgrep_search"), makeCtx());
		assert.equal(state.currentTurn, 1, "currentTurn should advance on pass-through");
	});

	it("currentTurn advances on error tracking path", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		handler(makeEvent("read", {}, true), makeCtx());
		assert.equal(state.currentTurn, 1, "currentTurn should advance on error tracking");
	});

	// ── Bug 4: CASCADE_THRESHOLD ──

	it("cascade blocks only after CASCADE_THRESHOLD consecutive calls", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// CASCADE_THRESHOLD - 1 calls → should NOT block
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			const result = handler(makeEvent("read", { path: `f${i}.ts` }), makeCtx());
			assert.equal(result, null, `call ${i + 1}/${CASCADE_THRESHOLD - 1} should not block`);
		}

		// CASCADE_THRESHOLD-th call → should block
		const result = handler(makeEvent("read", { path: "block.ts" }), makeCtx());
		assert.ok(result?.block, `${CASCADE_THRESHOLD}th call should block`);
		assert.ok(result!.reason.includes("Same-tool cascade"), "reason should mention cascade");
	});

	it("CASCADE_THRESHOLD is at least 8", () => {
		assert.ok(
			CASCADE_THRESHOLD >= 8,
			`CASCADE_THRESHOLD should be >= 8 (got ${CASCADE_THRESHOLD})`,
		);
	});

	// ── Bug 5: CACHE_TTL_TURNS unified ──

	it("CACHE_TTL_TURNS is at least 6", () => {
		assert.ok(CACHE_TTL_TURNS >= 6, `CACHE_TTL_TURNS should be >= 6 (got ${CACHE_TTL_TURNS})`);
	});

	// ── Edge cases ──

	it("multiple different tools don't trigger cascade", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Interleave different tools with unique paths — no cascade
		const sequence = [
			{ tool: "read", args: { path: "a.ts" } },
			{ tool: "bash", args: { command: "echo hi" } },
			{ tool: "read", args: { path: "b.ts" } },
			{ tool: "bash", args: { command: "echo there" } },
			{ tool: "read", args: { path: "c.ts" } },
			{ tool: "bash", args: { command: "echo world" } },
			{ tool: "read", args: { path: "d.ts" } },
			{ tool: "bash", args: { command: "echo foo" } },
		];
		for (let i = 0; i < sequence.length; i++) {
			const { tool, args } = sequence[i];
			const result = handler(makeEvent(tool, args), makeCtx());
			assert.equal(result, null, `mixed tools should not block at index ${i}`);
		}
	});

	it("pass-through tools interleaved with read don't trigger cascade", () => {
		// The original Bug 1 scenario: read × pass-through × read × pass-through × ...
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Simulate: read, ripgrep_search, read, ranked_map, read, structural_search, read
		const sequence = [
			{ tool: "read", args: { path: "a.ts" } },
			{ tool: "ripgrep_search", args: {} },
			{ tool: "read", args: { path: "b.ts" } },
			{ tool: "ranked_map", args: {} },
			{ tool: "read", args: { path: "c.ts" } },
			{ tool: "structural_search", args: {} },
			{ tool: "read", args: { path: "d.ts" } },
		];

		for (let i = 0; i < sequence.length; i++) {
			const { tool, args } = sequence[i];
			const result = handler(makeEvent(tool, args), makeCtx());
			assert.equal(
				result,
				null,
				`interleaved pass-through tools should not cause cascade at step ${i} (${tool})`,
			);
		}

		// After sequence, currentTurn should be 7
		assert.equal(state.currentTurn, sequence.length);
	});
});
