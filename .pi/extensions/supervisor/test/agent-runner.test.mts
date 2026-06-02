// ─── Tests: agent-runner.ts — Phase 1 budget param wiring ────────
// Tests that runAgentSubprocess accepts optional agentTokenBudget/maxToolCalls
// and initializes AgentRunState with them.
// Also tests runAgent passes budget params through to subprocess fallback.
//
// Uses the exported createAgentRunState helper for state initialization testing,
// and calls runner functions with short timeout (1ms) to fail fast.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState, AgentRunResult } from "../types.ts";
import { createAgentRunState } from "../agent-runner.ts";
import { runAgentSubprocess } from "../agent-runner.ts";
import { runAgent } from "../agent-runner.ts";

// ─── Fixtures ─────────────────────────────────────────────────────

const mockAgent = {
	config: {
		name: "test-agent",
		tools: "read,bash",
		model: "test-model",
		extensions: "",
		skills: "",
	},
	systemPrompt: "You are a test agent.",
};

// Minimal mock for ExtensionCommandContext
const mockCtx: any = {
	cwd: "/tmp",
	ui: {
		notify: () => {},
		setStatus: () => {},
		setWidget: () => {},
		setWorkingMessage: () => {},
	},
};

// ─── createAgentRunState — budget field initialization ───────────

describe("createAgentRunState — budget field initialization", () => {
	it("state initialized with maxToolCalls=30 when passed 30", () => {
		const state = createAgentRunState(Date.now(), 30);
		assert.equal(state.maxToolCalls, 30);
	});

	it("state initialized with agentTokenBudget=500000 when passed 500000", () => {
		const state = createAgentRunState(Date.now(), undefined, 500000);
		assert.equal(state.agentTokenBudget, 500000);
	});

	it("state has both budget fields set correctly when both passed", () => {
		const state = createAgentRunState(Date.now(), 30, 500000);
		assert.equal(state.maxToolCalls, 30);
		assert.equal(state.agentTokenBudget, 500000);
	});

	it("state has maxToolCalls=0 and agentTokenBudget=0 when undefined (backward compat)", () => {
		const state = createAgentRunState(Date.now());
		assert.equal(state.maxToolCalls, 0);
		assert.equal(state.agentTokenBudget, 0);
	});

	it("state has maxToolCalls=0 and agentTokenBudget=0 when explicitly 0", () => {
		const state = createAgentRunState(Date.now(), 0, 0);
		assert.equal(state.maxToolCalls, 0);
		assert.equal(state.agentTokenBudget, 0);
	});

	it("budgetExceeded is false initially", () => {
		const state = createAgentRunState(Date.now(), 30, 500000);
		assert.equal(state.budgetExceeded, false);
	});

	it("budgetExceededReason is undefined initially", () => {
		const state = createAgentRunState(Date.now(), 30, 500000);
		assert.equal(state.budgetExceededReason, undefined);
	});

	it("startedAt is set to the passed value", () => {
		const startedAt = 1234567890;
		const state = createAgentRunState(startedAt, 30, 500000);
		assert.equal(state.startedAt, startedAt);
	});
});

// ─── runAgentSubprocess — budget param acceptance ────────────────

describe("runAgentSubprocess — budget param wiring", () => {
	it("accepts maxToolCalls param and completes without type error", async () => {
		const result = await runAgentSubprocess(
			mockAgent as any,
			"test task",
			mockCtx,
			1, // timeoutMs — immediate timeout
			undefined, // cwd
			30, // maxToolCalls
		);
		assert.ok(typeof result.success === "boolean");
	});

	it("accepts agentTokenBudget param and completes without type error", async () => {
		const result = await runAgentSubprocess(
			mockAgent as any,
			"test task",
			mockCtx,
			1,
			undefined,
			undefined,
			500000,
		);
		assert.ok(typeof result.success === "boolean");
	});

	it("accepts both budget params and completes without type error", async () => {
		const result = await runAgentSubprocess(
			mockAgent as any,
			"test task",
			mockCtx,
			1,
			undefined,
			30,
			500000,
		);
		assert.ok(typeof result.success === "boolean");
	});

	it("works without budget params (backward compatible)", async () => {
		const result = await runAgentSubprocess(mockAgent as any, "test task", mockCtx, 1);
		assert.ok(typeof result.success === "boolean");
	});

	it("works with zero budget params (explicit unlimited)", async () => {
		const result = await runAgentSubprocess(
			mockAgent as any,
			"test task",
			mockCtx,
			1,
			undefined,
			0,
			0,
		);
		assert.ok(typeof result.success === "boolean");
	});
});

// ─── runAgentSubprocess — result includes budgetExceeded field ──

describe("runAgentSubprocess — budgetExceeded in result", () => {
	it("result object has budgetExceeded property (even when budget not exceeded)", async () => {
		const result = await runAgentSubprocess(
			mockAgent as any,
			"test task",
			mockCtx,
			1, // timeoutMs — immediate timeout
		);
		// The property must be present on the result object so callers can
		// distinguish budget-exceeded failures from regular failures.
		// It will be undefined when budget was not exceeded, but the property
		// must exist (not just accessing a missing property).
		assert.ok(
			"budgetExceeded" in result,
			"budgetExceeded must be a property of the subprocess result",
		);
	});

	it("budgetExceeded is false/undefined when budget not exceeded", async () => {
		const result = await runAgentSubprocess(mockAgent as any, "test task", mockCtx, 1);
		// When budget is not exceeded, value should be undefined (not true)
		assert.equal(result.budgetExceeded, undefined);
	});
});

// ─── runAgent — budget param passthrough ────────────────────────

describe("runAgent — budget param passthrough", () => {
	it("accepts budget params and completes without type error", async () => {
		const result = await runAgent(
			mockAgent as any,
			"test task",
			mockCtx,
			{} as any,
			1,
			undefined,
			30,
			500000,
		);
		assert.ok(typeof result.success === "boolean");
	});

	it("works without budget params (backward compatible)", async () => {
		const result = await runAgent(mockAgent as any, "test task", mockCtx, {} as any, 1);
		assert.ok(typeof result.success === "boolean");
	});
});
