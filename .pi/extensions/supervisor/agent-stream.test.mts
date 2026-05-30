// ─── Tests: agent-stream.ts — Phase 1 budget check + Phase 3 dedup fix ──
// Tests for processJsonLine, covering message_end budget check
// and text_end/thinking_end dedup flag fix via JSON line interface.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processJsonLine } from "./agent-stream.ts";
import type { AgentRunState } from "./types";

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
	it("text_end sets textPushedThisTurn=true even when liveText is empty", () => {
		const state = createState();
		state.liveText = "";
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}),
			state,
		);
		assert.equal(state.textPushedThisTurn, true, "flag should be set even when buffer empty");
		assert.equal(state.liveText, "", "liveText should be cleared");
	});

	it("thinking_end sets thinkingPushedThisTurn=true even when liveThinking is empty", () => {
		const state = createState();
		state.liveThinking = "";
		processJsonLine(
			JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}),
			state,
		);
		assert.equal(state.thinkingPushedThisTurn, true, "flag should be set even when buffer empty");
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
