/**
 * Tests for AgentHarness — tool call validation class.
 *
 * Tests construct AgentHarness, call handleToolCall(), assert on return value.
 * No direct state access — only public API: handleToolCall(), handleTurnStart(), reset().
 * getBashSubKey stays as standalone pure function — tests for it remain here.
 *
 * Library-level unit tests (TimedMap, BashCommand, harness-state, harness-rules)
 * live in .pi/lib/*.test.ts — not duplicated here.
 *
 * @packageDocumentation
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness, getBashSubKey } from "../index.ts";
import type { ToolCallResult } from "../index.ts";
import agentHarness from "../index.ts";
import { CASCADE_THRESHOLD, CACHE_TTL_TURNS } from "../lib/harness-rules.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Helpers ──

function makeEvent(toolName: string, args: Record<string, unknown> = {}, isError = false) {
	return { toolName, input: args, isError };
}

function makeCtx() {
	return {};
}

function callNTimes(
	harness: AgentHarness,
	toolName: string,
	n: number,
	args: Record<string, unknown> = {},
): (ToolCallResult | null)[] {
	const results: (ToolCallResult | null)[] = [];
	for (let i = 0; i < n; i++) {
		results.push(harness.handleToolCall(makeEvent(toolName, args), makeCtx()));
	}
	return results;
}

// ── Basic pass-through ──

describe("AgentHarness — basic pass-through", () => {
	it("undefined toolName returns null", () => {
		assert.equal(new AgentHarness().handleToolCall({ input: {} }, makeCtx()), null);
	});

	it("empty toolName returns null", () => {
		assert.equal(new AgentHarness().handleToolCall(makeEvent(""), makeCtx()), null);
	});

	it("pass-through tools (structural_search, ripgrep_search, ranked_map, ask_user) pass through", () => {
		const h = new AgentHarness();
		for (const tool of ["structural_search", "ripgrep_search", "ranked_map", "ask_user"]) {
			assert.equal(h.handleToolCall(makeEvent(tool, {}), makeCtx()), null, tool);
		}
	});

	it("bash simple commands (echo, npm test, ls) pass through", () => {
		const h = new AgentHarness();
		for (const cmd of ["echo hi", "npm test", "ls -la"]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("unknown tool does not crash", () => {
		assert.equal(
			new AgentHarness().handleToolCall(makeEvent("unknown_tool_xyz", {}), makeCtx()),
			null,
		);
	});

	it("bash empty/missing command passes through", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("bash", {}), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("bash", { command: "" }), makeCtx()), null);
	});
});

// ── Bash tool mismatch ──

describe("AgentHarness — bash tool mismatch", () => {
	it("standalone grep → block with redirectTo ripgrep_search", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "grep foo" }),
			makeCtx(),
		);
		assert.ok(r?.block);
		assert.equal(r?.redirectTo, "ripgrep_search");
		assert.ok(r!.reason.includes("[SYSTEM OVERRIDE]"));
	});

	it("standalone cat → block with redirectTo read", () => {
		const r = new AgentHarness().handleToolCall(
			makeEvent("bash", { command: "cat README.md" }),
			makeCtx(),
		);
		assert.ok(r?.block);
		assert.equal(r?.redirectTo, "read");
	});

	it("standalone head/tail → block with redirectTo read", () => {
		const h = new AgentHarness();
		for (const cmd of ["head -5 file", "tail -10 file"]) {
			const r = h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx());
			assert.ok(r?.block, cmd);
			assert.equal(r?.redirectTo, "read", cmd);
		}
	});

	it("bash cat with redirect (cat > file) does NOT block", () => {
		for (const cmd of [
			"cat > /tmp/foo << EOF",
			"cat >> file << EOF",
			"cat file1.ts file2.ts > combined.ts",
		]) {
			assert.equal(
				new AgentHarness().handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()),
				null,
				cmd,
			);
		}
	});

	it("piped grep (ls | grep), chained (cd && rg), piped head pass through", () => {
		const h = new AgentHarness();
		for (const cmd of [
			"ls -la | grep foo",
			"cd src && rg pattern",
			"ls -la | head -5",
			"find . | xargs grep TODO",
		]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("quoted args (gh issue with grep/cat in title) do NOT block", () => {
		const h = new AgentHarness();
		for (const cmd of [
			"gh issue create --body '...| grep...'",
			'gh issue create --title "... cat ..."',
		]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});
});

// ── Error accumulation and retry blocking ──

describe("AgentHarness — error retry blocking", () => {
	it("single error passes through; 2 errors block next non-error call", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx()), null);

		const r = h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(r?.block);
		assert.ok(r!.reason.includes("errored"));
	});

	it("different tools have independent error tracking", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		// write has no errors — should pass
		assert.equal(
			h.handleToolCall(makeEvent("write", { path: "c.ts", content: "" }), makeCtx()),
			null,
		);
	});

	it("turn_start decays errors — tool recovers after turn boundary", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		assert.ok(h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx())?.block);

		h.handleTurnStart(); // decays 2→1
		assert.equal(h.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx()), null);

		h.handleTurnStart(); // decays 1→0
		assert.equal(h.handleToolCall(makeEvent("read", { path: "e.ts" }), makeCtx()), null);
	});
});

// ── Read cache ──

describe("AgentHarness — read cache", () => {
	it("first read passes through; second read same path+offset+limit blocks", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()), null);

		const r = h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(r?.block);
		assert.ok(r!.reason.includes("cached"));
	});

	it("different paths or different offset/limit both pass", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts", offset: 0, limit: 100 }), makeCtx());

		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx()),
			null,
			"different path",
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts", offset: 50, limit: 20 }), makeCtx()),
			null,
			"different offset/limit",
		);
	});

	it("read without path passes through (no caching)", () => {
		const h = new AgentHarness();
		assert.equal(h.handleToolCall(makeEvent("read", {}), makeCtx()), null);
		assert.equal(h.handleToolCall(makeEvent("read", {}), makeCtx()), null);
	});

	it("cache miss after TTL expiry", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		// Advance toolCallIndex past TTL
		for (let i = 0; i < CACHE_TTL_TURNS; i++) {
			h.handleToolCall(makeEvent("bash", { command: `echo ${i}` }), makeCtx());
		}
		assert.equal(h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()), null);
	});
});

// ── Cache invalidation ──

describe("AgentHarness — cache invalidation", () => {
	it("write and edit tools clear read cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		h.handleToolCall(makeEvent("write", { path: "out.ts", content: "x" }), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()),
			null,
			"after write",
		);

		h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());
		h.handleToolCall(
			makeEvent("edit", { path: "b.ts", oldText: "foo", newText: "bar" }),
			makeCtx(),
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx()),
			null,
			"after edit",
		);
	});

	it("file-modifying bash (sed, echo >) clears read cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		h.handleToolCall(makeEvent("bash", { command: "sed -i 's/foo/bar/g' file.ts" }), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()),
			null,
			"after sed",
		);

		h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());
		h.handleToolCall(makeEvent("bash", { command: "echo 'data' > /tmp/x" }), makeCtx());
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx()),
			null,
			"after echo >",
		);
	});

	it("non-modifying bash (ls) does NOT clear read cache", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		h.handleToolCall(makeEvent("bash", { command: "ls -la" }), makeCtx());
		assert.ok(h.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx())?.block);
	});
});

// ── Cascade detection ──

describe("AgentHarness — cascade detection", () => {
	it("blocks at CASCADE_THRESHOLD consecutive same-tool calls", () => {
		const results = callNTimes(new AgentHarness(), "write", CASCADE_THRESHOLD, {
			path: "f.ts",
			content: "",
		});
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			assert.equal(results[i], null, `call ${i + 1} should pass`);
		}
		assert.ok(results[CASCADE_THRESHOLD - 1]?.block, `${CASCADE_THRESHOLD}th call should block`);
	});

	it("mixed tools do NOT trigger cascade", () => {
		const h = new AgentHarness();
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
			assert.equal(h.handleToolCall(makeEvent(tool, args), makeCtx()), null, `step ${i} (${tool})`);
		}
	});

	it("pass-through tools (ask_user) never cascade — 15 consecutive pass", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 15; i++) {
			assert.equal(
				h.handleToolCall(makeEvent("ask_user", { question: `Q${i}?` }), makeCtx()),
				null,
				`ask_user ${i}`,
			);
		}
	});

	it("read cascade is skipped (cache handles redundancy) — 8 different reads pass", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 8; i++) {
			assert.equal(h.handleToolCall(makeEvent("read", { path: `file${i}.ts` }), makeCtx()), null);
		}
	});
});

// ── Cascade suggestion text ──

describe("AgentHarness — cascade suggestion text", () => {
	it("bash cascade WITHOUT && suggests combined bash calls", () => {
		const results = callNTimes(new AgentHarness(), "bash", 8, { command: "echo hi" });
		assert.ok(results[7]?.reason.includes("Combine bash calls with &&"));
	});

	it("bash cascade WITH && suggests reduce per-turn call count", () => {
		const results = callNTimes(new AgentHarness(), "bash", 8, {
			command: "cd /repo && git status",
		});
		assert.ok(results[7]?.reason.includes("Reduce per-turn call count"));
	});

	it("non-bash cascade suggests batch tool calls", () => {
		const results = callNTimes(new AgentHarness(), "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.reason.includes("Batch write calls"));
	});
});

// ── Turn boundary cascade reset ──

describe("AgentHarness — turn boundary cascade reset", () => {
	it("8 same-tool calls in one turn — 8th blocked; turn_start resets for next turn", () => {
		const h = new AgentHarness();
		const results1 = callNTimes(h, "write", 8, { path: "f.ts", content: "" });
		assert.ok(results1[7]?.block, "8th call in turn 0 should block");

		h.handleTurnStart();

		const results2 = callNTimes(h, "write", 4, { path: "g.ts", content: "" });
		for (let i = 0; i < 4; i++) {
			assert.equal(results2[i], null, `turn 1 call ${i} should pass (reset)`);
		}
	});

	it("4 calls → turn_start → 4 calls — none blocked", () => {
		const h = new AgentHarness();
		for (let i = 0; i < 4; i++) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx()), null);
		}
		h.handleTurnStart();
		for (let i = 0; i < 4; i++) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx()), null);
		}
	});
});

// ── Blocked calls not recorded ──

describe("AgentHarness — blocked calls not recorded", () => {
	it("blocked bash grep does NOT inflate cascade counter", () => {
		const h = new AgentHarness();
		// Blocked by tool mismatch — not recorded
		h.handleToolCall(makeEvent("bash", { command: "cat README.md" }), makeCtx());
		// This should count as 1st legitimate call
		assert.equal(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx()), null);
		// 6 more = 7 total legitimate (8th blocked)
		for (let i = 0; i < 6; i++) {
			h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx());
		}
		assert.ok(h.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx())?.block);
	});

	it("blocked cache read -> different path read passes (counter not inflated)", () => {
		const h = new AgentHarness();
		h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());
		assert.ok(h.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx())?.block);
		assert.equal(h.handleToolCall(makeEvent("read", { path: "other.ts" }), makeCtx()), null);
	});
});

// ── getBashSubKey pure function ──

describe("getBashSubKey", () => {
	it("2-token extraction for multi-verb CLIs", () => {
		assert.equal(getBashSubKey("git status"), "git status");
		assert.equal(getBashSubKey("npm install"), "npm install");
		assert.equal(getBashSubKey("docker ps"), "docker ps");
		assert.equal(getBashSubKey("gh issue list"), "gh issue");
	});

	it("single-token for simple commands", () => {
		assert.equal(getBashSubKey("echo hi"), "echo");
		assert.equal(getBashSubKey("ls -la"), "ls");
	});

	it("cd-prefix extraction", () => {
		assert.equal(getBashSubKey("cd /repo && git status"), "git status");
		assert.equal(getBashSubKey("cd /repo && ls"), "ls");
		assert.equal(getBashSubKey("cd /repo && gh issue view 271"), "gh issue");
		assert.equal(getBashSubKey("cd /repo"), "cd");
	});

	it("empty/whitespace returns undefined", () => {
		assert.equal(getBashSubKey(""), undefined);
		assert.equal(getBashSubKey("   "), undefined);
	});
});

// ── Multi-verb CLI diversity ──

describe("AgentHarness — multi-verb CLI diversity", () => {
	it("8 identical npm install calls — 8th blocked", () => {
		const results = callNTimes(new AgentHarness(), "bash", 8, { command: "npm install" });
		assert.ok(results[7]?.block);
	});

	it("diverse npm sub-commands — all pass", () => {
		const h = new AgentHarness();
		for (const cmd of ["npm install", "npm test", "npm run build", "npm publish"]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("diverse git sub-commands — all pass", () => {
		const h = new AgentHarness();
		for (const cmd of [
			"git status",
			"git diff",
			"git log",
			"git stash",
			"git branch",
			"git merge",
			"git push",
			"git pull",
		]) {
			assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null, cmd);
		}
	});

	it("bash subKey resets when switching between different first tokens", () => {
		const h = new AgentHarness();
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 4; i++) {
				const cmd = round === 1 ? "cd .." : "ls";
				assert.equal(h.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx()), null);
			}
		}
	});
});

// ── Reset ──

describe("AgentHarness — reset", () => {
	it("reset clears cascade state, error tracker, and read cache", () => {
		const h = new AgentHarness();

		// Build up cascade
		const results = callNTimes(h, "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.block, "8th call should block");

		// Add errors
		h.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		h.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// Cache a read
		h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());

		// Reset
		h.reset();

		// All state should be fresh
		assert.equal(
			h.handleToolCall(makeEvent("write", { path: "fresh.ts", content: "" }), makeCtx()),
			null,
			"cascade cleared",
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx()),
			null,
			"errors cleared",
		);
		assert.equal(
			h.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx()),
			null,
			"cache cleared",
		);
	});
});

// ── Mock ExtensionAPI integration ──

describe("AgentHarness — extension entry point", () => {
	function createMockAPI() {
		const handlers = new Map<string, (...args: any[]) => any>();
		const api = {
			handlers,
			on(event: any, handler: any) {
				handlers.set(event, handler);
			},
			fire(event: string, data: any, ctx?: any) {
				const handler = handlers.get(event);
				return handler ? handler(data, ctx ?? {}) : undefined;
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

	it("session_start resets cascade state", async () => {
		const api = createMockAPI();
		agentHarness(api);

		for (let i = 0; i < 9; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "write",
				input: { path: `file${i}.ts`, content: "" },
			});
			if (i >= 7) assert.ok(result?.block, `call ${i} should be blocked`);
			else assert.equal(result, undefined, `call ${i} should pass`);
		}

		await api.fire("session_start", { type: "session_start", reason: "new" });

		const after = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "reset",
			toolName: "write",
			input: { path: "fresh.ts", content: "" },
		});
		assert.equal(after, undefined, "after session_start, state should be fresh");
	});

	it("turn_start handler resets cascade — 8 across 2 turns bypasses block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "bash",
				input: { command: "echo same" },
			});
			assert.equal(result, undefined, `turn 0 call ${i} should pass`);
		}

		await api.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

		for (let i = 0; i < 4; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(10 + i),
				toolName: "bash",
				input: { command: "echo same" },
			});
			assert.equal(result, undefined, `turn 1 call ${i} should pass (reset)`);
		}
	});

	it("read cache through dispatch works", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "test.ts" },
		});
		assert.equal(r1, undefined, "first read passes");

		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "test.ts" },
		});
		assert.ok(r2?.block, "second read same path blocks");
	});

	it("bash grep through dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "grep foo" },
		});
		assert.ok(r?.block);
	});

	it("undefined toolName in dispatch passes through and subsequent call works", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			input: { path: "x.ts" },
		});
		assert.equal(r1, undefined, "undefined toolName passes");

		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "a.ts" },
		});
		assert.equal(r2, undefined, "subsequent read passes");
	});
});
