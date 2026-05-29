/**
 * Integration tests for agent-harness — pi.on("tool_call") handlers
 *
 * Phase 3: Adapter layer integration tests.
 * Tests that handlers block/redirect correctly with mocked event/ctx.
 *
 * Run with:
 *   node --experimental-strip-types --test test/agent-harness-integration.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	isSearchInBash,
	isCatHeadTailInBash,
	isLsInBash,
	shouldBlockRetry,
	suggestRedirection,
	CASCADE_THRESHOLD,
	CACHE_TTL_TURNS,
} from "../.pi/lib/harness-rules.ts";
import { createHarnessState } from "../.pi/lib/harness-state.ts";
import { createToolCallHandler } from "../.pi/extensions/agent-harness/index.ts";

// ─── Handler simulation ────────────────────────────────────────────
//
// We test the HANDLER LOGIC directly by simulating what the pi.on()
// handler would do. This avoids needing a real pi session.
//
// The handler pattern:
//   1. Check tool name
//   2. For bash: check for mismatches via detectMismatchAndSuggest / suggestRedirection
//   3. For read: check cache
//   4. Check error tracker for retry blocking
//   5. Track call counter for cascade detection

interface ToolCallEvent {
	input: {
		toolName: string;
		args: Record<string, unknown>;
	};
}

type HandlerResult = { block: boolean; reason?: string; redirectTo?: string } | null;

/**
 * Simulates the agent-harness tool_call handler logic.
 * Returns the same shape the real pi.on("tool_call") handler would.
 */
function simulateHandler(
	event: ToolCallEvent,
	state: ReturnType<typeof createHarnessState>,
	turn: number,
): HandlerResult {
	const { toolName, args } = event.input;

	// ── bash tool validation ──
	if (toolName === "bash") {
		const cmd = (args.command ?? "") as string;

		// Check for cat/head/tail in bash → redirect to read
		if (isCatHeadTailInBash(cmd)) {
			const redirect = suggestRedirection(cmd);
			return {
				block: true,
				reason: `Use \`read\` tool instead of bash for file inspection`,
				redirectTo: redirect ?? "read",
			};
		}

		// Check for grep/rg in bash → redirect to ripgrep_search
		if (isSearchInBash(cmd)) {
			return {
				block: true,
				reason: `Use \`ripgrep_search\` instead of bash for searching`,
				redirectTo: "ripgrep_search",
			};
		}

		// Check for ls → informational (do NOT block)
		// ls is not blocked at runtime, only flagged post-hoc
	}

	// ── read tool: cache check ──
	if (toolName === "read") {
		const path = (args.path ?? "") as string;
		const offset = (args.offset ?? 0) as number;
		const limit = (args.limit ?? "") as number;
		const cacheKey = `${path}|${offset}|${limit}`;

		const cached = state.readCache.get(cacheKey, turn);
		if (cached !== null) {
			return {
				block: true,
				reason: `Read cached (turn ${cached.turn}) — use offset/limit to page or re-read after 3 turns`,
			};
		}

		// Store in cache after read (simulated)
		state.readCache.set(cacheKey, "<content>", turn);
	}

	// ── error tracking: check for retry loops ──
	const lastErrors = state.errorTracker.getLastErrors(toolName);
	if (shouldBlockRetry(lastErrors.length)) {
		return {
			block: true,
			reason: `Tool \`${toolName}\` errored ${lastErrors.length}x — change approach or use different tool`,
		};
	}

	// ── call counter: track consecutive calls ──
	state.callCounter.record(toolName, turn);
	const consecutive = state.callCounter.getConsecutive(toolName);

	// Warn on cascade (CASCADATE_THRESHOLD consecutive same-tool calls)
	if (consecutive.count >= CASCADE_THRESHOLD) {
		return {
			block: true,
			reason: `\`${toolName}\` called ${consecutive.count}x consecutively since turn ${consecutive.sinceTurn} — merge calls or batch work`,
		};
	}

	// Pass through
	return null;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("agent-harness REAL handler (createToolCallHandler)", () => {
	it("blocks bash cat file | grep foo (cat read, grep search — cat wins)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		const result = handler({ toolName: "bash", input: { command: "cat file | grep foo" } }, {});
		// cat file is first segment — isCatHeadTailInBash blocks it
		assert.ok(result !== null, "should block");
		assert.strictEqual(result.block, true);
		assert.ok(result.redirectTo === "read" || result.reason?.includes("read"));
	});

	it("does NOT block npm test", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		const result = handler({ toolName: "bash", input: { command: "npm test" } }, {});
		assert.strictEqual(result, null, "npm test should pass through");
	});

	it("does NOT block ls -la", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		const result = handler({ toolName: "bash", input: { command: "ls -la" } }, {});
		assert.strictEqual(result, null, "ls should NOT be blocked at runtime");
	});

	it("passes through structural_search calls", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		const result = handler(
			{ toolName: "structural_search", input: { pattern: "test", language: "ts" } },
			{},
		);
		assert.strictEqual(result, null, "structural_search should pass through");
	});

	it("first read passes through", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		const result = handler(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		assert.strictEqual(result, null, "first read should pass through");
	});

	it("second read with same path+offset+limit within TTL is cached", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		handler({ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } }, {});
		const result = handler(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		assert.ok(result !== null, "second read should be blocked (cached)");
		assert.strictEqual(result.block, true);
		assert.ok(result.reason?.includes("cached"), "reason should mention cache");
	});

	it("different offset/limit produces different cache key", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		handler({ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } }, {});
		const result = handler(
			{ toolName: "read", input: { path: "/a.ts", offset: 50, limit: 20 } },
			{},
		);
		assert.strictEqual(result, null, "different offset should not be blocked");
	});

	it("increments currentTurn on each call", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		assert.strictEqual(state.currentTurn, 0, "initial turn should be 0");
		handler({ toolName: "bash", input: { command: "npm test" } }, {});
		assert.strictEqual(state.currentTurn, 1, "after first call should be 1");
		handler({ toolName: "bash", input: { command: "echo hi" } }, {});
		assert.strictEqual(state.currentTurn, 2, "after second call should be 2");
	});

	it("error tracking blocks on 2+ accumulated errors", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		// Simulate 2 errors for a tool
		state.errorTracker.push("bash", { turn: 0, toolName: "bash" });
		state.errorTracker.push("bash", { turn: 1, toolName: "bash" });
		// Third call should be blocked
		const result = handler({ toolName: "bash", input: { command: "npm test" } }, {});
		assert.ok(result !== null, "should block on 2+ errors");
		assert.strictEqual(result.block, true);
	});

	it("unknown tool does not crash", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);
		const result = handler({ toolName: "unknown_tool_xyz", input: {} }, {});
		assert.strictEqual(result, null, "unknown tool should pass through");
	});
});

describe("agent-harness handler: bash tool validation", () => {
	it("blocks bash cat file | grep foo (cat first segment — cat read wins)", () => {
		const state = createHarnessState();
		const result = simulateHandler(
			{ input: { toolName: "bash", args: { command: "cat file | grep foo" } } },
			state,
			0,
		);
		// simulateHandler checks isCatHeadTailInBash first
		assert.ok(result !== null, "should block");
		assert.strictEqual(result.block, true);
		assert.ok(result.redirectTo === "read" || result.reason?.includes("read"));
	});

	it("blocks bash cat README.md with redirect to read", () => {
		const state = createHarnessState();
		const result = simulateHandler(
			{ input: { toolName: "bash", args: { command: "cat README.md" } } },
			state,
			0,
		);
		assert.ok(result !== null, "should block");
		assert.strictEqual(result.block, true);
		assert.ok(result.redirectTo === "read" || result.reason?.includes("read"));
	});

	it("does NOT block npm test (pass through)", () => {
		const state = createHarnessState();
		const result = simulateHandler(
			{ input: { toolName: "bash", args: { command: "npm test" } } },
			state,
			0,
		);
		assert.strictEqual(result, null, "should pass through");
	});

	it("does NOT block plain ls (no redirect)", () => {
		const state = createHarnessState();
		const result = simulateHandler(
			{ input: { toolName: "bash", args: { command: "ls -la" } } },
			state,
			0,
		);
		assert.strictEqual(result, null, "ls should NOT be blocked at runtime");
	});

	it("passes through structural_search calls", () => {
		const state = createHarnessState();
		const result = simulateHandler(
			{ input: { toolName: "structural_search", args: { pattern: "test", language: "ts" } } },
			state,
			0,
		);
		assert.strictEqual(result, null, "should pass through");
	});

	it("passes through ripgrep_search calls", () => {
		const state = createHarnessState();
		const result = simulateHandler(
			{ input: { toolName: "ripgrep_search", args: { query: "test" } } },
			state,
			0,
		);
		assert.strictEqual(result, null, "should pass through");
	});
});

describe("agent-harness handler: read caching", () => {
	it("first read passes through", () => {
		const state = createHarnessState();
		const result = simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 0, limit: 100 } } },
			state,
			0,
		);
		assert.strictEqual(result, null, "first read should pass through");
	});

	it("second read of same path+offset+limit within TTL returns cached", () => {
		const state = createHarnessState();
		simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 0, limit: 100 } } },
			state,
			0,
		);
		const result = simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 0, limit: 100 } } },
			state,
			0,
		);
		assert.ok(result !== null, "should block cached read");
		assert.strictEqual(result.block, true);
		assert.ok(result.reason?.includes("cached"), "reason should mention cache");
	});

	it("different offset/limit produces different cache key", () => {
		const state = createHarnessState();
		simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 0, limit: 100 } } },
			state,
			0,
		);
		const result = simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 50, limit: 20 } } },
			state,
			0,
		);
		assert.strictEqual(result, null, "different offset should not be blocked");
	});

	it("read after TTL expiry passes through", () => {
		const state = createHarnessState();
		simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 0, limit: 100 } } },
			state,
			0,
		);
		const result = simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 0, limit: 100 } } },
			state,
			CACHE_TTL_TURNS, // turn diff >= TTL = expired
		);
		assert.strictEqual(result, null, "after TTL expiry should pass through");
	});
});

describe("agent-harness handler: error tracking", () => {
	it("passes through on first error", () => {
		const state = createHarnessState();
		state.errorTracker.push("npm", { turn: 0, toolName: "npm" });
		const result = simulateHandler(
			{ input: { toolName: "npm", args: { command: "npm test" } } },
			state,
			1,
		);
		assert.strictEqual(result, null, "single error should not block");
	});

	it("blocks on 2+ accumulated errors", () => {
		const state = createHarnessState();
		state.errorTracker.push("npm", { turn: 0, toolName: "npm" });
		state.errorTracker.push("npm", { turn: 1, toolName: "npm" });

		const result = simulateHandler(
			{ input: { toolName: "npm", args: { command: "npm install" } } },
			state,
			2,
		);
		assert.ok(result !== null, "should block on 2 errors");
		assert.strictEqual(result.block, true);
		assert.ok(result.reason?.includes("errored"), "reason should mention errors");
	});
});

describe("agent-harness handler: call counter cascade", () => {
	it("passes through first CASCADE_THRESHOLD-1 same-tool calls", () => {
		const state = createHarnessState();
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			const result = simulateHandler(
				{ input: { toolName: "bash", args: { command: `echo ${i}` } } },
				state,
				0,
			);
			assert.strictEqual(result, null, `call ${i + 1} should pass through`);
		}
	});

	it("blocks on CASCADE_THRESHOLD consecutive same-tool call", () => {
		const state = createHarnessState();
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			simulateHandler({ input: { toolName: "bash", args: { command: `echo ${i}` } } }, state, 0);
		}
		const result = simulateHandler(
			{ input: { toolName: "bash", args: { command: "echo block" } } },
			state,
			0,
		);
		assert.ok(result !== null, `${CASCADE_THRESHOLD}th call should be blocked`);
		assert.strictEqual(result.block, true);
		assert.ok(result.reason?.includes("consecutively"), "reason should mention consecutive");
	});

	it("counter resets on tool change", () => {
		const state = createHarnessState();
		for (let i = 0; i < 3; i++) {
			simulateHandler({ input: { toolName: "bash", args: { command: `echo ${i}` } } }, state, 0);
		}
		simulateHandler(
			{ input: { toolName: "read", args: { path: "/a.ts", offset: 0, limit: 100 } } },
			state,
			0,
		);
		const result = simulateHandler(
			{ input: { toolName: "bash", args: { command: "echo after" } } },
			state,
			0,
		);
		assert.strictEqual(result, null, "bash after tool change should not cascade");
	});
});

describe("agent-harness handler: unknown tool", () => {
	it("does not crash on unknown tool name", () => {
		const state = createHarnessState();
		const result = simulateHandler({ input: { toolName: "unknown_tool_xyz", args: {} } }, state, 0);
		assert.strictEqual(result, null, "unknown tool should pass through");
	});
});
