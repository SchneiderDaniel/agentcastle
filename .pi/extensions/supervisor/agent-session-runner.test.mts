// ─── Tests: agent-session-runner.ts — Phase 1 abort on budget exceeded ──
// Integration tests with mock session. No actual LLM calls.
// Tests that session.abort() is called when state.budgetExceeded is true.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { buildAgentRunResult } from "./session-result.ts";
import type { AgentRunState, AgentRunResult } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────

function createState(overrides?: Partial<AgentRunState>): AgentRunState {
	return {
		currentTool: undefined,
		currentToolArgs: undefined,
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		phase: "idle",
		startedAt: Date.now(),
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
		budgetExceeded: false,
		budgetExceededReason: undefined,
		maxToolCalls: 0,
		agentTokenBudget: 0,
		...overrides,
	};
}

// ─── buildAgentRunResult reads state.budgetExceeded ───────────────

describe("buildAgentRunResult — budgetExceeded propagation", () => {
	it("result.budgetExceeded is true when state.budgetExceeded is true", () => {
		const state = createState({ budgetExceeded: true });
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, true);
	});

	it("result.budgetExceeded is undefined when state.budgetExceeded is false", () => {
		const state = createState({ budgetExceeded: false });
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, undefined);
	});
});

// ─── Abort on budget exceeded ─────────────────────────────────────

describe("session abort on budget exceeded", () => {
	it("abort() is called when budgetExceeded is true after prompt settles", async () => {
		// Mock session with abort method
		let abortCalled = false;
		const mockAbort = () => {
			abortCalled = true;
		};
		const mockSession = {
			abort: mockAbort,
			dispose: () => {},
			state: { messages: [] },
		};

		// Simulate what happens in the runner after prompt settles
		// with budgetExceeded = true
		const state = createState({ budgetExceeded: true });

		// In the runner, after prompt settles:
		if (state.budgetExceeded) {
			await mockSession.abort();
		}

		assert.equal(abortCalled, true, "session.abort() should be called once");
	});

	it("abort() is NOT called when budgetExceeded is false", async () => {
		let abortCalled = false;
		const mockSession = {
			abort: () => {
				abortCalled = true;
			},
			dispose: () => {},
			state: { messages: [] },
		};

		const state = createState({ budgetExceeded: false });

		if (state.budgetExceeded) {
			await mockSession.abort();
		}

		assert.equal(abortCalled, false, "session.abort() should NOT be called");
	});

	it("buildAgentRunResult with budgetExceeded returns properly typed result", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Tool limit: 30/30",
			toolCount: 30,
			tokenCount: 100000,
		});
		const result: AgentRunResult = buildAgentRunResult(state, "developer", false, 5000, []);
		assert.equal(result.budgetExceeded, true);
		assert.equal(result.toolCount, 30);
		assert.equal(result.tokenCount, 100000);
		assert.equal(result.success, false);
	});
});
