// ─── Tests: session-result.ts — Phase 4 truncation ────────────────
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentRunResult, buildRawOutputFromMessages } from "../session/result.ts";
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

function makeToolUse(
	name: string,
	inputObj: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "tool_use",
		name,
		input: inputObj,
	};
}

function makeToolResult(content: string, toolName?: string): Record<string, unknown> {
	return {
		type: "tool_result",
		content: [{ type: "text", text: content }],
		toolName: toolName || "read_file",
	};
}

function makeTextBlock(text: string): Record<string, unknown> {
	return { type: "text", text };
}

function makeThinkingBlock(thinking: string): Record<string, unknown> {
	return { type: "thinking", thinking };
}

// ─── buildRawOutputFromMessages ───────────────────────────────────

describe("buildRawOutputFromMessages — truncation (Phase 4)", () => {
	it("empty messages array returns empty string", () => {
		assert.equal(buildRawOutputFromMessages([]), "");
	});

	it("null/undefined messages array returns empty string", () => {
		assert.equal(buildRawOutputFromMessages(null as any), "");
		assert.equal(buildRawOutputFromMessages(undefined as any), "");
	});

	it("tool_use.input < 500 chars passed through verbatim", () => {
		const messages = [
			{
				role: "assistant",
				content: [makeToolUse("read", { path: "/short/path.txt" })],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("/short/path.txt"), "short input should pass through");
	});

	it("tool_use.input > 500 chars truncated with overflow indicator", () => {
		const longStr = "x".repeat(600);
		const messages = [
			{
				role: "assistant",
				content: [makeToolUse("read", { path: longStr })],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Should be truncated
		assert.ok(output.length < 3000, "output should be truncated");
		// Should contain overflow indicator
		assert.ok(
			output.includes("+") || output.includes("…") || output.includes("truncated"),
			`output should contain overflow indicator, got: ${output.slice(500, 600)}`,
		);
		// Total output should still contain the tool name
		assert.ok(output.includes("read"), "tool name should still be present");
	});

	it("tool_result.content < 2000 chars passed through verbatim", () => {
		const messages = [
			{
				role: "user",
				content: [makeToolResult("short result")],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("short result"), "short content should pass through");
	});

	it("tool_result.content > 2000 chars truncated with overflow indicator", () => {
		const longContent = "y".repeat(2500);
		const messages = [
			{
				role: "user",
				content: [makeToolResult(longContent)],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Should contain the truncation note
		assert.ok(
			output.includes("+") ||
				output.includes("more chars") ||
				output.includes("truncated") ||
				output.includes("…"),
			`output should contain overflow indicator, length: ${output.length}`,
		);
		assert.ok(output.length < 5000, "output should be significantly truncated");
	});

	it("total rawOutput > 100K chars truncated after last complete message boundary", () => {
		const largeBlock = makeTextBlock("A".repeat(120000));
		const messages = [
			{
				role: "assistant",
				content: [largeBlock],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Output should be <= 100K + a small buffer for the role header
		assert.ok(
			output.length <= 101000,
			`output length ${output.length} should be near or under 100K limit`,
		);
	});

	it("messages with empty content arrays produces empty output", () => {
		const messages = [
			{ role: "assistant", content: [] },
			{ role: "user", content: [] },
		];
		const output = buildRawOutputFromMessages(messages);
		assert.equal(output, "", "empty content arrays should produce no output");
	});

	it("non-string tool_use.input (object) — JSON.stringify before truncation", () => {
		const messages = [
			{
				role: "assistant",
				content: [makeToolUse("edit", { file: "test.ts", content: "nested object" })],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("test.ts"), "should contain stringified content");
		assert.ok(output.includes("nested object"), "should contain stringified content");
	});

	it("tool_result.content as string (not array) — truncation still applied", () => {
		const longStr = "z".repeat(3000);
		const messages = [
			{
				role: "user",
				toolName: "bash",
				content: [makeToolResult(longStr, "bash")],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		// Content should be truncated
		assert.ok(output.includes("TOOL_RESULT: bash"), "tool result header should appear");
		assert.ok(output.includes("+") || output.includes("..."), "truncation indicator should appear");
	});

	it("thinking blocks passed through as-is", () => {
		const messages = [
			{
				role: "assistant",
				content: [makeThinkingBlock("deep thought process")],
			},
		];
		const output = buildRawOutputFromMessages(messages);
		assert.ok(output.includes("deep thought process"), "thinking content should pass through");
		assert.ok(output.includes("THINKING"), "thinking header should appear");
	});
});

// ─── buildAgentRunResult — budgetExceeded propagation ─────────────

describe("buildAgentRunResult — budgetExceeded propagation", () => {
	it("includes budgetExceeded from state when true", () => {
		const state = createState({
			budgetExceeded: true,
			budgetExceededReason: "Tool limit",
			toolCount: 30,
			maxToolCalls: 30,
		});
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, true);
	});

	it("does not set budgetExceeded when state has false", () => {
		const state = createState({ budgetExceeded: false });
		const result = buildAgentRunResult(state, "developer", true, 1000, []);
		assert.equal(result.budgetExceeded, undefined);
	});
});
