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
import agentHarness from "./index.ts";
import { CASCADE_THRESHOLD, CACHE_TTL_TURNS } from "../../lib/harness-rules.ts";
import type { ToolCallResult } from "./index.ts";
import type { HarnessState } from "../../lib/harness-state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Helpers ──

function makeEvent(toolName: string, args: Record<string, unknown> = {}, isError = false) {
	return {
		toolName,
		input: args,
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

	it("currentTurn advances on cascade block (non-read tool)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Call write repeatedly until blocked by cascade
		let result: ToolCallResult | null = null;
		for (let i = 0; i < CASCADE_THRESHOLD; i++) {
			result = handler(makeEvent("write", { path: `file${i}.ts`, content: "" }), makeCtx());
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

	it("cascade blocks only after CASCADE_THRESHOLD consecutive calls (non-read tools)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// CASCADE_THRESHOLD - 1 calls → should NOT block
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			const result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
			assert.equal(result, null, `call ${i + 1}/${CASCADE_THRESHOLD - 1} should not block`);
		}

		// CASCADE_THRESHOLD-th call → should block
		const result = handler(makeEvent("write", { path: "block.ts", content: "" }), makeCtx());
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

// ── Integration tests (mock ExtensionAPI) ──

describe("agent-harness integration with mock ExtensionAPI", () => {
	function createMockAPI() {
		const handlers = new Map<string, (...args: any[]) => any>();
		const api = {
			handlers,
			on(event: any, handler: any) {
				handlers.set(event, handler);
			},
			fire(event: string, data: any, ctx?: any) {
				const handler = handlers.get(event);
				if (handler) return handler(data, ctx ?? {});
			},
			registerTool: () => {},
			registerCommand: () => {},
			registerShortcut: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			registerMessageRenderer: () => {},
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setLabel: () => {},
			exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "off" as any,
			setThinkingLevel: () => {},
			registerProvider: () => {},
			unregisterProvider: () => {},
			events: { on: () => {}, emit: () => {}, off: () => {} } as any,
		};
		return api as typeof api & ExtensionAPI;
	}

	it("registers session_start and tool_call handlers", () => {
		const api = createMockAPI();
		agentHarness(api);
		assert.ok(api.handlers.has("session_start"));
		assert.ok(api.handlers.has("tool_call"));
	});

	it("session_start creates fresh state — cascade resets", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// Fire 9 consecutive write events through api — cascade kicks in for NON-read tools
		// CASCADE_THRESHOLD = 8, so 7 pass and 8th (index 7) blocks
		for (let i = 0; i < 9; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "write",
				input: { path: `file${i}.ts`, content: "" },
			});
			// 8th call (0-indexed 7) should be blocked (cascade threshold = 8)
			if (i >= 7) {
				assert.ok(result?.block, `call ${i} should be blocked by cascade`);
			} else {
				// Through dispatch, null pass-through becomes undefined via ?? undefined
				assert.ok(result == null, `call ${i} should pass through`);
			}
		}

		// Now fire session_start to reset state
		await api.fire("session_start", { type: "session_start", reason: "new" });

		// After reset, a write should not be blocked
		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "reset",
			toolName: "write",
			input: { path: "fresh.ts", content: "" },
		});
		assert.ok(result == null, "after session_start, state should be fresh — no block");
	});

	it("correct pi event shape triggers read cache through full dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// First read — pass through
		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "test.ts" },
		});
		assert.ok(r1 == null, "first read should pass through");

		// Second read same path — cache hit, blocked
		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "test.ts" },
		});
		assert.ok(r2?.block, "second read same path should be blocked by cache");
	});

	it("bash grep mismatch through full dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "| grep foo" },
		});
		assert.ok(result?.block, "bash grep should be blocked");
		assert.ok(result!.reason.includes("ripgrep_search"), "should suggest ripgrep_search");
	});

	it("undefined toolName in full dispatch returns null and doesn't block subsequent calls", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// Fire event without toolName
		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			input: { path: "x.ts" }, // no toolName key
		});
		assert.ok(r1 == null, "undefined toolName should return null/undefined");

		// Fire read — should work normally, not blocked by undefined's cascade count
		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "a.ts" },
		});
		assert.ok(r2 == null, "read should work normally after undefined toolName");
	});

	it("cross-type mixed sequence no false cascade", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// Fire 10 events alternating tools
		const sequence = [
			{ toolName: "read", input: { path: "a.ts" } },
			{ toolName: "bash", input: { command: "echo hi" } },
			{ toolName: "read", input: { path: "b.ts" } },
			{ toolName: "bash", input: { command: "echo there" } },
			{ toolName: "write", input: { path: "c.ts", content: "x" } },
			{ toolName: "read", input: { path: "d.ts" } },
			{ toolName: "bash", input: { command: "echo world" } },
			{ toolName: "write", input: { path: "e.ts", content: "y" } },
			{ toolName: "read", input: { path: "f.ts" } },
			{ toolName: "bash", input: { command: "echo done" } },
		];

		for (let i = 0; i < sequence.length; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				...sequence[i],
			});
			assert.ok(
				result == null,
				`mixed tools should not trigger cascade at step ${i} (${sequence[i].toolName})`,
			);
		}
	});

	it("isError event passthrough in full dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// Error event — should pass through (result null) but track error
		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "err.ts" },
			isError: true,
		});
		assert.ok(r1 == null, "error event should pass through");

		// Normal read — should work (only 1 error, not >=2)
		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "ok.ts" },
		});
		assert.ok(r2 == null, "read after single error should pass through");
	});

	// ── Bug 1 fix: ask_user in PASS_THROUGH / TOOL_META ──

	it("Bug 1 fix: ask_user 15 consecutive calls does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		for (let i = 0; i < 15; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "ask_user",
				input: { question: `Q${i}?` },
			});
			assert.ok(result == null, `ask_user call ${i} should NOT be blocked`);
		}
	});

	it("structural_search 15 consecutive calls does NOT block (pass-through)", async () => {
		const api = createMockAPI();
		agentHarness(api);

		for (let i = 0; i < 15; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "structural_search",
				input: { pattern: "test", language: "ts" },
			});
			assert.ok(result == null, `structural_search call ${i} should NOT be blocked`);
		}
	});

	// ── Bug 2 fix: cat with redirect not blocked ──

	it("Bug 2 fix: bash cat with redirect (cat > file) does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "cat > /tmp/foo << EOF" },
		});
		assert.ok(result == null, "cat with write redirect should NOT block");
	});

	it("Bug 2 fix: bash cat with append redirect (cat >>) does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "cat >> file << EOF" },
		});
		assert.ok(result == null, "cat with append redirect should NOT block");
	});

	it("Bug 2 fix: bash cat file1 file2 > combined does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "cat file1.ts file2.ts > combined.ts" },
		});
		assert.ok(result == null, "cat concat with redirect should NOT block");
	});

	it("Bug 2 fix: bash cat README.md STILL blocks (file read)", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "cat README.md" },
		});
		assert.ok(result?.block, "cat README.md (file read) should STILL block");
	});

	// ── Bug 3 fix: head/tail in pipe not blocked ──

	it("Bug 3 fix: ls -la | head -5 does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "ls -la | head -5" },
		});
		assert.ok(result == null, "head in pipe should NOT block");
	});

	it("Bug 3 fix: ls -la | tail -10 does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "ls -lt | tail -10" },
		});
		assert.ok(result == null, "tail in pipe should NOT block");
	});

	it("Bug 3 fix: head -5 file STILL blocks (first cmd file read)", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "head -5 file" },
		});
		assert.ok(result?.block, "head as first cmd should STILL block");
	});

	// ── Bug 4 fix: quoted args not triggering false positives ──

	it("Bug 4 fix: gh issue --body '...| grep...' does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "gh issue create --body '...| grep...'" },
		});
		assert.ok(result == null, "grep pattern in quoted body should NOT block");
	});

	it("Bug 4 fix: gh issue --title '... cat ...' does NOT block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: 'gh issue create --title "... cat ..."' },
		});
		assert.ok(result == null, "cat pattern in quoted title should NOT block");
	});

	// ── Bug 5 fix: blocked calls should NOT increment cascade counter ──

	it("Bug 5 fix: blocked bash call does NOT increment cascade counter", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// Blocked call (cat README.md)
		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "cat README.md" },
		});

		// Legitimate call — should count as first, not second, since blocked didn't count
		let result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "bash",
			input: { command: "echo hello" },
		});
		assert.ok(result == null, "legitimate call after blocked should pass");

		// 7 more legitimate calls — 8th total (i=9) should block
		for (let i = 3; i <= 9; i++) {
			result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "echo hi" },
			});
			if (i < 9) {
				assert.ok(result == null, `legitimate call ${i} should pass`);
			} else {
				assert.ok(result?.block, `8th legitimate call should be blocked by cascade`);
			}
		}
	});

	it("Bug 5 fix: blocked read cache does NOT increment cascade counter", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// First read passes
		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "test.ts" },
		});

		// Second read same path — blocked by cache
		const blocked = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "test.ts" },
		});
		assert.ok(blocked?.block, "second read same path should be blocked");

		// Third read different path — should pass (counter not incremented by blocked)
		const pass = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "3",
			toolName: "read",
			input: { path: "other.ts" },
		});
		assert.ok(pass == null, "read after blocked cache hit should pass");
	});
});
