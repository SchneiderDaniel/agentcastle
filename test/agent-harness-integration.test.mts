/**
 * Integration tests for agent-harness/index.ts — pi.on("tool_call") handlers.
 *
 * Phase 3: Adapter layer. Tests that handlers correctly block/redirect.
 * Uses mocked event + ctx objects to call handler functions directly.
 *
 * Run with:
 *   node --experimental-strip-types --test test/agent-harness-integration.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// We import the handler factory and the state type
import { createToolCallHandler } from "../.pi/extensions/agent-harness/index.ts";
import { createHarnessState } from "../src/harness-state.ts";
import type { HarnessState } from "../src/harness-state.ts";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockEvent {
	input: {
		toolName: string;
		args: Record<string, unknown>;
	};
}

interface MockCtx {
	sessionManager?: {
		getCwd?: () => string;
	};
	ui?: {
		notify?: (msg: string, level?: string) => void;
	};
}

function makeEvent(toolName: string, args: Record<string, unknown> = {}): MockEvent {
	return { input: { toolName, args } };
}

function makeCtx(overrides?: Partial<MockCtx>): MockCtx {
	return {
		sessionManager: { getCwd: () => "/repo" },
		ui: { notify: (_msg: string, _level?: string) => {} },
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool_call handler → tool-mismatch blocking", () => {
	it("blocks bash with | grep, suggests ripgrep_search", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const event = makeEvent("bash", { command: "cat file | grep foo" });
		const result = handler(event as any, makeCtx() as any);

		assert.notStrictEqual(result, null, "should block grep in bash");
		assert.strictEqual(result!.block, true, "block should be true");
		assert.ok(result!.reason, "should have reason");
	});

	it("blocks bash cat command, redirects to read", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const event = makeEvent("bash", { command: "cat README.md" });
		const result = handler(event as any, makeCtx() as any);

		assert.notStrictEqual(result, null, "should block cat in bash");
		assert.strictEqual(result!.block, true, "block should be true");
		assert.ok(result!.reason, "should have reason");
	});

	it("passes through npm test (no block)", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const event = makeEvent("bash", { command: "npm test" });
		const result = handler(event as any, makeCtx() as any);

		assert.strictEqual(result, null, "should NOT block npm test");
	});

	it("blocks plain ls command", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const event = makeEvent("bash", { command: "ls" });
		const result = handler(event as any, makeCtx() as any);

		assert.notStrictEqual(result, null, "should block ls");
		assert.strictEqual(result!.block, true, "block should be true");
	});

	it("does NOT block dedicated search tools", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// structural_search
		let event = makeEvent("structural_search", { pattern: "foo", language: "ts" });
		let result = handler(event as any, makeCtx() as any);
		assert.strictEqual(result, null, "structural_search should pass through");

		// ripgrep_search
		event = makeEvent("ripgrep_search", { query: "foo" });
		result = handler(event as any, makeCtx() as any);
		assert.strictEqual(result, null, "ripgrep_search should pass through");

		// ranked_map
		event = makeEvent("ranked_map", {});
		result = handler(event as any, makeCtx() as any);
		assert.strictEqual(result, null, "ranked_map should pass through");
	});
});

describe("tool_call handler → read caching", () => {
	it("returns cached content on second read within TTL", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// First read: not cached, should pass through
		const event1 = makeEvent("read", { path: "/repo/src/app.ts" });
		const result1 = handler(event1 as any, makeCtx() as any);
		assert.strictEqual(result1, null, "first read should pass through");

		// Second read same path, same turn: should be blocked with cached content
		const event2 = makeEvent("read", { path: "/repo/src/app.ts" });
		const result2 = handler(event2 as any, makeCtx() as any);

		assert.notStrictEqual(result2, null, "should block redundant read");
		assert.strictEqual(result2!.block, true, "block should be true");
		assert.ok(result2!.reason!.includes("cache"), "reason should mention cache");
	});

	it("passes through different file reads", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const event1 = makeEvent("read", { path: "/repo/src/a.ts" });
		assert.strictEqual(handler(event1 as any, makeCtx() as any), null, "first read passes");

		const event2 = makeEvent("read", { path: "/repo/src/b.ts" });
		assert.strictEqual(handler(event2 as any, makeCtx() as any), null, "different file passes");
	});
});

describe("tool_call handler → error tracking + retry blocking", () => {
	it("blocks retry of same tool after 2 errors", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Push 2 errors to edit tool (no caching/redirect for edit)
		state.errorTracker.push("edit", { turn: 0, toolName: "edit" });
		state.errorTracker.push("edit", { turn: 1, toolName: "edit" });

		// edit call -> blocked (2 errors accumulated)
		const result = handler(
			makeEvent("edit", { path: "/repo/test.ts", oldText: "a", newText: "b" }) as any,
			makeCtx() as any,
		);
		assert.notStrictEqual(result, null, "should block retry after 2 errors");
		assert.strictEqual(result!.block, true, "block should be true");
		assert.ok(result!.reason!.includes("error"), "reason should mention errors");
	});

	it("does NOT block after single error", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// Push 1 error only
		state.errorTracker.push("edit", { turn: 0, toolName: "edit" });

		// edit call -> not blocked (only 1 error)
		const result = handler(
			makeEvent("edit", { path: "/repo/test.ts", oldText: "a", newText: "b" }) as any,
			makeCtx() as any,
		);
		assert.strictEqual(result, null, "should NOT block after single error");
	});
});

describe("tool_call handler → cascade warning", () => {
	it("warns when read called 4x consecutively", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		// 4 consecutive reads
		for (let i = 0; i < 3; i++) {
			const result = handler(
				makeEvent("read", { path: `/repo/src/file${i}.ts` }) as any,
				makeCtx() as any,
			);
			assert.strictEqual(result, null, `read #${i + 1} should pass through`);
		}

		// 4th consecutive read -> cascade warning
		const result = handler(
			makeEvent("read", { path: "/repo/src/file3.ts" }) as any,
			makeCtx() as any,
		);
		assert.notStrictEqual(result, null, "4th consecutive read should trigger warning");
		assert.strictEqual(result!.block, true, "block should be true");
		assert.ok(result!.reason!.includes("cascade"), "reason should mention cascade");
	});
});

describe("tool_call handler → state initialization", () => {
	it("fresh state has empty cache, empty errors, zero counter", () => {
		const state = createHarnessState();
		assert.strictEqual(state.readCache.get("any", 0), null);
		assert.deepStrictEqual(state.errorTracker.getLastErrors("bash"), []);
		assert.strictEqual(state.callCounter.getConsecutive("bash").count, 0);
	});
});

describe("tool_call handler → edge cases", () => {
	it("does not crash on unknown tool name", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const event = makeEvent("nonexistent_tool", {});
		// Should not throw
		const result = handler(event as any, makeCtx() as any);
		assert.strictEqual(result, null, "unknown tool should pass through");
	});

	it("does not crash on missing args", () => {
		const state = createHarnessState();
		const handler = createToolCallHandler(state);

		const event = makeEvent("bash", {}); // no command arg
		const result = handler(event as any, makeCtx() as any);
		// Should not crash, may block or pass depending on handler logic
		assert.ok(result === null || (result && typeof result.block === "boolean"));
	});
});
