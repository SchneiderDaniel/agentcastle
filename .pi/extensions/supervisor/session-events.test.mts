// ─── Tests: session-events.ts ────────────────────────────────────────
// Tests for processSessionEvent, focusing on the done handler
// dedup fix: textPushedThisTurn/thinkingPushedThisTurn flagging.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processSessionEvent } from "./session-events.ts";
import type { AgentRunState } from "./types";

// ─── Helpers ──────────────────────────────────────────────────────

function createState(): AgentRunState {
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
	};
}

// ─── Phase 1: fix effect — dedup flags set in done handler ─────────────────

describe("done handler — dedup flag fix", () => {
	it("sets textPushedThisTurn=true and clears liveText when done has text content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "text", text: "hello" }],
				},
			},
		};
		const result = processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, true, "textPushedThisTurn should be true");
		assert.equal(state.liveText, "", "liveText should be cleared");
		assert.equal(state.textOutputLines[0], "hello", "text output should be pushed");
		assert.equal(result.flush, true);
		assert.equal(result.workingChange, true);
	});

	it("sets thinkingPushedThisTurn=true and clears liveThinking when done has thinking content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "thinking", thinking: "deep thought" }],
				},
			},
		};
		const result = processSessionEvent(ev, state);
		assert.equal(state.thinkingPushedThisTurn, true, "thinkingPushedThisTurn should be true");
		assert.equal(state.liveThinking, "", "liveThinking should be cleared");
		assert.ok(
			state.thinkingOutputLines[0]?.includes("deep thought"),
			`thinking output should be pushed, got: ${state.thinkingOutputLines[0]}`,
		);
		assert.equal(result.flush, true);
	});

	it("sets both flags and clears both buffers with mixed text + thinking content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [
						{ type: "text", text: "hello" },
						{ type: "thinking", thinking: "deep thought" },
					],
				},
			},
		};
		const result = processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.thinkingPushedThisTurn, true);
		assert.equal(state.liveText, "");
		assert.equal(state.liveThinking, "");
		assert.equal(state.textOutputLines[0], "hello");
		assert.ok(state.thinkingOutputLines[0]?.includes("deep thought"));
	});

	it("does not set flags when content array is empty (no false positive)", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [],
				},
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, false, "should remain false");
		assert.equal(state.thinkingPushedThisTurn, false, "should remain false");
		assert.equal(state.textOutputLines.length, 0);
		assert.equal(state.thinkingOutputLines.length, 0);
	});

	it("does not crash and does not change flags when message is undefined", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: undefined,
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.thinkingPushedThisTurn, false);
	});

	it("updates tokenCount from usage, flags remain false when no content", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					usage: { input: 10, output: 5 },
				},
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.tokenCount, 15);
		assert.equal(state.textPushedThisTurn, false, "should remain false (no content)");
		assert.equal(state.thinkingPushedThisTurn, false, "should remain false (no content)");
	});

	it("pushes multi-line text correctly and sets flag, clears liveText", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "text", text: "line1\nline2\nline3" }],
				},
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, true);
		assert.equal(state.liveText, "");
		assert.equal(state.textOutputLines[0], "line1\nline2\nline3");
		// fullLog should contain 3 log entries (one per line)
		const logEntries = state.fullLog.filter((l) => l === "line1" || l === "line2" || l === "line3");
		assert.equal(logEntries.length, 3);
	});

	it("does not push empty/whitespace-only text, flags unchanged", () => {
		const state = createState();
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "text", text: "   " }],
				},
			},
		};
		processSessionEvent(ev, state);
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.textOutputLines.length, 0);
	});

	it("does not push thinking again when thinkingPushedThisTurn is already true from preceding thinking_end", () => {
		const state = createState();
		state.thinkingPushedThisTurn = true; // already pushed by thinking_end
		const ev = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "thinking", thinking: "deep thought" }],
				},
			},
		};
		processSessionEvent(ev, state);
		// thinking should NOT be pushed again
		assert.equal(state.thinkingOutputLines.length, 0, "should not push thinking again");
		assert.equal(state.thinkingPushedThisTurn, true, "flag should stay true");
	});
});

// ─── Phase 2: dedup chain — done then message_end produce no duplicate ─────

describe("dedup chain — done then message_end", () => {
	it("does not duplicate text content when message_end follows done", () => {
		const state = createState();

		// Step 1: done event
		const doneEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "text", text: "hello world" }],
				},
			},
		};
		processSessionEvent(doneEv, state);

		// Step 2: message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello world" }],
			},
		};
		processSessionEvent(endEv, state);

		assert.equal(state.textOutputLines.length, 1, "should have exactly 1 text entry");
		assert.equal(state.textOutputLines[0], "hello world");
		const textLinesInLog = state.fullLog.filter(
			(l) => l === "hello world" || l === "hello world (duplicate)",
		);
		// fullLog should have exactly 1 "hello world" entry (no duplicate)
		assert.equal(
			state.fullLog.filter((l) => l === "hello world").length,
			1,
			"fullLog should contain 'hello world' exactly once",
		);
	});

	it("does not duplicate thinking content when message_end follows done", () => {
		const state = createState();

		// Step 1: done event
		const doneEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [{ type: "thinking", thinking: "deep thought" }],
				},
			},
		};
		processSessionEvent(doneEv, state);

		// Step 2: message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "deep thought" }],
			},
		};
		processSessionEvent(endEv, state);

		assert.equal(state.thinkingOutputLines.length, 1, "should have exactly 1 thinking entry");
		// Flags should be false at end (reset by message_end)
		assert.equal(state.thinkingPushedThisTurn, false);
		assert.equal(state.textPushedThisTurn, false);
	});

	it("does not duplicate mixed content when message_end follows done", () => {
		const state = createState();

		// Step 1: done event
		const doneEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [
						{ type: "text", text: "hello" },
						{ type: "thinking", thinking: "deep thought" },
					],
				},
			},
		};
		processSessionEvent(doneEv, state);

		// Step 2: message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "thinking", thinking: "deep thought" },
				],
			},
		};
		processSessionEvent(endEv, state);

		assert.equal(state.textOutputLines.length, 1, "should have exactly 1 text entry");
		assert.equal(state.thinkingOutputLines.length, 1, "should have exactly 1 thinking entry");
	});

	it("message_end without prior done pushes content normally (fallback path works)", () => {
		const state = createState();
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello from message_end" }],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 1);
		assert.equal(state.textOutputLines[0], "hello from message_end");
	});

	it("message_end skips content push when flags already set (done already flushed)", () => {
		const state = createState();
		// Pre-set flags as if done already pushed
		state.textPushedThisTurn = true;
		state.thinkingPushedThisTurn = true;

		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "should not appear" },
					{ type: "thinking", thinking: "should not appear" },
				],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 0, "no text should be pushed");
		assert.equal(state.thinkingOutputLines.length, 0, "no thinking should be pushed");
		// Flags should be reset by message_end
		assert.equal(state.textPushedThisTurn, false);
		assert.equal(state.thinkingPushedThisTurn, false);
	});

	it("message_end does not re-push content already consumed by text_end/thinking_end streaming path", () => {
		const state = createState();
		// Simulate streaming path: text_end already set the flag
		state.textPushedThisTurn = true;
		state.thinkingPushedThisTurn = true;

		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "already streamed" },
					{ type: "thinking", thinking: "already streamed" },
				],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 0, "no duplicate from streaming path");
		assert.equal(state.thinkingOutputLines.length, 0, "no duplicate from streaming path");
	});
});

// ─── Phase 3: existing behavior preserved (regression) ────────────────────

describe("existing behavior preserved (regression)", () => {
	it("text_end (streaming) followed by message_end — one text entry, flag reset", () => {
		const state = createState();
		state.liveText = "streamed text";

		// text_end
		const textEndEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_end",
			},
		};
		processSessionEvent(textEndEv, state);
		assert.equal(state.textPushedThisTurn, true, "text_end should set flag");
		assert.equal(state.textOutputLines[0], "streamed text");

		// message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "streamed text" }],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.textOutputLines.length, 1, "no duplicate");
		assert.equal(state.textPushedThisTurn, false, "reset by message_end");
	});

	it("thinking_end (streaming) followed by message_end — one thinking entry, flag reset", () => {
		const state = createState();
		state.liveThinking = "streamed thinking";

		// thinking_end
		const thinkingEndEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_end",
			},
		};
		processSessionEvent(thinkingEndEv, state);
		assert.equal(state.thinkingPushedThisTurn, true, "thinking_end should set flag");
		assert.ok(state.thinkingOutputLines[0]?.includes("streamed thinking"));

		// message_end
		const endEv = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "streamed thinking" }],
			},
		};
		processSessionEvent(endEv, state);
		assert.equal(state.thinkingOutputLines.length, 1, "no duplicate");
		assert.equal(state.thinkingPushedThisTurn, false, "reset by message_end");
	});

	it("message_end with role=toolResult — unchanged behavior", () => {
		const state = createState();
		const endEv = {
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "read_file",
				content: [{ type: "text", text: "file contents here" }],
			},
		};
		processSessionEvent(endEv, state);
		// Should push a log entry for tool result
		const toolLog = state.fullLog.find((l) => l.includes("📋"));
		assert.ok(toolLog, "should have tool result log entry");
		assert.ok(toolLog?.includes("read_file"), "log should mention tool name");
	});

	it("message_end without message object — no crash, returns correct flags", () => {
		const state = createState();
		const endEv = {
			type: "message_end",
			message: undefined,
		};
		const result = processSessionEvent(endEv, state);
		assert.equal(result.flush, false);
		assert.equal(result.workingChange, false);
	});

	it("text_start still resets textPushedThisTurn to false", () => {
		const state = createState();
		// Pre-set flag true (as if previous content was pushed)
		state.textPushedThisTurn = true;

		const textStartEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_start",
			},
		};
		processSessionEvent(textStartEv, state);
		assert.equal(state.textPushedThisTurn, false, "text_start reset flag");
	});

	it("thinking_start still resets thinkingPushedThisTurn to false", () => {
		const state = createState();
		state.thinkingPushedThisTurn = true;

		const thinkingStartEv = {
			type: "message_update",
			assistantMessageEvent: {
				type: "thinking_start",
			},
		};
		processSessionEvent(thinkingStartEv, state);
		assert.equal(state.thinkingPushedThisTurn, false, "thinking_start reset flag");
	});
});
