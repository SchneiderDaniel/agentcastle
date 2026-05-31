// ─── Tests: event-handlers.ts — shared handler functions ──────────
// Phase 2: Each handler is a standalone pure function.
// Tests mirror the scenarios from agent-stream.test.mts and
// session-events.test.mts but target the shared handlers directly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunState } from "./types";
import {
	handleToolExecutionStart,
	handleToolExecutionEnd,
	handleThinkingStart,
	handleThinkingDelta,
	handleThinkingEnd,
	handleTextStart,
	handleTextDelta,
	handleTextEnd,
	handleMessageEnd,
	handleDone,
	handleContextInfo,
	phasePriority,
} from "./event-handlers.ts";

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

// ─── phasePriority ────────────────────────────────────────────────

describe("phasePriority", () => {
	it("returns numeric priority: tool > thinking > text > idle", () => {
		assert.equal(phasePriority("tool"), 3);
		assert.equal(phasePriority("thinking"), 2);
		assert.equal(phasePriority("text"), 1);
		assert.equal(phasePriority("idle"), 0);
	});
});

// ─── handleToolExecutionStart ─────────────────────────────────────

describe("handleToolExecutionStart", () => {
	it("sets phase to tool, records tool name and args", () => {
		const state = createState();
		const result = handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "read_file",
			args: { path: "/x" },
		});
		assert.equal(state.phase, "tool");
		assert.equal(state.currentTool, "read_file");
		assert.ok(state.currentToolArgs);
		assert.equal(state.lastToolName, "read_file");
		assert.ok(state.fullLog.some((l) => l.includes("read_file")));
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("returns workingChange=false when already in tool phase", () => {
		const state = createState({ phase: "tool" });
		const result = handleToolExecutionStart(state, {
			kind: "tool_execution_start",
			toolName: "bash",
		});
		assert.equal(result.workingChange, false);
	});
});

// ─── handleToolExecutionEnd ───────────────────────────────────────

describe("handleToolExecutionEnd", () => {
	it("increments toolCount, resets tool state, sets phase idle", () => {
		const state = createState({ toolCount: 5, lastToolName: "read_file" });
		const result = handleToolExecutionEnd(state, {
			kind: "tool_execution_end",
			toolName: "read_file",
			isError: false,
		});
		assert.equal(state.toolCount, 6);
		assert.equal(state.currentTool, undefined);
		assert.equal(state.currentToolArgs, undefined);
		assert.equal(state.phase, "idle");
		assert.ok(state.fullLog.some((l) => l.includes("✓")));
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("marks error with ✗", () => {
		const state = createState();
		handleToolExecutionEnd(state, { kind: "tool_execution_end", toolName: "bash", isError: true });
		assert.ok(state.fullLog.some((l) => l.includes("✗")));
	});
});

// ─── handleThinkingStart ──────────────────────────────────────────

describe("handleThinkingStart", () => {
	it("resets thinkingPushedThisTurn flag", () => {
		const state = createState({ thinkingPushedThisTurn: true });
		const result = handleThinkingStart(state, { kind: "thinking_start" });
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});
});

// ─── handleTextStart ──────────────────────────────────────────────

describe("handleTextStart", () => {
	it("resets textPushedThisTurn flag", () => {
		const state = createState({ textPushedThisTurn: true });
		const result = handleTextStart(state, { kind: "text_start" });
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});
});

// ─── handleThinkingDelta ──────────────────────────────────────────

describe("handleThinkingDelta", () => {
	it("appends delta to liveThinking and pushes complete lines to log", () => {
		const state = createState();
		const result = handleThinkingDelta(state, {
			kind: "thinking_delta",
			delta: "step 1\nstep 2\n",
		});
		assert.equal(state.liveThinking, "");
		assert.ok(state.fullLog.some((l) => l.includes("step 1")));
		assert.ok(state.fullLog.some((l) => l.includes("step 2")));
		assert.equal(result.flush, true);
	});

	it("does nothing with empty delta", () => {
		const state = createState();
		const result = handleThinkingDelta(state, { kind: "thinking_delta", delta: "" });
		assert.equal(state.liveThinking, "");
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});
});

// ─── handleThinkingEnd ────────────────────────────────────────────

describe("handleThinkingEnd", () => {
	it("sets flag even when liveThinking is empty", () => {
		const state = createState();
		const result = handleThinkingEnd(state, { kind: "thinking_end" });
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.liveThinking, "");
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("pushes content when liveThinking has data", () => {
		const state = createState({ liveThinking: "deep thought" });
		handleThinkingEnd(state, { kind: "thinking_end" });
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.liveThinking, "");
		assert.ok(state.thinkingOutputLines.length > 0);
	});
});

// ─── handleTextDelta ──────────────────────────────────────────────

describe("handleTextDelta", () => {
	it("appends delta and pushes complete lines to log", () => {
		const state = createState();
		const result = handleTextDelta(state, { kind: "text_delta", delta: "Hello\nWorld\n" });
		assert.equal(state.liveText, "");
		assert.ok(state.fullLog.some((l) => l === "Hello"));
		assert.ok(state.fullLog.some((l) => l === "World"));
		assert.equal(result.flush, true);
	});

	it("does nothing with empty delta", () => {
		const state = createState();
		const result = handleTextDelta(state, { kind: "text_delta", delta: "" });
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});
});

// ─── handleTextEnd ────────────────────────────────────────────────

describe("handleTextEnd", () => {
	it("sets flag even when liveText is empty", () => {
		const state = createState();
		const result = handleTextEnd(state, { kind: "text_end" });
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.liveText, "");
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("pushes content when liveText has data", () => {
		const state = createState({ liveText: "some output" });
		handleTextEnd(state, { kind: "text_end" });
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "some output");
	});

	it("updates tokenCount from usage", () => {
		const state = createState();
		handleTextEnd(state, {
			kind: "text_end",
			usage: { totalTokens: 100, input: 40, output: 60 },
		});
		assert.equal(state.tokenCount, 100);
	});

	it("handles usage via input+output fallback", () => {
		const state = createState();
		handleTextEnd(state, {
			kind: "text_end",
			usage: { input: 30, output: 20 },
		});
		assert.equal(state.tokenCount, 50);
	});
});

// ─── handleMessageEnd ─────────────────────────────────────────────

describe("handleMessageEnd", () => {
	it("processes assistant role: pushes thinking to fullLog and text to textOutputLines", () => {
		const state = createState();
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "deep" },
					{ type: "text", text: "answer" },
				],
			},
		});
		assert.equal(state.textOutputLines[0], "answer");
		// thinking at message_end goes to fullLog (with 💭 prefix), not thinkingOutputLines
		assert.ok(state.fullLog.some((l) => l.includes("💭") && l.includes("deep")));
		// Flags are RESET at the end of message_end (end of turn)
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.textPushedThisTurn, false);
	});

	it("processes toolResult role: pushes tool result log", () => {
		const state = createState({ lastToolName: "read_file" });
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "file content" }],
				toolName: "read_file",
			},
		});
		assert.ok(state.fullLog.some((l) => l.includes("📋")));
	});

	it("checks budget: tool call limit", () => {
		const state = createState({ toolCount: 30, maxToolCalls: 30 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("30"));
	});

	it("checks budget: token budget", () => {
		const state = createState({ tokenCount: 500000, agentTokenBudget: 500000 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.budgetExceeded, true);
		assert.ok(state.budgetExceededReason?.includes("500000"));
	});

	it("does not set budgetExceeded when both limits are 0", () => {
		const state = createState({ toolCount: 100, tokenCount: 999999 });
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.budgetExceeded, false);
	});

	it("resets turn flags and phase to idle", () => {
		const state = createState({
			thinkingPushedThisTurn: true,
			textPushedThisTurn: true,
			phase: "tool",
		});
		handleMessageEnd(state, {
			kind: "message_end",
			message: { role: "assistant", content: [] },
		});
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.phase, "idle");
	});

	it("updates tokenCount from usage", () => {
		const state = createState();
		handleMessageEnd(state, {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [],
				usage: { totalTokens: 200, input: 100, output: 100 },
			},
		});
		assert.equal(state.tokenCount, 200);
	});
});

// ─── handleDone ───────────────────────────────────────────────────

describe("handleDone", () => {
	it("processes text content and sets textPushedThisTurn", () => {
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "final answer" }],
			},
		});
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.textOutputLines[0], "final answer");
	});

	it("processes thinking content and sets thinkingPushedThisTurn", () => {
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "thinking", thinking: "deep thought" }],
			},
		});
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.ok(state.thinkingOutputLines[0]?.includes("deep thought"));
	});

	it("updates tokenCount from usage", () => {
		const state = createState();
		handleDone(state, {
			kind: "done",
			message: {
				usage: { input: 100, output: 50 },
			},
		});
		assert.equal(state.tokenCount, 150);
	});

	it("skips text push when textPushedThisTurn is already true", () => {
		const state = createState({ thinkingPushedThisTurn: true, textPushedThisTurn: true });
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "should not appear" }],
			},
		});
		assert.equal(state.textOutputLines.length, 0);
	});

	it("clears liveText and liveThinking", () => {
		const state = createState({ liveText: "buffer", liveThinking: "thought" });
		handleDone(state, {
			kind: "done",
			message: {
				content: [{ type: "text", text: "result" }],
			},
		});
		assert.equal(state.liveText, "");
		assert.equal(state.liveThinking, "");
	});

	it("sets phase to idle", () => {
		const state = createState({ phase: "tool" });
		handleDone(state, {
			kind: "done",
			message: { content: [{ type: "text", text: "result" }] },
		});
		assert.equal(state.phase, "idle");
	});
});

// ─── handleContextInfo ────────────────────────────────────────────

describe("handleContextInfo", () => {
	it("sets context tokens and window", () => {
		const state = createState();
		const result = handleContextInfo(state, {
			kind: "context_info",
			contextTokens: 5000,
			contextWindow: 10000,
		});
		assert.equal(state.contextTokens, 5000);
		assert.equal(state.contextWindow, 10000);
		assert.equal(state.contextInfoReceived, true);
		assert.equal(result.flush, true);
	});

	it("returns flush=false when values are invalid (window=0)", () => {
		const state = createState();
		const result = handleContextInfo(state, {
			kind: "context_info",
			contextTokens: 0,
			contextWindow: 0,
		});
		assert.equal(result.flush, false);
		assert.equal(state.contextInfoReceived, false);
	});
});
