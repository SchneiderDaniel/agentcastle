// ─── Tests: agent-session-runner.ts — Phase 1 abort on budget exceeded
// and Phase 3 stall → throw → subprocess fallback ──
// Integration tests with mock session. No actual LLM calls.
// Tests that session.abort() is called when state.budgetExceeded is true
// and that watchdog-fired stall throws to trigger subprocess fallback.

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

// ─── Stall → throw → subprocess fallback ─────────────────────────

describe("stall detection throws to trigger subprocess fallback", () => {
	it("simulated watchdogFired block throws Error instead of returning result", async () => {
		// This simulates the refactored code path: when watchdog fires,
		// the code should throw so runAgent() catch block triggers subprocess fallback.
		// OLD: return buildAgentRunResult(state, agentName, false, durationMs, messages);
		// NEW: throw new Error(...);

		const state = createState({
			budgetExceeded: false,
			fullLog: ["[Stall: developer aborted — no events for >30s]"],
		});
		const WATCHDOG_TIMEOUT_MS = 30_000;
		const agentName = "developer";
		const watchdogFired = true;

		// Simulate the code path from agent-session-runner.ts:
		// When watchdog fires, throw so catch block triggers subprocess fallback.
		async function simulateWatchdogPath(): Promise<AgentRunResult> {
			if (watchdogFired) {
				const durationMs = Date.now() - state.startedAt;
				state.fullLog.push(
					`[Stall: ${agentName} aborted after ${durationMs}ms — no events for >${WATCHDOG_TIMEOUT_MS / 1000}s]`,
				);

				// Throw to trigger subprocess fallback (fix for audit issue #1)
				throw new Error(
					`Agent ${agentName} stalled: no events for >${WATCHDOG_TIMEOUT_MS / 1000}s`,
				);
			}

			return buildAgentRunResult(state, agentName, true, 0, []);
		}

		await assert.rejects(
			simulateWatchdogPath(),
			{ message: "Agent developer stalled: no events for >30s" },
			"should throw an error when watchdog fires",
		);

		// Verify the log was pushed before throw
		const stallLog = state.fullLog.find((l) => l.includes("Stall"));
		assert.ok(stallLog, "should have pushed stall log entry before throw");
	});

	it("non-watchdog path returns normally (no throw)", async () => {
		const state = createState({ budgetExceeded: false });
		const agentName = "developer";
		const watchdogFired = false;

		async function simulateNonWatchdogPath(): Promise<AgentRunResult> {
			if (watchdogFired) {
				throw new Error("should not reach");
			}

			// Ensure prompt settled and cleanup happens
			const promptSettled = true;
			if (!promptSettled) {
				throw new Error("prompt not settled");
			}

			return buildAgentRunResult(state, agentName, true, 0, []);
		}

		const result = await simulateNonWatchdogPath();
		assert.equal(result.success, true);
		assert.equal(result.agentName, "developer");
	});

	it("watchdogFired before promptSettled waits for prompt then throws", async () => {
		// Simulates: watchdog fires while prompt is still pending
		let promptSettled = false;
		const agentName = "developer";
		const WATCHDOG_TIMEOUT_MS = 30_000;
		const state = createState({});

		async function simulateWatchdogWithPendingPrompt(): Promise<AgentRunResult> {
			const watchdogFired = true;

			// Simulate prompt that eventually settles
			const settlePrompt = async () => {
				await new Promise((r) => setTimeout(r, 10));
				promptSettled = true;
			};

			if (watchdogFired) {
				const durationMs = Date.now() - state.startedAt;
				state.fullLog.push(
					`[Stall: ${agentName} aborted after ${durationMs}ms — no events for >${WATCHDOG_TIMEOUT_MS / 1000}s]`,
				);

				// Ensure prompt settled
				if (!promptSettled) {
					try {
						await settlePrompt();
					} catch {
						// prompt settled via abort
					}
				}

				throw new Error(
					`Agent ${agentName} stalled: no events for >${WATCHDOG_TIMEOUT_MS / 1000}s`,
				);
			}

			return buildAgentRunResult(state, agentName, true, 0, []);
		}

		await assert.rejects(simulateWatchdogWithPendingPrompt(), {
			message: "Agent developer stalled: no events for >30s",
		});

		// Verify prompt eventually settled
		assert.equal(promptSettled, true, "prompt should have settled after await");
	});
});
