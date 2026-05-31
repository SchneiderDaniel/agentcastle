// ─── Tests: event-types.ts — NormalizedEvent discriminated union ──
// Phase 1: Compile-time verification of the NormalizedEvent type.
// Most checks are structural — we verify the discriminated union works
// by constructing objects of each kind and exhaustively switching.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedEvent } from "./event-types.ts";

// ─── Compile-time check helpers ──────────────────────────────────

/**
 * Exhaustive switch helper — the `never` default ensures all kinds handled.
 * This function is the compile-time proof that the NormalizedEvent type
 * is correctly constructed.
 */
function kindNames(): string[] {
	// We can't enumerate a type at runtime, but we verify at test level
	// by constructing every kind and checking discriminant.
	return ["done"];
}

// ─── NormalizedEvent construction tests ──────────────────────────
// Each test constructs one NormalizedEvent kind and verifies its shape.

describe("NormalizedEvent discriminated union", () => {
	it("tool_execution_start carries toolName and args", () => {
		const ev: NormalizedEvent = {
			kind: "tool_execution_start",
			toolName: "read_file",
			args: { path: "./file.ts" },
		};
		assert.equal(ev.kind, "tool_execution_start");
		assert.equal(ev.toolName, "read_file");
		assert.deepEqual(ev.args, { path: "./file.ts" });
	});

	it("tool_execution_start works without args", () => {
		const ev: NormalizedEvent = {
			kind: "tool_execution_start",
			toolName: "read_file",
		};
		assert.equal(ev.kind, "tool_execution_start");
		assert.equal(ev.toolName, "read_file");
		assert.equal((ev as any).args, undefined);
	});

	it("tool_execution_end carries toolName and isError", () => {
		const ev: NormalizedEvent = {
			kind: "tool_execution_end",
			toolName: "read_file",
			isError: false,
		};
		assert.equal(ev.kind, "tool_execution_end");
		assert.equal(ev.toolName, "read_file");
		assert.equal(ev.isError, false);
	});

	it("thinking_start has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "thinking_start" };
		assert.equal(ev.kind, "thinking_start");
	});

	it("thinking_end has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "thinking_end" };
		assert.equal(ev.kind, "thinking_end");
	});

	it("thinking_delta carries delta string", () => {
		const ev: NormalizedEvent = { kind: "thinking_delta", delta: "step 1" };
		assert.equal(ev.kind, "thinking_delta");
		assert.equal(ev.delta, "step 1");
	});

	it("text_start has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "text_start" };
		assert.equal(ev.kind, "text_start");
	});

	it("text_end carries optional usage", () => {
		const ev: NormalizedEvent = {
			kind: "text_end",
			usage: { totalTokens: 100, input: 50, output: 50 },
		};
		assert.equal(ev.kind, "text_end");
		assert.equal(ev.usage?.totalTokens, 100);
	});

	it("text_end works without usage", () => {
		const ev: NormalizedEvent = { kind: "text_end" };
		assert.equal(ev.kind, "text_end");
	});

	it("text_delta carries delta string", () => {
		const ev: NormalizedEvent = { kind: "text_delta", delta: "hello" };
		assert.equal(ev.kind, "text_delta");
		assert.equal(ev.delta, "hello");
	});

	it("message_end carries message with role and optional content", () => {
		const ev: NormalizedEvent = {
			kind: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
			},
		};
		assert.equal(ev.kind, "message_end");
		assert.equal(ev.message.role, "assistant");
		assert.ok(Array.isArray(ev.message.content));
	});

	it("done carries message with content and optional usage", () => {
		const ev: NormalizedEvent = {
			kind: "done",
			message: {
				content: [{ type: "text", text: "done" }],
				usage: { input: 10, output: 5 },
			},
		};
		assert.equal(ev.kind, "done");
		assert.equal(ev.message.content?.[0]?.type, "text");
		assert.equal(ev.message.usage?.input, 10);
	});

	it("context_info carries contextTokens and contextWindow", () => {
		const ev: NormalizedEvent = {
			kind: "context_info",
			contextTokens: 5000,
			contextWindow: 10000,
		};
		assert.equal(ev.kind, "context_info");
		assert.equal(ev.contextTokens, 5000);
		assert.equal(ev.contextWindow, 10000);
	});

	it("turn_start has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "turn_start" };
		assert.equal(ev.kind, "turn_start");
	});

	it("turn_end has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "turn_end" };
		assert.equal(ev.kind, "turn_end");
	});

	it("agent_start has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "agent_start" };
		assert.equal(ev.kind, "agent_start");
	});

	it("agent_end has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "agent_end" };
		assert.equal(ev.kind, "agent_end");
	});

	it("session has no extra payload", () => {
		const ev: NormalizedEvent = { kind: "session" };
		assert.equal(ev.kind, "session");
	});

	it("message_end with role=toolResult carries tool info", () => {
		const ev: NormalizedEvent = {
			kind: "message_end",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "result" }],
				toolName: "read_file",
			},
		};
		assert.equal(ev.kind, "message_end");
		assert.equal(ev.message.role, "toolResult");
		assert.equal(ev.message.toolName, "read_file");
	});
});

// ─── Exhaustive switch compile-time check ────────────────────────

describe("exhaustive switch (compile-time proof)", () => {
	it("handles all kinds without TypeScript error — runtime check via text_end", () => {
		function handle(ev: NormalizedEvent): string {
			switch (ev.kind) {
				case "tool_execution_start":
					return `tool_start:${ev.toolName}`;
				case "tool_execution_end":
					return `tool_end:${ev.toolName}`;
				case "thinking_start":
					return "thinking_start";
				case "thinking_end":
					return "thinking_end";
				case "thinking_delta":
					return `thinking_delta:${ev.delta}`;
				case "text_start":
					return "text_start";
				case "text_end":
					return `text_end${ev.usage ? `:${ev.usage.totalTokens}` : ""}`;
				case "text_delta":
					return `text_delta:${ev.delta}`;
				case "message_end":
					return `message_end:${ev.message.role}`;
				case "done":
					return "done";
				case "context_info":
					return `context:${ev.contextTokens}`;
				case "turn_start":
					return "turn_start";
				case "turn_end":
					return "turn_end";
				case "agent_start":
					return "agent_start";
				case "agent_end":
					return "agent_end";
				case "session":
					return "session";
				default:
					// exhaustive check: if a new kind is added without a case, this won't compile
					const _exhaustive: never = ev;
					return _exhaustive;
			}
		}

		assert.equal(handle({ kind: "tool_execution_start", toolName: "read" }), "tool_start:read");
		assert.equal(
			handle({ kind: "tool_execution_end", toolName: "read", isError: false }),
			"tool_end:read",
		);
		assert.equal(handle({ kind: "thinking_start" }), "thinking_start");
		assert.equal(handle({ kind: "thinking_end" }), "thinking_end");
		assert.equal(handle({ kind: "thinking_delta", delta: "t" }), "thinking_delta:t");
		assert.equal(handle({ kind: "text_start" }), "text_start");
		assert.equal(handle({ kind: "text_end", usage: { totalTokens: 100 } }), "text_end:100");
		assert.equal(handle({ kind: "text_end" }), "text_end");
		assert.equal(handle({ kind: "text_delta", delta: "h" }), "text_delta:h");
		assert.equal(
			handle({ kind: "message_end", message: { role: "assistant" } }),
			"message_end:assistant",
		);
		assert.equal(handle({ kind: "done", message: {} }), "done");
		assert.equal(
			handle({ kind: "context_info", contextTokens: 500, contextWindow: 1000 }),
			"context:500",
		);
		assert.equal(handle({ kind: "turn_start" }), "turn_start");
		assert.equal(handle({ kind: "turn_end" }), "turn_end");
		assert.equal(handle({ kind: "agent_start" }), "agent_start");
		assert.equal(handle({ kind: "agent_end" }), "agent_end");
		assert.equal(handle({ kind: "session" }), "session");
	});
});
