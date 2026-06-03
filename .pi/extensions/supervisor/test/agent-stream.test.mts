// ─── Tests: agent-stream.ts — Phase 1 budget check + Phase 3 dedup fix ──
// Tests for processJsonLine, covering message_end budget check
// and text_end/thinking_end dedup flag fix via JSON line interface.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processJsonLine } from "../agent/stream.ts";
import type { AgentRunState } from "../config/types";

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

// ─── Phase 1: Budget check via JSON line message_end ────────────────

describe("processJsonLine — budget check at message_end (Phase 1)", () => {
	it("sets budgetExceeded when toolCount >= maxToolCalls", () => {
		const state = createState({ toolCount: 30, maxToolCalls: 30 });
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("30"));
	});

	it("sets budgetExceeded when tokenCount >= agentTokenBudget", () => {
		const state = createState({ tokenCount: 500000, agentTokenBudget: 500000 });
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("500000"));
	});

	it("sets budgetExceeded and reason covers both when both limits exceeded", () => {
		const state = createState({
			toolCount: 35,
			maxToolCalls: 30,
			tokenCount: 600000,
			agentTokenBudget: 500000,
		});
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason);
		assert.ok(state.budgetExceededReason!.includes("35"));
		assert.ok(state.budgetExceededReason!.includes("600000"));
	});

	it("does NOT set budgetExceeded when maxToolCalls=0 (unlimited) regardless of toolCount", () => {
		const state = createState({ toolCount: 100, maxToolCalls: 0 });
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, false);
		assert.equal(state.budgetExceededReason, undefined);
	});

	it("does NOT set budgetExceeded when toolCount < maxToolCalls and tokenCount < agentTokenBudget", () => {
		const state = createState({
			toolCount: 15,
			maxToolCalls: 30,
			tokenCount: 200000,
			agentTokenBudget: 500000,
		});
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, false);
	});

	it("budgetExceeded remains true when already set (idempotent)", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Previous check",
			toolCount: 30,
			maxToolCalls: 30,
		});
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [] },
			}),
			state,
		);
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason);
	});
});

// ─── Phase 3: Dedup flag fix via JSON line text_end/thinking_end ────

describe("processJsonLine — dedup flag fix (Phase 3)", () => {
	it("text_end leaves textPushedThisTurn=false when liveText is empty and no delta was pushed", () => {
		const state = createState();
		state.liveText = "";
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(state.textPushedThisTurn, false, "empty text_end must not block fallback capture");
		assert.equal(state.liveText, "", "liveText should be cleared");
	});

	it("thinking_end leaves thinkingPushedThisTurn=false when liveThinking is empty and no delta was pushed", () => {
		const state = createState();
		state.liveThinking = "";
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(
			state.thinkingPushedThisTurn,
			false,
			"empty thinking_end must not block fallback capture",
		);
		assert.equal(state.liveThinking, "", "liveThinking should be cleared");
	});

	it("text_end sets textPushedThisTurn=true when liveText has content (existing behavior preserved)", () => {
		const state = createState();
		state.liveText = "some text";
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "some text");
	});

	it("thinking_end sets thinkingPushedThisTurn=true when liveThinking has content (existing behavior preserved)", () => {
		const state = createState();
		state.liveThinking = "some thinking";
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true);
	});
});

// ─── Phase 2: Full streaming chain via JSON line — no duplicate output ─────

describe("processJsonLine — full streaming chain no duplicate (Phase 2)", () => {
	it('text_delta("Hello\\nWorld\\n") → text_end → message_end does not re-push to fullLog', () => {
		const state = createState();

		// Step 1: text_delta with complete lines via JSON
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "Hello\nWorld\n" },
			}),
			state,
		);
		assert.equal(state.liveText, "", "liveText empty after consuming newlines");
		assert.equal(state.fullLog.filter((l) => l === "Hello").length, 1, "fullLog has 'Hello' once");
		assert.equal(state.fullLog.filter((l) => l === "World").length, 1, "fullLog has 'World' once");

		// Step 2: text_end — flag set unconditionally even though buffer empty
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(state.textPushedThisTurn, true, "flag set unconditionally by text_end");

		// Step 3: message_end with full content — flag is true, so skip
		const fullLogLenBefore = state.fullLog.length;
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hello\nWorld" }],
				},
			}),
			state,
		);

		assert.equal(state.fullLog.length, fullLogLenBefore, "fullLog did not grow (no duplicates)");
		assert.equal(state.fullLog.filter((l) => l === "Hello").length, 1, "'Hello' still once");
		assert.equal(state.fullLog.filter((l) => l === "World").length, 1, "'World' still once");
	});

	it('thinking_delta("Step 1\\nStep 2\\n") → thinking_end → message_end does not re-push', () => {
		const state = createState();

		// Step 1: thinking_delta with complete lines
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "Step 1\nStep 2\n" },
			}),
			state,
		);
		assert.equal(state.liveThinking, "", "liveThinking empty after consuming newlines");
		assert.equal(
			state.fullLog.filter((l) => l.includes("Step 1")).length,
			1,
			"fullLog has 'Step 1' once",
		);
		assert.equal(
			state.fullLog.filter((l) => l.includes("Step 2")).length,
			1,
			"fullLog has 'Step 2' once",
		);

		// Step 2: thinking_end — flag set unconditionally
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true, "flag set even though buffer empty");

		// Step 3: message_end should NOT re-push
		const fullLogLenBefore = state.fullLog.length;
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "Step 1\nStep 2" }],
				},
			}),
			state,
		);

		assert.equal(state.fullLog.length, fullLogLenBefore, "fullLog did not grow (no duplicates)");
	});

	it("mixed text + thinking via JSON — both flags block message_end", () => {
		const state = createState();

		// Thinking phase: start → delta → end
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_start" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "t1\nt2\n" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true);

		// Text phase: start → delta → end
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_start" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "r1\nr2\n" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(state.textPushedThisTurn, true);

		// message_end — both flags set, should NOT add to fullLog
		const fullLogLenBefore = state.fullLog.length;
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "t1\nt2" },
						{ type: "text", text: "r1\nr2" },
					],
				},
			}),
			state,
		);

		assert.equal(state.fullLog.length, fullLogLenBefore, "no duplicates from message_end");
		assert.equal(state.textOutputLines.length, 0, "no text output (buffer was empty at text_end)");
		assert.equal(
			state.thinkingOutputLines.length,
			0,
			"no thinking output (buffer was empty at thinking_end)",
		);
	});
});

// ─── Phase 3: Multi-turn dedup via JSON line — fullLog grows linearly ─────

describe("processJsonLine — multi-turn dedup (Phase 3)", () => {
	it("two turns of complete-line JSON — no duplicates", () => {
		const state = createState();

		// Turn 1
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_start" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "A\nB\n" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "A\nB" }],
				},
			}),
			state,
		);

		// Turn 2
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_start" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "C\nD\n" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		processJsonLine(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "C\nD" }],
				},
			}),
			state,
		);

		assert.equal(state.fullLog.filter((l) => l === "A").length, 1, "'A' once");
		assert.equal(state.fullLog.filter((l) => l === "B").length, 1, "'B' once");
		assert.equal(state.fullLog.filter((l) => l === "C").length, 1, "'C' once");
		assert.equal(state.fullLog.filter((l) => l === "D").length, 1, "'D' once");
	});

	it("ten turns of complete-line JSON — fullLog grows linearly (10×2=20 lines)", () => {
		const state = createState();

		for (let turn = 0; turn < 10; turn++) {
			processJsonLine(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_start" },
				}),
				state,
			);
			processJsonLine(
				JSON.stringify({
					type: "message_update",
					delta: {
						type: "text_delta",
						text_delta: `turn ${turn} A\nturn ${turn} B\n`,
					},
				}),
				state,
			);
			processJsonLine(
				JSON.stringify({
					type: "message_update",
					delta: { type: "text_end" },
				}),
				state,
			);
			processJsonLine(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `turn ${turn} A\nturn ${turn} B` }],
					},
				}),
				state,
			);
		}

		assert.equal(state.fullLog.length, 20, "fullLog has 20 entries (10×2)");
		for (let turn = 0; turn < 10; turn++) {
			assert.equal(
				state.fullLog.filter((l) => l === `turn ${turn} A`).length,
				1,
				`turn ${turn} A once`,
			);
			assert.equal(
				state.fullLog.filter((l) => l === `turn ${turn} B`).length,
				1,
				`turn ${turn} B once`,
			);
		}
	});
});
