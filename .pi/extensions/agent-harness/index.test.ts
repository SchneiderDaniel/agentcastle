/**
 * Tests for AgentHarness — tool call validation class.
 *
 * Tests construct AgentHarness, call handleToolCall(), assert on return value.
 * No direct state access — only public API: handleToolCall(), handleTurnStart(), reset().
 * getBashSubKey stays as standalone pure function — tests for it remain unchanged.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentHarness, getBashSubKey } from "./index.ts";
import type { ToolCallResult } from "./index.ts";
import agentHarness from "./index.ts";
import {
	CASCADE_THRESHOLD,
	CACHE_TTL_TURNS,
	buildRedirectMessage,
} from "../../lib/harness-rules.ts";
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
	harness: AgentHarness,
	toolName: string,
	n: number,
	args: Record<string, unknown> = {},
) {
	const results: (ToolCallResult | null)[] = [];
	for (let i = 0; i < n; i++) {
		results.push(harness.handleToolCall(makeEvent(toolName, args), makeCtx()));
	}
	return results;
}

// ── Phase 1: Domain tests — basic guard logic ──

describe("AgentHarness handleToolCall — domain", () => {
	it("happy path: read with path passes through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(result, null);
	});

	it("undefined toolName returns null", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall({ input: {} }, makeCtx());
		assert.equal(result, null);
	});

	it("empty toolName returns null", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("", { path: "a.ts" }), makeCtx());
		assert.equal(result, null);
	});

	it("bash grep standalone returns block with redirectTo ripgrep_search", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", { command: "grep foo" }), makeCtx());
		assert.ok(result?.block);
		assert.equal(result?.redirectTo, "ripgrep_search");
		assert.ok(result!.reason.includes("[SYSTEM OVERRIDE]"));
	});

	it("bash rg standalone returns block with redirectTo ripgrep_search", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", { command: "rg pattern" }), makeCtx());
		assert.ok(result?.block);
		assert.equal(result?.redirectTo, "ripgrep_search");
	});

	it("bash cat file returns block with redirectTo read", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "cat README.md" }),
			makeCtx(),
		);
		assert.ok(result?.block);
		assert.equal(result?.redirectTo, "read");
		assert.ok(result!.reason.includes("[SYSTEM OVERRIDE]"));
	});

	it("bash head file returns block with redirectTo read", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "head -5 file" }),
			makeCtx(),
		);
		assert.ok(result?.block);
		assert.equal(result?.redirectTo, "read");
	});

	it("bash tail file returns block with redirectTo read", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "tail -10 file" }),
			makeCtx(),
		);
		assert.ok(result?.block);
		assert.equal(result?.redirectTo, "read");
	});

	it("bash cat with write redirect (cat > file) does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "cat > /tmp/foo << EOF" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("bash cat with append redirect (cat >> file) does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "cat >> file << EOF" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("bash cat concat (cat file1 file2 > combined) does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "cat file1.ts file2.ts > combined.ts" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("bash head/tail in pipe does NOT block", () => {
		const harness = new AgentHarness();
		const r1 = harness.handleToolCall(
			makeEvent("bash", { command: "ls -la | head -5" }),
			makeCtx(),
		);
		const r2 = harness.handleToolCall(
			makeEvent("bash", { command: "ls -lt | tail -10" }),
			makeCtx(),
		);
		assert.equal(r1, null);
		assert.equal(r2, null);
	});

	it("bash piped grep (ls | grep) does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "ls -la | grep foo" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("bash quoted args (gh issue --body '...| grep...') does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "gh issue create --body '...| grep...'" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("bash quoted cat in title does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: 'gh issue create --title "... cat ..."' }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("bash npm test passes through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", { command: "npm test" }), makeCtx());
		assert.equal(result, null);
	});

	it("bash ls passes through (informational, not blocked)", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", { command: "ls -la" }), makeCtx());
		assert.equal(result, null);
	});

	it("bash empty command passes through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", {}), makeCtx());
		assert.equal(result, null);
	});

	it("bash null command passes through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", { command: "" }), makeCtx());
		assert.equal(result, null);
	});

	it("pass-through tools (structural_search) pass through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("structural_search", { pattern: "test", language: "ts" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("pass-through tools (ripgrep_search) pass through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("ripgrep_search", { query: "test" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("unknown tool does not crash", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("unknown_tool_xyz", {}), makeCtx());
		assert.equal(result, null);
	});
});

// ── Phase 2: Error accumulation and retry blocking ──

describe("AgentHarness error accumulation", () => {
	it("error event passes through but tracks error", () => {
		const harness = new AgentHarness();
		const r1 = harness.handleToolCall(makeEvent("read", { path: "err.ts" }, true), makeCtx());
		assert.equal(r1, null, "error event should pass through");

		// Subsequent non-error call should pass (1 error, not >=2)
		const r2 = harness.handleToolCall(makeEvent("read", { path: "ok.ts" }), makeCtx());
		assert.equal(r2, null, "read after single error should pass");
	});

	it("2 errors block the next non-error call", () => {
		const harness = new AgentHarness();

		// 2 error events
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// 3rd non-error call should be blocked
		const result = harness.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(result?.block, "read should block after 2 errors");
		assert.ok(result!.reason.includes("errored"), "reason should mention errors");
	});

	it("different tools have independent error tracking", () => {
		const harness = new AgentHarness();

		// 2 errors for read
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// Non-error write should pass (no errors for write)
		const writeResult = harness.handleToolCall(
			makeEvent("write", { path: "c.ts", content: "" }),
			makeCtx(),
		);
		assert.equal(writeResult, null, "write should pass — no errors tracked for write");
	});

	it("turn_start decays errors — tool recovers after turn boundary", () => {
		const harness = new AgentHarness();

		// 2 errors for read
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// Blocked
		const blocked = harness.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(blocked?.block);

		// Turn boundary decays 2 errors → 1
		harness.handleTurnStart();

		// Now should pass (1 < 2)
		const after = harness.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx());
		assert.equal(after, null, "read should pass after turn_start decays errors");
	});

	it("error recovery across multiple turn_starts", () => {
		const harness = new AgentHarness();

		// 3 errors for read
		for (let i = 0; i < 3; i++) {
			harness.handleToolCall(makeEvent("read", { path: `${i}.ts` }, true), makeCtx());
		}

		// Blocked
		const blocked = harness.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(blocked?.block);

		// 3 turn_starts decay 3→2→1→0
		for (let i = 0; i < 3; i++) {
			harness.handleTurnStart();
		}

		// Should pass
		const after = harness.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx());
		assert.equal(after, null, "read should pass after 3 turn_starts decay all errors");
	});
});

// ── Phase 3: Read cache ──

describe("AgentHarness read cache", () => {
	it("first read passes through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("read", { path: "a.ts", offset: 0, limit: 100 }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("second read same path+offset+limit blocks", () => {
		const harness = new AgentHarness();

		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		assert.ok(result?.block, "same path re-read should block");
		assert.ok(result!.reason.includes("cached"), "reason should mention cache");
	});

	it("different path reads both pass", () => {
		const harness = new AgentHarness();

		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		const result = harness.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());

		assert.equal(result, null, "different path should pass");
	});

	it("different offset/limit produces different cache key", () => {
		const harness = new AgentHarness();

		harness.handleToolCall(makeEvent("read", { path: "a.ts", offset: 0, limit: 100 }), makeCtx());
		const result = harness.handleToolCall(
			makeEvent("read", { path: "a.ts", offset: 50, limit: 20 }),
			makeCtx(),
		);

		assert.equal(result, null, "different offset/limit should pass");
	});

	it("read without path key passes through (no caching)", () => {
		const harness = new AgentHarness();
		const r1 = harness.handleToolCall(makeEvent("read", {}), makeCtx());
		const r2 = harness.handleToolCall(makeEvent("read", {}), makeCtx());
		assert.equal(r1, null);
		assert.equal(r2, null);
	});

	it("cache miss after TTL expiry", () => {
		const harness = new AgentHarness();

		// Read at toolCallIndex 0
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// Advance toolCallIndex beyond TTL (CACHE_TTL_TURNS = 6)
		// Since we can't directly set toolCallIndex, we make other calls
		// to advance it. Total calls needed: 6+ to exceed TTL.
		// After first read at index 0, make 6 more non-read calls:
		for (let i = 0; i < 6; i++) {
			harness.handleToolCall(makeEvent("bash", { command: `echo ${i}` }), makeCtx());
		}

		// Now toolCallIndex is 7, read same path — cache TTL expired (diff=7, >=6)
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(result, null, "cache should be expired after TTL turns");
	});

	it("toolCallIndex advances correctly — 2nd read after non-cache-clearing call blocks", () => {
		const harness = new AgentHarness();

		// Read a.ts → caches at index 0
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// bash ls (non-modifying) advances index, doesn't clear cache
		harness.handleToolCall(makeEvent("bash", { command: "ls" }), makeCtx());

		// Read same a.ts — cache should be present (turn diff < 6)
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(result?.block, "cache should still be valid — 2nd read same path blocks");
	});
});

// ── Phase 4: Cache invalidation ──

describe("AgentHarness cache invalidation", () => {
	it("write tool clears read cache", () => {
		const harness = new AgentHarness();

		// Read caches
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// Write clears cache
		harness.handleToolCall(makeEvent("write", { path: "out.ts", content: "data" }), makeCtx());

		// Re-read same file should pass (cache cleared)
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(result, null, "read after write should pass — cache invalidated");
	});

	it("edit tool clears read cache", () => {
		const harness = new AgentHarness();

		// Read caches
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// Edit clears cache
		harness.handleToolCall(
			makeEvent("edit", { path: "a.ts", oldText: "foo", newText: "bar" }),
			makeCtx(),
		);

		// Re-read same file should pass (cache cleared)
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(result, null, "read after edit should pass — cache invalidated");
	});

	it("file-modifying bash command (sed) clears read cache", () => {
		const harness = new AgentHarness();

		// Read caches
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// sed modifies files — clears cache
		harness.handleToolCall(
			makeEvent("bash", { command: "sed -i 's/foo/bar/g' file.ts" }),
			makeCtx(),
		);

		// Re-read should pass
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(result, null, "read after sed should pass — cache invalidated");
	});

	it("non-modifying bash command does NOT clear read cache", () => {
		const harness = new AgentHarness();

		// Read caches
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// ls doesn't modify files
		harness.handleToolCall(makeEvent("bash", { command: "ls -la" }), makeCtx());

		// Re-read should block (cache still present)
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.ok(result?.block, "read after ls should block — cache not invalidated");
	});

	it("echo with redirect clears read cache", () => {
		const harness = new AgentHarness();

		// Read caches
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// echo with > modifies files
		harness.handleToolCall(makeEvent("bash", { command: "echo 'data' > /tmp/x" }), makeCtx());

		// Re-read should pass (cache cleared)
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(result, null, "read after echo > should pass — cache invalidated");
	});

	it("edit and write both clear cache independently", () => {
		const harness = new AgentHarness();

		// Read → edit → re-read passes
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		harness.handleToolCall(
			makeEvent("edit", { path: "a.ts", oldText: "foo", newText: "bar" }),
			makeCtx(),
		);
		assert.equal(
			harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()),
			null,
			"edit clears cache",
		);

		// Read → write → re-read passes
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx());
		harness.handleToolCall(makeEvent("write", { path: "b.ts", content: "x" }), makeCtx());
		assert.equal(
			harness.handleToolCall(makeEvent("read", { path: "b.ts" }), makeCtx()),
			null,
			"write clears cache",
		);
	});
});

// ── Phase 5: Cascade detection ──

describe("AgentHarness cascade detection", () => {
	it("CASCADE_THRESHOLD is at least 8", () => {
		assert.ok(CASCADE_THRESHOLD >= 8);
	});

	it("CACHE_TTL_TURNS is at least 6", () => {
		assert.ok(CACHE_TTL_TURNS >= 6);
	});

	it("cascade blocks only after CASCADE_THRESHOLD consecutive calls (non-read)", () => {
		const harness = new AgentHarness();

		// CASCADE_THRESHOLD - 1 calls → should NOT block
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			const result = harness.handleToolCall(
				makeEvent("write", { path: `f${i}.ts`, content: "" }),
				makeCtx(),
			);
			assert.equal(result, null, `call ${i + 1}/${CASCADE_THRESHOLD - 1} should not block`);
		}

		// CASCADE_THRESHOLD-th call → should block
		const result = harness.handleToolCall(
			makeEvent("write", { path: "block.ts", content: "" }),
			makeCtx(),
		);
		assert.ok(result?.block, `${CASCADE_THRESHOLD}th call should block`);
		assert.ok(result!.reason.includes("Same-tool cascade"), "reason should mention cascade");
	});

	it("cascade blocks after 8 consecutive write calls", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "write", 8, { path: "f.ts", content: "" });
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], null, `call ${i + 1} should pass`);
		}
		assert.ok(results[7]?.block, "8th call should block");
	});

	it("cascade blocks after 8 consecutive bash calls with same subKey", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "echo hi" });
		for (let i = 0; i < 7; i++) {
			assert.equal(results[i], null, `bash echo call ${i + 1} should pass`);
		}
		assert.ok(results[7]?.block, "8th bash echo call should block");
	});

	it("mixed tools do NOT trigger cascade", () => {
		const harness = new AgentHarness();

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
			const result = harness.handleToolCall(makeEvent(tool, args), makeCtx());
			assert.equal(result, null, `mixed tools should not block at index ${i} (${tool})`);
		}
	});

	it("pass-through tools interleaved with read reset cascade", () => {
		const harness = new AgentHarness();

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
			const result = harness.handleToolCall(makeEvent(tool, args), makeCtx());
			assert.equal(
				result,
				null,
				`interleaved pass-through tools should not cause cascade at step ${i} (${tool})`,
			);
		}
	});

	it("pass-through tools never cascade — 15 consecutive ask_user", () => {
		const harness = new AgentHarness();
		for (let i = 0; i < 15; i++) {
			const result = harness.handleToolCall(
				makeEvent("ask_user", { question: `Q${i}?` }),
				makeCtx(),
			);
			assert.equal(result, null, `ask_user call ${i} should NOT be blocked`);
		}
	});

	it("pass-through tools never cascade — 15 consecutive structural_search", () => {
		const harness = new AgentHarness();
		for (let i = 0; i < 15; i++) {
			const result = harness.handleToolCall(
				makeEvent("structural_search", { pattern: "test", language: "ts" }),
				makeCtx(),
			);
			assert.equal(result, null, `structural_search call ${i} should NOT be blocked`);
		}
	});

	it("read cascade is skipped (cache handles redundancy)", () => {
		const harness = new AgentHarness();
		// 8 reads with different paths — none should be blocked by cascade
		for (let i = 0; i < 8; i++) {
			const result = harness.handleToolCall(makeEvent("read", { path: `file${i}.ts` }), makeCtx());
			assert.equal(result, null, `read ${i} should not be blocked by cascade`);
		}
	});
});

// ── Phase 6: Cascade suggestion text ──

describe("AgentHarness cascade suggestion text", () => {
	it("bash cascade WITHOUT && suggests 'Combine bash calls with && or use a script file'", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "echo hi" });
		assert.ok(results[7]?.block);
		assert.ok(
			results[7]!.reason.includes("Combine bash calls with && or use a script file"),
			"blocked echo hi should suggest combined bash calls",
		);
	});

	it("bash cascade WITH && suggests 'Reduce per-turn call count'", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "cd /repo && git status" });
		assert.ok(results[7]?.block);
		assert.ok(
			results[7]!.reason.includes("Reduce per-turn call count"),
			"blocked && command should suggest reducing per-turn count",
		);
		assert.ok(
			!results[7]!.reason.includes("Write a script file"),
			"should not suggest writing a script file for && commands",
		);
	});

	it("bash WITH && in middle of command (npm install && npm test) suggests Reduce per-turn", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "npm install && npm test" });
		assert.ok(results[7]?.block);
		assert.ok(
			results[7]!.reason.includes("Reduce per-turn call count"),
			"blocked npm && command should suggest reducing per-turn count",
		);
	});

	it("non-bash cascade suggests 'Batch <tool> calls'", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.block);
		assert.ok(
			results[7]!.reason.includes("Batch write calls"),
			"non-bash cascade should keep existing suggestion",
		);
	});
});

// ── Phase 7: Error retry block reason ──

describe("AgentHarness error retry reason", () => {
	it("block reason includes error count and last turn", () => {
		const harness = new AgentHarness();

		// 2 errors for read
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		const result = harness.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(result?.block);
		assert.ok(result!.reason.includes("errored"), "should mention error count");
	});
});

// ── Phase 8: Turn boundary cascade reset ──

describe("AgentHarness turn boundary cascade reset", () => {
	it("8 same-subKey bash calls in one turn — 8th blocked", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "echo hi" });
		assert.ok(results[7]?.block, "8th call in same turn should block");
	});

	it("4 same-subKey bash → handleTurnStart → 4 same-subKey bash → none blocked", () => {
		const harness = new AgentHarness();

		// 4 calls in sessionTurn 0
		for (let i = 0; i < 4; i++) {
			const result = harness.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx());
			assert.equal(result, null, `call ${i + 1} in turn 0 should pass`);
		}

		// Turn boundary: reset cascade, increment sessionTurn
		harness.handleTurnStart();

		// 4 more calls in sessionTurn 1
		for (let i = 0; i < 4; i++) {
			const result = harness.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx());
			assert.equal(result, null, `call ${i + 1} in turn 1 should pass (reset by turn boundary)`);
		}
	});

	it("8 write calls in one turn — 8th blocked", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.block, "8th write call in same turn should block");
	});

	it("4 write → handleTurnStart → 4 write → none blocked", () => {
		const harness = new AgentHarness();

		for (let i = 0; i < 4; i++) {
			const result = harness.handleToolCall(
				makeEvent("write", { path: `f${i}.ts`, content: "" }),
				makeCtx(),
			);
			assert.equal(result, null, `write ${i + 1} in turn 0 should pass`);
		}

		// Turn boundary
		harness.handleTurnStart();

		for (let i = 0; i < 4; i++) {
			const result = harness.handleToolCall(
				makeEvent("write", { path: `f${i}.ts`, content: "" }),
				makeCtx(),
			);
			assert.equal(result, null, `write ${i + 1} in turn 1 should pass (reset)`);
		}
	});

	it("cascade resets across multiple turns — 8 across 2 turns bypasses block", () => {
		const harness = new AgentHarness();

		// 4 same-subKey bash in turn 0
		for (let i = 0; i < 4; i++) {
			const result = harness.handleToolCall(makeEvent("bash", { command: "echo same" }), makeCtx());
			assert.equal(result, null, `turn 0 call ${i} should pass`);
		}

		// Turn boundary
		harness.handleTurnStart();

		// 4 more same-subKey bash in turn 1
		for (let i = 0; i < 4; i++) {
			const result = harness.handleToolCall(makeEvent("bash", { command: "echo same" }), makeCtx());
			assert.equal(result, null, `turn 1 call ${i} should pass (reset by turn boundary)`);
		}
	});

	it("turn_start decay does not break error accumulation across turns", () => {
		const harness = new AgentHarness();

		// Error in turn 0
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());

		// turn_start decays from 1→0
		harness.handleTurnStart();

		// Error again in turn 1
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// 1 error, should not block
		const r3 = harness.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.equal(r3, null, "1 error should not block");

		// Error again in turn 1
		harness.handleToolCall(makeEvent("read", { path: "d.ts" }, true), makeCtx());

		// Now 2 errors — should block
		const r5 = harness.handleToolCall(makeEvent("read", { path: "e.ts" }), makeCtx());
		assert.ok(r5?.block, "read should block after 2 new errors");
	});
});

// ── Phase 9: Multi-verb CLI diversity ──

describe("AgentHarness multi-verb CLI diversity", () => {
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

	it("8 npm install calls — 8th blocked", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "npm install" });
		assert.ok(results[7]?.block, "8th npm install should block");
	});

	it("diverse npm sub-commands — all 8 pass", () => {
		const harness = new AgentHarness();
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
			const result = harness.handleToolCall(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `npm cmd ${i} (${commands[i]}) should pass`);
		}
	});

	it("diverse git sub-commands — all 8 pass", () => {
		const harness = new AgentHarness();
		const commands = [
			"git status",
			"git diff",
			"git log",
			"git stash",
			"git branch",
			"git merge",
			"git push",
			"git pull",
		];
		for (let i = 0; i < commands.length; i++) {
			const result = harness.handleToolCall(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `git cmd ${i} (${commands[i]}) should pass`);
		}
	});

	it("diverse docker commands — all 8 pass", () => {
		const harness = new AgentHarness();
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
			const result = harness.handleToolCall(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `docker cmd ${i} (${commands[i]}) should pass`);
		}
	});

	it("diverse gh commands — all 8 pass", () => {
		const harness = new AgentHarness();
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
			const result = harness.handleToolCall(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `gh cmd ${i} (${commands[i]}) should pass`);
		}
	});

	it("mixed CLIs (git/npm/docker/gh) — all pass", () => {
		const harness = new AgentHarness();
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
			const result = harness.handleToolCall(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `mixed cmd ${i} (${commands[i]}) should pass`);
		}
	});

	it("bash subKey resets when switching between different first tokens", () => {
		const harness = new AgentHarness();

		// bash:ls ×4 → bash:cd ×4 → bash:ls ×4 — never blocks
		for (let round = 0; round < 3; round++) {
			for (let i = 0; i < 4; i++) {
				const cmd = round === 1 ? "cd .." : "ls";
				const result = harness.handleToolCall(makeEvent("bash", { command: cmd }), makeCtx());
				assert.equal(result, null, `bash ${cmd} round ${round} call ${i} should pass`);
			}
		}
	});

	it("git push origin main ×8 — 8th blocked (same 2-token subKey)", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "git push origin main" });
		assert.ok(results[7]?.block, "8th git push origin main should block");
	});
});

// ── Phase 10: cd-prefix cascading ──

describe("AgentHarness cd-prefix cascading", () => {
	it("getBashSubKey: cd /repo && git status → 'git status'", () => {
		assert.equal(getBashSubKey("cd /repo && git status"), "git status");
	});

	it("getBashSubKey: cd ~/src && ls -la → 'ls'", () => {
		assert.equal(getBashSubKey("cd ~/src && ls -la"), "ls");
	});

	it("getBashSubKey: cd relative/path && gh issue view 271 → 'gh issue'", () => {
		assert.equal(getBashSubKey("cd relative/path && gh issue view 271"), "gh issue");
	});

	it("getBashSubKey: cd /repo → 'cd' (bare cd)", () => {
		assert.equal(getBashSubKey("cd /repo"), "cd");
	});

	it("getBashSubKey: '' → undefined", () => {
		assert.equal(getBashSubKey(""), undefined);
	});

	it("getBashSubKey: '   ' → undefined", () => {
		assert.equal(getBashSubKey("   "), undefined);
	});

	it("8 cd /repo && git status calls — 8th blocked (same subKey)", () => {
		const harness = new AgentHarness();
		const results = callNTimes(harness, "bash", 8, { command: "cd /repo && git status" });
		assert.ok(results[7]?.block, "8th cd-prefixed git status should block");
	});

	it("diverse cd-prefixed commands — all pass", () => {
		const harness = new AgentHarness();
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
			const result = harness.handleToolCall(makeEvent("bash", { command: commands[i] }), makeCtx());
			assert.equal(result, null, `cd-prefixed cmd ${i} should pass`);
		}
	});

	it("7 ls calls then cd /repo && ls — 8th blocked (same subKey 'ls')", () => {
		const harness = new AgentHarness();

		// 7 bare ls calls
		for (let i = 0; i < 7; i++) {
			const result = harness.handleToolCall(makeEvent("bash", { command: "ls" }), makeCtx());
			assert.equal(result, null, `bare ls call ${i + 1} should pass`);
		}

		// 8th: cd /repo && ls — same subKey 'ls', should be blocked
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "cd /repo && ls" }),
			makeCtx(),
		);
		assert.ok(result?.block, "8th call (cd /repo && ls) should block — same subKey 'ls'");
	});

	it("Mix bare cd and cd-prefixed — both pass (different subKeys)", () => {
		const harness = new AgentHarness();

		// bare cd — subKey 'cd'
		const r1 = harness.handleToolCall(makeEvent("bash", { command: "cd /repo" }), makeCtx());
		assert.equal(r1, null);

		// cd-prefixed ls — subKey 'ls', different from 'cd'
		const r2 = harness.handleToolCall(makeEvent("bash", { command: "cd /repo && ls" }), makeCtx());
		assert.equal(r2, null);
	});
});

// ── Phase 11: Blocked calls not recorded (Bug 5 fix) ──

describe("AgentHarness blocked calls not recorded", () => {
	it("blocked bash grep does NOT inflate cascade counter", () => {
		const harness = new AgentHarness();

		// Blocked call (cat README.md) — subKey "cat", blocked, NOT recorded
		harness.handleToolCall(makeEvent("bash", { command: "cat README.md" }), makeCtx());

		// Legitimate call — should count as first
		let result = harness.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx());
		assert.equal(result, null, "legitimate call after blocked should pass");

		// 7 more identical legitimate calls — 8th total should block
		for (let i = 0; i < 7; i++) {
			result = harness.handleToolCall(makeEvent("bash", { command: "echo hi" }), makeCtx());
		}
		assert.ok(result?.block, "8th legitimate call should be blocked by cascade");
	});

	it("blocked read cache does NOT inflate cascade counter", () => {
		const harness = new AgentHarness();

		// First read passes
		harness.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());

		// Second read same path — blocked by cache
		const blocked = harness.handleToolCall(makeEvent("read", { path: "test.ts" }), makeCtx());
		assert.ok(blocked?.block, "second read same path should be blocked");

		// Third read different path — should pass (counter not incremented by blocked)
		const pass = harness.handleToolCall(makeEvent("read", { path: "other.ts" }), makeCtx());
		assert.equal(pass, null, "read after blocked cache hit should pass");
	});

	it("blocked cascade does NOT inflate cascade counter — different tool clears the block", () => {
		const harness = new AgentHarness();

		// Make 7 calls, then 8th blocked
		for (let i = 0; i < 7; i++) {
			const result = harness.handleToolCall(
				makeEvent("write", { path: `f${i}.ts`, content: "" }),
				makeCtx(),
			);
			assert.equal(result, null, `call ${i} should pass before cascade`);
		}

		// 8th blocked
		const blocked = harness.handleToolCall(
			makeEvent("write", { path: "block.ts", content: "" }),
			makeCtx(),
		);
		assert.ok(blocked?.block, "8th call should be blocked by cascade");

		// After blocked call, different tool resets the cascade counter
		const diffTool = harness.handleToolCall(makeEvent("bash", { command: "echo diff" }), makeCtx());
		assert.equal(diffTool, null, "different tool should pass");

		// Now write again — cascade reset because tool changed
		const after = harness.handleToolCall(
			makeEvent("write", { path: "after.ts", content: "" }),
			makeCtx(),
		);
		assert.equal(
			after,
			null,
			"write after different tool should pass (cascade reset by tool change)",
		);
	});
});

// ── Phase 12: Error retry block format ──

describe("AgentHarness error block format", () => {
	it("bash grep block uses system override format", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", { command: "grep foo" }), makeCtx());
		assert.ok(result?.block);
		assert.ok(result!.reason.includes("[SYSTEM OVERRIDE]"));
		assert.ok(result!.reason.includes("ripgrep_search"));
		assert.ok(result!.reason.includes("JSON Schema"));
	});

	it("bash cat block uses system override format", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "cat README.md" }),
			makeCtx(),
		);
		assert.ok(result?.block);
		assert.ok(result!.reason.includes("[SYSTEM OVERRIDE]"));
		assert.ok(result!.reason.includes("read"));
		assert.ok(result!.reason.includes("JSON Schema"));
	});
});

// ── Phase 13: Reset ──

describe("AgentHarness reset", () => {
	it("reset clears cascade state", () => {
		const harness = new AgentHarness();

		// Build up cascade
		const results = callNTimes(harness, "write", 8, { path: "f.ts", content: "" });
		assert.ok(results[7]?.block, "8th call should block");

		// Reset
		harness.reset();

		// After reset, write should pass
		const after = harness.handleToolCall(
			makeEvent("write", { path: "fresh.ts", content: "" }),
			makeCtx(),
		);
		assert.equal(after, null, "after reset, write should pass");
	});

	it("reset clears error tracker", () => {
		const harness = new AgentHarness();

		// Push 2 errors for read
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }, true), makeCtx());
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// Verify blocked
		const blocked = harness.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx());
		assert.ok(blocked?.block, "should block after 2 errors");

		// Reset
		harness.reset();

		// After reset, read should pass (no errors)
		const after = harness.handleToolCall(makeEvent("read", { path: "d.ts" }), makeCtx());
		assert.equal(after, null, "after reset, read should pass");
	});

	it("reset clears read cache", () => {
		const harness = new AgentHarness();

		// Read caches
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());

		// Reset clears cache
		harness.reset();

		// Re-read same path should pass (cache cleared)
		const result = harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		assert.equal(result, null, "after reset, re-read should pass — cache cleared");
	});

	it("reset creates fully isolated state", () => {
		const harness = new AgentHarness();

		// First session: use some state
		harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx());
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());
		harness.handleToolCall(makeEvent("read", { path: "b.ts" }, true), makeCtx());

		// Reset
		harness.reset();

		// Fresh state: read same file again should pass (cache cleared)
		assert.equal(
			harness.handleToolCall(makeEvent("read", { path: "a.ts" }), makeCtx()),
			null,
			"fresh session — cache cleared",
		);

		// No errors tracked
		assert.equal(
			harness.handleToolCall(makeEvent("read", { path: "c.ts" }), makeCtx()),
			null,
			"fresh session — no error retry",
		);
	});
});

// ── Phase 14: Mock ExtensionAPI integration ──

describe("AgentHarness extension entry point", () => {
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

	it("session_start resets cascade state", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// Fire consecutive write events through dispatch
		for (let i = 0; i < 9; i++) {
			const result = await api.fire("tool_call", {
				type: "tool_call",
				toolCallId: String(i),
				toolName: "write",
				input: { path: `file${i}.ts`, content: "" },
			});
			if (i >= 7) {
				assert.ok(result?.block, `call ${i} should be blocked by cascade`);
			} else {
				assert.ok(result == null, `call ${i} should pass through`);
			}
		}

		// session_start resets
		await api.fire("session_start", { type: "session_start", reason: "new" });

		// After reset, write should not be blocked
		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "reset",
			toolName: "write",
			input: { path: "fresh.ts", content: "" },
		});
		assert.ok(result == null, "after session_start, state should be fresh — no block");
	});

	it("turn_start handler resets cascade — 8 across 2 turns bypasses block", async () => {
		const api = createMockAPI();
		agentHarness(api);

		// 4 calls in first turn
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
		await api.fire("turn_start", {
			type: "turn_start",
			turnIndex: 1,
			timestamp: Date.now(),
		});

		// 4 more calls in second turn
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

	it("bash grep through full dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const result = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "bash",
			input: { command: "grep foo" },
		});
		assert.ok(result?.block, "bash grep should be blocked");
	});

	it("undefined toolName in full dispatch returns null", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			input: { path: "x.ts" },
		});
		assert.ok(r1 == null, "undefined toolName should return null");

		// Fire read — should work normally
		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "a.ts" },
		});
		assert.ok(r2 == null, "read should work normally after undefined toolName");
	});

	it("isError event passthrough in dispatch", async () => {
		const api = createMockAPI();
		agentHarness(api);

		const r1 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "err.ts" },
			isError: true,
		});
		assert.ok(r1 == null, "error event should pass through");

		// Normal read — should work (1 error)
		const r2 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "read",
			input: { path: "ok.ts" },
		});
		assert.ok(r2 == null, "read after single error should pass through");
	});

	it("mixed tools in dispatch — no false cascade", async () => {
		const api = createMockAPI();
		agentHarness(api);

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

	it("ask_user 15 consecutive calls not blocked in dispatch", async () => {
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

	it("edit through dispatch clears cache", async () => {
		const api = createMockAPI();
		agentHarness(api);

		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "1",
			toolName: "read",
			input: { path: "a.ts" },
		});

		await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "2",
			toolName: "edit",
			input: { path: "a.ts", oldText: "foo", newText: "bar" },
		});

		const r3 = await api.fire("tool_call", {
			type: "tool_call",
			toolCallId: "3",
			toolName: "read",
			input: { path: "a.ts" },
		});
		assert.ok(r3 == null, "read after edit through dispatch should pass — cache invalidated");
	});
});

// ── Phase 15: Pipeline pass-through for bash search ──

describe("AgentHarness pipeline pass-through", () => {
	it("piped grep (ls | grep) does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "ls -la | grep foo" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("chained grep with && does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "cd src && rg pattern" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("standalone grep still blocks", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(makeEvent("bash", { command: "grep foo" }), makeCtx());
		assert.ok(result?.block);
	});

	it("xargs grep pipeline does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "find . -type f | xargs grep TODO" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});

	it("semicolon chained grep does NOT block", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			makeEvent("bash", { command: "echo done; grep foo" }),
			makeCtx(),
		);
		assert.equal(result, null);
	});
});
