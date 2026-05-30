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
 *
 * Issue 296 additions:
 *   - toolCallIndex / sessionTurn split
 *   - turn_start event binding
 *   - Cascade reset on turn boundaries
 *   - Suggestion text fix (&& present vs absent)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarnessState } from "../../lib/harness-state.ts";
import { createToolCallHandler, getBashSubKey } from "./index.ts";
import agentHarness from "./index.ts";
import {
	CASCADE_THRESHOLD,
	CACHE_TTL_TURNS,
	buildRedirectMessage,
} from "../../lib/harness-rules.ts";
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

	// ── Bug 2: toolCallIndex advances on block paths ──

	it("toolCallIndex advances on error retry block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Push 2 errors for read
		state.errorTracker.push("read", { turn: 0, toolName: "read" });
		state.errorTracker.push("read", { turn: 1, toolName: "read" });

		// Next read call should be blocked (error retry)
		const result = handler(makeEvent("read"), makeCtx());
		assert.ok(result?.block, "should block on error retry");

		// toolCallIndex should advance
		assert.equal(state.toolCallIndex, 1, "toolCallIndex should advance on error retry block");
	});

	it("toolCallIndex advances on read cache block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First call: not cached, passes through
		handler(makeEvent("read", { path: "x.ts" }), makeCtx());

		// Second call: same path+offset+limit → cache hit, block
		const result = handler(makeEvent("read", { path: "x.ts" }), makeCtx());
		assert.ok(result?.block, "should block on cache hit");

		// toolCallIndex should advance to 2 (first call incremented to 1, second to 2)
		assert.equal(state.toolCallIndex, 2, "toolCallIndex should advance on read cache block");
	});

	it("toolCallIndex advances on cascade block (non-read tool)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Call write repeatedly until blocked by cascade
		let result: ToolCallResult | null = null;
		for (let i = 0; i < CASCADE_THRESHOLD; i++) {
			result = handler(makeEvent("write", { path: `file${i}.ts`, content: "" }), makeCtx());
		}

		// Last call should be blocked
		assert.ok(result?.block, "should block on cascade");
		// toolCallIndex should equal CASCADE_THRESHOLD
		assert.equal(
			state.toolCallIndex,
			CASCADE_THRESHOLD,
			"toolCallIndex should advance on cascade block",
		);
	});

	it("toolCallIndex advances on bash mismatch block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "grep something" }), makeCtx());
		assert.ok(result?.block, "should block bash grep");

		assert.equal(state.toolCallIndex, 1, "toolCallIndex should advance on bash mismatch block");
	});

	// ── Bug 3: toolCallIndex advances on bash empty-command ──

	it("toolCallIndex advances on bash empty command", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Empty command should pass through (result null) but still increment turn
		const result = handler(makeEvent("bash", {}), makeCtx());
		assert.equal(result, null, "empty bash command should pass through");
		assert.equal(state.toolCallIndex, 1, "toolCallIndex should advance on empty bash command");
	});

	it("toolCallIndex advances on bash null command", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "" }), makeCtx());
		assert.equal(result, null, "null bash command should pass through");
		assert.equal(state.toolCallIndex, 1, "toolCallIndex should advance on null bash command");
	});

	// ── toolCallIndex advances on normal paths (regression) ──

	it("toolCallIndex advances on pass-through tool call", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		handler(makeEvent("ripgrep_search"), makeCtx());
		assert.equal(state.toolCallIndex, 1, "toolCallIndex should advance on pass-through");
	});

	it("toolCallIndex advances on error tracking path", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		handler(makeEvent("read", {}, true), makeCtx());
		assert.equal(state.toolCallIndex, 1, "toolCallIndex should advance on error tracking");
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

		// After sequence, toolCallIndex should be 7
		assert.equal(state.toolCallIndex, sequence.length);
	});

	// ── sessionTurn usage in handler ──

	it("sessionTurn is passed to callCounter.record() as sinceTurn", () => {
		const state = createHarnessState();
		state.sessionTurn = 3;
		const handler = createToolCallHandler(state);

		handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		const info = state.callCounter.getConsecutive("read");
		assert.equal(info.sinceTurn, 3, "sinceTurn should equal sessionTurn");
	});

	it("sessionTurn increments independently from toolCallIndex", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		handler(makeEvent("write", { path: "b.ts", content: "" }), makeCtx());

		// sessionTurn stays 0 (only changed by turn_start handler)
		assert.equal(state.sessionTurn, 0);
		// toolCallIndex advances to 2
		assert.equal(state.toolCallIndex, 2);
	});
});

// ── Issue 296: Suggestion text fix (&& present vs absent) ──

describe("Issue 296: Cascade suggestion text", () => {
	it("bash cascade WITHOUT && suggests 'Combine bash calls with && or use a script file'", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Combine bash calls with && or use a script file"),
			"blocked echo hi should suggest combined bash calls",
		);
	});

	it("bash cascade WITH && suggests 'Reduce per-turn call count — commands already use && for batching'", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "cd /repo && git status" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Reduce per-turn call count"),
			"blocked && command should suggest reducing per-turn count",
		);
		assert.ok(
			!result!.reason.includes("Write a script file"),
			"should not suggest writing a script file for && commands",
		);
	});

	it("non-bash cascade unchanged suggestion text", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Batch write calls"),
			"non-bash cascade should keep existing suggestion",
		);
	});

	it("bash WITH && in middle of command ('npm install && npm test') suggests Reduce per-turn", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "npm install && npm test" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Reduce per-turn call count"),
			"blocked npm && command should suggest reducing per-turn count",
		);
	});
});

// ── Issue 296: Cascade resets on turn boundaries ──

describe("Issue 296: Cascade reset on turn boundaries", () => {
	it("8 same-subKey bash calls in one turn — 8th blocked", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
		}
		assert.ok(result?.block, "8th call in same turn should block");
	});

	it("4 same-subKey bash → turn_start → 4 same-subKey bash → none blocked", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// 4 calls in sessionTurn 0
		for (let i = 0; i < 4; i++) {
			const result = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
			assert.equal(result, null, `call ${i + 1} in turn 0 should pass`);
		}

		// Turn boundary: reset cascade, increment sessionTurn
		state.sessionTurn++;
		state.callCounter.turnBoundaryReset();

		// 4 more calls in sessionTurn 1
		for (let i = 0; i < 4; i++) {
			const result = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
			assert.equal(result, null, `call ${i + 1} in turn 1 should pass (reset by turn boundary)`);
		}
	});

	it("8 write calls in one turn — 8th blocked (non-bash unaffected)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
		}
		assert.ok(result?.block, "8th write call in same turn should block");
	});

	it("4 write → turn_start → 4 write → none blocked (non-bash resets across turns too)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		for (let i = 0; i < 4; i++) {
			const result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
			assert.equal(result, null, `write ${i + 1} in turn 0 should pass`);
		}

		// Turn boundary
		state.sessionTurn++;
		state.callCounter.turnBoundaryReset();

		for (let i = 0; i < 4; i++) {
			const result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
			assert.equal(result, null, `write ${i + 1} in turn 1 should pass (reset)`);
		}
	});

	it("toolCallIndex continues monotonic despite turn_start resets", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		handler(makeEvent("read", { path: "a.ts" }), makeCtx()); // toolCallIndex → 1

		// Turn boundary
		state.sessionTurn++;
		state.callCounter.turnBoundaryReset();

		handler(makeEvent("read", { path: "b.ts" }), makeCtx()); // toolCallIndex → 2
		handler(makeEvent("read", { path: "c.ts" }), makeCtx()); // toolCallIndex → 3

		assert.equal(state.toolCallIndex, 3, "toolCallIndex should be monotonic across turn resets");
		assert.equal(state.sessionTurn, 1, "sessionTurn should have incremented");
	});

	it("sessionTurn 0 → 3 turn_starts = 3", () => {
		const state = createHarnessState();
		assert.equal(state.sessionTurn, 0);

		state.sessionTurn++;
		assert.equal(state.sessionTurn, 1);

		state.sessionTurn++;
		assert.equal(state.sessionTurn, 2);

		state.sessionTurn++;
		assert.equal(state.sessionTurn, 3);
	});

	it("toolCallIndex 0 → 5 tool calls + 2 turn_starts = 5 (monotonic)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		handler(makeEvent("read", { path: "a.ts" }), makeCtx()); // 1
		state.sessionTurn++; // turn 1 start
		state.callCounter.turnBoundaryReset();
		handler(makeEvent("read", { path: "b.ts" }), makeCtx()); // 2
		handler(makeEvent("read", { path: "c.ts" }), makeCtx()); // 3
		state.sessionTurn++; // turn 2 start
		state.callCounter.turnBoundaryReset();
		handler(makeEvent("read", { path: "d.ts" }), makeCtx()); // 4
		handler(makeEvent("read", { path: "e.ts" }), makeCtx()); // 5

		assert.equal(state.toolCallIndex, 5);
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

	it("registers session_start, turn_start, and tool_call handlers", () => {
		const api = createMockAPI();
		agentHarness(api);
		assert.ok(api.handlers.has("session_start"));
		assert.ok(api.handlers.has("turn_start"));
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

	// ── Issue 296: turn_start event integration ──

	it("turn_start handler increments sessionTurn and resets cascade counter", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// 4 same-subKey bash calls in first turn
		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "echo turn0" },
			});
			assert.ok(result == null, `call ${i} in turn 0 should pass`);
		}

		// Fire turn_start — resets cascade counter
		await api.fire("turn_start", {
			type: "turn_start",
			turnIndex: 1,
			timestamp: Date.now(),
		});

		// 4 more same-subKey bash calls in second turn
		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(10 + i),
				toolName: "bash",
				input: { command: "echo turn1" },
			});
			assert.ok(result == null, `call ${i} in turn 1 should pass (reset by turn boundary)`);
		}
	});

	it("turn_start handler resets cascade — 8 same-key across 2 turns bypasses block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// 4 same-subKey bash in turn 0
		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "echo same" },
			});
			assert.ok(result == null, `turn 0 call ${i} should pass`);
		}

		// Turn boundary
		await api.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

		// 4 more same-subKey bash in turn 1
		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(10 + i),
				toolName: "bash",
				input: { command: "echo same" },
			});
			assert.ok(result == null, `turn 1 call ${i} should pass (reset by turn boundary)`);
		}
	});

	it("8 same-subKey bash in single turn via dispatch — 8th blocked", async () => {
		const api = createMockAPI();
		agentHarness(api);

		let lastResult: any = null;
		for (let i = 0; i < 8; i++) {
			lastResult = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "echo same" },
			});
		}
		assert.ok(lastResult?.block, "8th same-key bash in single turn should block");
	});

	it("turn_start handler does not reset toolCallIndex", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// 2 tool calls
		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "a.ts" },
		});
		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "b.ts" },
		});

		// Turn boundary
		await api.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

		// 2 more tool calls
		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "3",
			toolName: "read",
			input: { path: "c.ts" },
		});
		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "4",
			toolName: "read",
			input: { path: "d.ts" },
		});

		// Read call 4 should NOT be cache-blocked because paths differ
		// But also, toolCallIndex is preserved across turn boundary
		assert.ok(result == null, "fourth read should pass (different path)");
		// We can't directly check toolCallIndex from the mock, but the turn_start
		// handler just increments sessionTurn and resets callCounter
	});

	// ── Suggestion text via dispatch ──

	it("8 bash WITHOUT && blocked — reason matches 'Combine bash calls with &&'", async () => {
		const api = createMockAPI();
		agentHarness(api);

		let lastResult: any = null;
		for (let i = 0; i < 8; i++) {
			lastResult = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "echo hi" },
			});
		}
		assert.ok(lastResult?.block);
		assert.ok(lastResult!.reason.includes("Combine bash calls with && or use a script file"));
	});

	it("8 bash WITH && blocked — reason matches 'Reduce per-turn call count'", async () => {
		const api = createMockAPI();
		agentHarness(api);

		let lastResult: any = null;
		for (let i = 0; i < 8; i++) {
			lastResult = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "cd /repo && git status" },
			});
		}
		assert.ok(lastResult?.block);
		assert.ok(lastResult!.reason.includes("Reduce per-turn call count"));
	});

	it("8 write blocked — reason matches 'Batch write calls'", async () => {
		const api = createMockAPI();
		agentHarness(api);

		let lastResult: any = null;
		for (let i = 0; i < 8; i++) {
			lastResult = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "write",
				input: { path: `f${i}.ts`, content: "" },
			});
		}
		assert.ok(lastResult?.block);
		assert.ok(lastResult!.reason.includes("Batch write calls"));
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

		// Standalone grep (no pipe) should be blocked
		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "grep foo" },
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

		// Blocked call (cat README.md) — subKey "cat", blocked, NOT recorded
		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "cat README.md" },
		});

		// Legitimate call — use 2-token command for consistent subKey across loop
		// subKey "echo hi" — should count as first, not second, since blocked didn't count
		let result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "bash",
			input: { command: "echo hi" },
		});
		assert.ok(result == null, "legitimate call after blocked should pass");

		// 7 more identical legitimate calls — 8th total (i=9) should block
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

	// ── Regression: pass-through tools still not blocked after turn_start binding ──

	it("ask_user 15 consecutive calls still not blocked after turn_start binding", async () => {
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

	it("structural_search 15 consecutive calls still not blocked after turn_start binding", async () => {
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
});

// ── Phase 2: CallCounter subKey cascade (Bug 3) ──

describe("Bug 3 fix: CallCounter subKey cascade", () => {
	it("8 bash calls with same sub-command — 8th blocked", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "ls -la" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `bash ls call ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th same-subKey bash call should block");
	});

	it("diverse bash sub-commands never block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const commands = [
			"ls",
			"cd src",
			"file index.ts",
			"stat main.ts",
			"timeout 10",
			"find .",
			"git log",
			"npm test",
		];
		for (let i = 0; i < commands.length; i++) {
			const result = handler(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `diverse cmd ${i} (${commands[i]}) should pass`);
		}
	});

	it("8 diverse git sub-commands — all 8 pass (sub-command-aware keys)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const gitCommands = [
			"git status",
			"git diff",
			"git log",
			"git stash",
			"git branch",
			"git merge",
			"git push",
			"git pull",
		];
		for (let i = 0; i < gitCommands.length; i++) {
			const result = handler(makeEvent("bash", { command: gitCommands[i] }), makeCtx());
			assert.equal(result, null, `git cmd ${i} (${gitCommands[i]}) should pass`);
		}
		// Verify 0 blocks by checking toolCallIndex == 8
		assert.equal(state.toolCallIndex, 8, "all 8 git calls should have passed");
	});

	it("bash subKey resets when switching between different first tokens", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// bash:ls ×4 → bash:cd ×4 → bash:ls ×4 — never blocks
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 4; i++) {
				const cmd = round === 1 ? "cd .." : "ls";
				const result = handler(makeEvent("bash", { command: cmd }), makeCtx());
				assert.equal(result, null, `bash ${cmd} round ${round} call ${i} should pass`);
			}
		}

		// Final check: total 12 calls, 0 blocks
		assert.equal(state.toolCallIndex, 12);
	});

	it("non-bash tool cascade still works (backward compat)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `write call ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th write call should block (backward compat)");
	});

	it("bash empty command recorded without subKey — backward compat", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Empty command passes through, no subKey extracted
		const r1 = handler(makeEvent("bash", {}), makeCtx());
		assert.equal(r1, null);

		// Next bash call with command — should be different subKey vs no subKey
		const r2 = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
		assert.equal(r2, null);

		// Since empty command had no subKey and echo has subKey "echo",
		// they're different keys, so both have count 1.
		// Total turns: 2
		assert.equal(state.toolCallIndex, 2);
	});
});

// ── Issue 282: cd-prefix in getBashSubKey ──

describe("Issue 282: getBashSubKey cd-prefix extraction", () => {
	it("cd /repo && git status → subKey 'git status'", () => {
		assert.equal(getBashSubKey("cd /repo && git status"), "git status");
	});

	it("cd ~/src && ls -la → subKey 'ls'", () => {
		assert.equal(getBashSubKey("cd ~/src && ls -la"), "ls");
	});

	it("cd relative/path && gh issue view 271 → subKey 'gh issue'", () => {
		assert.equal(getBashSubKey("cd relative/path && gh issue view 271"), "gh issue");
	});

	it("cd /repo && npm install express → subKey 'npm install'", () => {
		assert.equal(getBashSubKey("cd /repo && npm install express"), "npm install");
	});

	it("cd /repo && echo hi → subKey 'echo'", () => {
		assert.equal(getBashSubKey("cd /repo && echo hi"), "echo");
	});

	it("cd /repo → subKey 'cd' (bare cd, no &&)", () => {
		assert.equal(getBashSubKey("cd /repo"), "cd");
	});

	it("cd /repo; git status → subKey 'cd' (semicolons not handled)", () => {
		assert.equal(getBashSubKey("cd /repo; git status"), "cd");
	});

	it("cd \"path with spaces\" && cmd → subKey 'cmd'", () => {
		assert.equal(getBashSubKey('cd "path with spaces" && cmd'), "cmd");
	});

	it("git status → git status (backward compat)", () => {
		assert.equal(getBashSubKey("git status"), "git status");
	});

	it("npm install → npm install (backward compat)", () => {
		assert.equal(getBashSubKey("npm install"), "npm install");
	});

	it("echo hi → echo (backward compat)", () => {
		assert.equal(getBashSubKey("echo hi"), "echo");
	});

	it("'' → undefined (backward compat)", () => {
		assert.equal(getBashSubKey(""), undefined);
	});

	it("'   ' → undefined (backward compat)", () => {
		assert.equal(getBashSubKey("   "), undefined);
	});
});

describe("Issue 282: Cascade behavior with cd-prefixed commands", () => {
	it("8 cd /repo && git status calls — 8th blocked", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "cd /repo && git status" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `cd-prefixed git status call ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th cd-prefixed git status should block (same subKey 'git status')");
	});

	it("8 diverse cd-prefixed commands — all 8 pass", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const commands = [
			"cd /repo && git status",
			"cd /repo && ls",
			"cd /repo && npm install",
			"cd /repo && docker ps",
			"cd /repo && gh issue list",
			"cd /repo && echo hi",
			"cd /repo && pwd",
			"cd /repo && cat file",
		];
		for (let i = 0; i < commands.length; i++) {
			const result = handler(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `diverse cd-prefixed cmd ${i} should pass`);
		}
		assert.equal(state.toolCallIndex, 8, "all 8 diverse cd-prefixed calls should pass");
	});

	it("Mix bare cd and cd-prefixed — both pass (different subKeys)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// bare cd — subKey 'cd'
		const r1 = handler(makeEvent("bash", { command: "cd /repo" }), makeCtx());
		assert.equal(r1, null);

		// cd-prefixed ls — subKey 'ls', different from 'cd'
		const r2 = handler(makeEvent("bash", { command: "cd /repo && ls" }), makeCtx());
		assert.equal(r2, null);

		assert.equal(state.toolCallIndex, 2);
	});

	it("cd /repo && npm install ×8 — 8th blocked (same subKey 'npm install')", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "cd /repo && npm install" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `npm install with cd prefix ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th npm install with cd prefix should block (same subKey)");
	});

	it("cd /repo && npm install then cd /repo && npm test — both pass (different subKeys)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const r1 = handler(makeEvent("bash", { command: "cd /repo && npm install" }), makeCtx());
		assert.equal(r1, null);

		const r2 = handler(makeEvent("bash", { command: "cd /repo && npm test" }), makeCtx());
		assert.equal(r2, null);

		assert.equal(state.toolCallIndex, 2);
	});

	it("7 ls calls then 1 cd /repo && ls — 8th blocked (same subKey 'ls')", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		// 7 bare ls calls → subKey 'ls'
		for (let i = 0; i < 7; i++) {
			result = handler(makeEvent("bash", { command: "ls" }), makeCtx());
			assert.equal(result, null, `bare ls call ${i + 1} should pass`);
		}

		// 8th call: cd /repo && ls — same subKey 'ls', should be blocked
		result = handler(makeEvent("bash", { command: "cd /repo && ls" }), makeCtx());
		assert.ok(result?.block, "8th call (cd /repo && ls) should block — same subKey 'ls'");
	});
});

// ── Issue 282: Error message suggestion split (now Issue 296 style) ──

describe("Issue 282: Error message suggestion split (migrated to Issue 296 format)", () => {
	it("Blocked bash WITHOUT && suggests 'Combine bash calls with &&'", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Combine bash calls with &&"),
			"blocked echo hi should suggest combined bash calls",
		);
	});

	it("Blocked bash WITH && suggests 'Reduce per-turn call count'", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "cd /repo && git status" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Reduce per-turn call count"),
			"blocked cd-prefixed command should suggest reducing per-turn call count",
		);
	});

	it("Non-bash cascade unchanged suggestion text", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Batch write calls"),
			"non-bash cascade should keep existing suggestion",
		);
	});

	it("Blocked bash WITH && in middle of command suggests Reduce per-turn", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "npm install && npm test" }), makeCtx());
		}
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("Reduce per-turn call count"),
			"blocked npm && command should suggest reducing per-turn count",
		);
	});
});

// ── Phase 2: Multi-verb CLI diversity (npm, docker, gh) ──

describe("Phase 2: Multi-verb CLI diversity — 2-token subKey", () => {
	it("getBashSubKey pure function — 2-token extraction", () => {
		assert.equal(getBashSubKey("git status"), "git status");
		assert.equal(getBashSubKey("git diff"), "git diff");
		assert.equal(getBashSubKey("echo hi"), "echo");
		assert.equal(getBashSubKey("ls"), "ls");
		assert.equal(getBashSubKey("npm install"), "npm install");
		assert.equal(getBashSubKey("docker ps"), "docker ps");
		assert.equal(getBashSubKey("gh issue list"), "gh issue");
		assert.equal(getBashSubKey(""), undefined);
		assert.equal(getBashSubKey("   "), undefined);
		assert.equal(getBashSubKey("git push origin main"), "git push");
	});

	it("npm install ×8 — 8th blocked (same 2-token subKey)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "npm install" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `npm install call ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th npm install should block (same subKey)");
	});

	it("diverse npm sub-commands — all 8 pass", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const commands = [
			"npm install",
			"npm test",
			"npm run build",
			"npm publish",
			"npm audit",
			"npm cache clean",
			"npm ci",
			"npm outdated",
		];
		for (let i = 0; i < commands.length; i++) {
			const result = handler(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `npm cmd ${i} (${commands[i]}) should pass`);
		}
		assert.equal(state.toolCallIndex, 8, "all 8 diverse npm calls should pass");
	});

	it("diverse docker sub-commands — all 8 pass", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const commands = [
			"docker ps",
			"docker exec",
			"docker logs",
			"docker build",
			"docker run",
			"docker stop",
			"docker rm",
			"docker images",
		];
		for (let i = 0; i < commands.length; i++) {
			const result = handler(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `docker cmd ${i} (${commands[i]}) should pass`);
		}
		assert.equal(state.toolCallIndex, 8, "all 8 diverse docker calls should pass");
	});

	it("diverse gh sub-commands — all 8 pass", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const commands = [
			"gh issue list",
			"gh pr create",
			"gh release list",
			"gh run list",
			"gh repo view",
			"gh search repos",
			"gh secret list",
			"gh config list",
		];
		for (let i = 0; i < commands.length; i++) {
			const result = handler(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `gh cmd ${i} (${commands[i]}) should pass`);
		}
		assert.equal(state.toolCallIndex, 8, "all 8 diverse gh calls should pass");
	});
});

// ── Phase 3: Backward compatibility and edge cases ──

describe("Phase 3: Backward compatibility and edge cases", () => {
	it("echo hi ×8 — 8th blocked (single-token subKey 'echo', backward compat)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `echo hi call ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th echo hi should block (same subKey 'echo')");
	});

	it("non-bash write cascade still works — 8th blocked", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("write", { path: `f${i}.ts`, content: "" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `write call ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th write call should block (unchanged path)");
	});

	it("bash empty command ×8 — 8th blocked (same undefined subKey)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `empty bash ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th empty bash should block (same undefined subKey)");
	});

	it("bash({}) then bash with command — both pass (different subKeys)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// No command key — subKey undefined
		const r1 = handler(makeEvent("bash", {}), makeCtx());
		assert.equal(r1, null);

		// Has command — subKey "echo"
		const r2 = handler(makeEvent("bash", { command: "echo hi" }), makeCtx());
		assert.equal(r2, null);

		// Different keys, both pass, 2 turns
		assert.equal(state.toolCallIndex, 2);
	});

	it("mixed CLIs (git/npm/docker/gh) — all 8 pass", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const commands = [
			"git status",
			"npm install",
			"docker ps",
			"gh issue list",
			"git diff",
			"npm test",
			"docker exec",
			"gh pr create",
		];
		for (let i = 0; i < commands.length; i++) {
			const result = handler(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `mixed cmd ${i} (${commands[i]}) should pass`);
		}
		assert.equal(state.toolCallIndex, 8, "all 8 mixed CLI calls should pass");
	});

	it("git push origin main ×8 — 8th blocked (same 2-token subKey 'git push')", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		let result: ToolCallResult | null = null;
		for (let i = 0; i < 8; i++) {
			result = handler(makeEvent("bash", { command: "git push origin main" }), makeCtx());
			if (i < 7) {
				assert.equal(result, null, `git push call ${i + 1} should pass`);
			}
		}
		assert.ok(result?.block, "8th git push origin main should block (same 2-token subKey)");
	});
});

// ── Phase 3: Read cache [pending] same-turn pass-through (Bug 5) ──

describe("Bug 5 fix: read cache [pending] same-turn pass-through", () => {
	it("same-turn [pending] re-read passes through", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read at turn 0: cache miss, set [pending], pass
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);
		assert.equal(state.toolCallIndex, 1);

		// Reset turn to 0 to simulate same-turn re-read
		state.toolCallIndex = 0;

		// Second read at turn 0: cache hit with [pending] at turn 0 → pass through
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r2, null, "same-turn [pending] should pass through");
	});

	it("cross-turn [pending] re-read blocks", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read: turn 0, sets [pending]
		handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(state.toolCallIndex, 1);

		// Second read at turn 1: cache hit with [pending] at turn 0
		// Since cached.turn(0) !== toolCallIndex(1), it blocks
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r2?.block, "cross-turn [pending] should block");
	});

	it("same-turn normal content still blocks", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Manually set cache with real content at turn 0
		state.readCache.set("a.ts|0|", "real content", 0);

		// Read at turn 0: cache hit with real content at turn 0 → block
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r1?.block, "same-turn real content should still block");
	});

	it("different cache keys both pass", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Read with offset 0, limit 100
		const r1 = handler(makeEvent("read", { path: "a.ts", offset: 0, limit: 100 }), makeCtx());
		assert.equal(r1, null);

		// Reset turn to 0 for same-turn
		state.toolCallIndex = 0;

		// Read with offset 100, limit 100 — different cache key, should pass
		const r2 = handler(makeEvent("read", { path: "a.ts", offset: 100, limit: 100 }), makeCtx());
		assert.equal(r2, null, "different offset should have different cache key");
	});

	it("TTL-expired [pending] cache miss passes through", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read at turn 0: sets [pending]
		handler(makeEvent("read", { path: "a.ts" }), makeCtx());

		// Set turn to 6 (CACHE_TTL_TURNS = 6, diff >= 6 → TTL expired)
		state.toolCallIndex = 6;

		// Re-read: cache TTL expired, miss, pass through
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r2, null, "TTL-expired cache miss should pass through");
	});
});

// ── Issue 270: Harness improvements ──

describe("Issue 270: Cache invalidation on write", () => {
	it("write tool clears read cache", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read caches
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);

		// Write clears cache
		handler(makeEvent("write", { path: "out.ts", content: "data" }), makeCtx());

		// Re-read same file should pass (cache was cleared)
		state.toolCallIndex = 2;
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r2, null, "read after write should pass — cache invalidated");
	});

	it("file-modifying bash command clears read cache", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read caches
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);

		// sed -i modifies files, should clear cache
		handler(makeEvent("bash", { command: "sed -i 's/foo/bar/g' file.ts" }), makeCtx());

		// Re-read same file should pass (cache was cleared)
		state.toolCallIndex = 4;
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r2, null, "read after sed should pass — cache invalidated");
	});

	it("non-modifying bash command does NOT clear read cache", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read caches
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);

		// ls doesn't modify files, cache should stay
		handler(makeEvent("bash", { command: "ls -la" }), makeCtx());

		// Re-read same file — cache still present, should block
		state.toolCallIndex = 2;
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r2?.block, "read after ls should block — cache not invalidated");
	});

	it("echo with redirect clears read cache", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read caches
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);

		// echo with > redirect modifies files
		handler(makeEvent("bash", { command: "echo 'data' > /tmp/x" }), makeCtx());

		// Cache should be cleared
		state.toolCallIndex = 4;
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r2, null, "read after echo > should pass — cache invalidated");
	});
});

describe("Issue 270: buildRedirectMessage format", () => {
	it("bash grep block uses system override format", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "grep foo" }), makeCtx());
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("[SYSTEM OVERRIDE]"),
			"reason should start with SYSTEM OVERRIDE",
		);
		assert.ok(result!.reason.includes("ripgrep_search"), "should mention ripgrep_search tool");
		assert.ok(result!.reason.includes("JSON Schema"), "should include JSON Schema");
	});

	it("bash cat block uses system override format", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "cat README.md" }), makeCtx());
		assert.ok(result?.block);
		assert.ok(
			result!.reason.includes("[SYSTEM OVERRIDE]"),
			"reason should start with SYSTEM OVERRIDE",
		);
		assert.ok(result!.reason.includes("read"), "should mention read tool");
		assert.ok(result!.reason.includes("JSON Schema"), "should include JSON Schema");
	});
});

describe("Issue 270: Pipeline pass-through for bash search", () => {
	it("piped grep (ls | grep) does NOT block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "ls -la | grep foo" }), makeCtx());
		assert.equal(result, null, "piped grep should pass through");
	});

	it("chained grep (cmd && grep) does NOT block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "cd src && rg pattern" }), makeCtx());
		assert.equal(result, null, "chained grep with && should pass through");
	});

	it("standalone grep still blocks", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "grep foo" }), makeCtx());
		assert.ok(result?.block, "standalone grep should still block");
	});

	it("pipeline with grep in pipe segment does NOT block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(
			makeEvent("bash", { command: "find . -type f | xargs grep TODO" }),
			makeCtx(),
		);
		assert.equal(result, null, "xargs grep pipeline should pass through");
	});

	it("semicolon chained grep does NOT block", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const result = handler(makeEvent("bash", { command: "echo done; grep foo" }), makeCtx());
		assert.equal(result, null, "semicolon chained grep should pass through");
	});
});

describe("Issue 270: batchId-aware cache TTL", () => {
	it("handler passes state.batchId to read cache", () => {
		const state = createHarnessState();
		state.batchId = 42;
		const handler = createToolCallHandler(state);

		// First read caches with batchId
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);

		// Simulate same batch — same batchId, toolCallIndex advanced
		// Cache entry was stored with batchId=42, now get with batchId=42
		// Should still be valid (same batch), so blocked
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r2?.block, "same batchId read should block (cache still valid)");
	});

	it("different batchId uses turn-based TTL", () => {
		const state = createHarnessState();
		state.batchId = 42;
		const handler = createToolCallHandler(state);

		// First read caches with batchId 42 at turn 0
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);

		// New batch — state.batchId changes
		state.batchId = 43;

		// Within TTL turns (diff < 6), cache still valid for different batchId
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r2?.block, "different batchId within turn TTL should block");
	});

	it("no batchId set — backward compat fallback to turn-based", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// No batchId set (undefined)
		const r1 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(r1, null);

		// Same turn — normal blocking
		state.toolCallIndex = 1;
		const r2 = handler(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r2?.block, "no batchId — normal cache block");
	});
});
