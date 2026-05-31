/**
 * Integration tests for agent-harness — AgentHarness.handleToolCall
 *
 * Tests that handlers block/redirect correctly with mocked event/ctx.
 *
 * Run with:
 *   node --experimental-strip-types --test test/agent-harness-integration.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { CASCADE_THRESHOLD, CACHE_TTL_TURNS } from "../.pi/lib/harness-rules.ts";
import { AgentHarness } from "../.pi/extensions/agent-harness/index.ts";

// ─── Tests ─────────────────────────────────────────────────────────

describe("agent-harness REAL handler (AgentHarness.handleToolCall)", () => {
	it("blocks bash cat file | grep foo (cat read, grep search — cat wins)", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			{ toolName: "bash", input: { command: "cat file | grep foo" } },
			{},
		);
		assert.ok(result !== null, "should block");
		assert.strictEqual(result.block, true);
		assert.ok(result.redirectTo === "read" || result.reason?.includes("read"));
	});

	it("does NOT block npm test", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall({ toolName: "bash", input: { command: "npm test" } }, {});
		assert.strictEqual(result, null, "npm test should pass through");
	});

	it("does NOT block ls -la", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall({ toolName: "bash", input: { command: "ls -la" } }, {});
		assert.strictEqual(result, null, "ls should NOT be blocked at runtime");
	});

	it("passes through structural_search calls", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			{ toolName: "structural_search", input: { pattern: "test", language: "ts" } },
			{},
		);
		assert.strictEqual(result, null, "structural_search should pass through");
	});

	it("first read passes through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		assert.strictEqual(result, null, "first read should pass through");
	});

	it("second read with same path+offset+limit within TTL is cached", () => {
		const harness = new AgentHarness();
		harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		const result = harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		assert.ok(result !== null, "second read should be blocked (cached)");
		assert.strictEqual(result.block, true);
		assert.ok(result.reason?.includes("cached"), "reason should mention cache");
	});

	it("different offset/limit produces different cache key", () => {
		const harness = new AgentHarness();
		harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		const result = harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 50, limit: 20 } },
			{},
		);
		assert.strictEqual(result, null, "different offset should not be blocked");
	});

	it("unknown tool does not crash", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall({ toolName: "unknown_tool_xyz", input: {} }, {});
		assert.strictEqual(result, null, "unknown tool should pass through");
	});
});

describe("agent-harness handler: read caching via real handler", () => {
	it("first read passes through", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		assert.strictEqual(result, null, "first read should pass through");
	});

	it("second read of same path+offset+limit within TTL returns cached", () => {
		const harness = new AgentHarness();
		harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		const result = harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		assert.ok(result !== null, "should block cached read");
		assert.strictEqual(result.block, true);
		assert.ok(result.reason?.includes("cached"), "reason should mention cache");
	});

	it("different offset/limit produces different cache key", () => {
		const harness = new AgentHarness();
		harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		const result = harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 50, limit: 20 } },
			{},
		);
		assert.strictEqual(result, null, "different offset should not be blocked");
	});

	it("read after TTL expiry passes through", () => {
		const harness = new AgentHarness();
		harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);

		// Advance toolCallIndex beyond TTL by making non-read calls
		for (let i = 0; i < CACHE_TTL_TURNS; i++) {
			harness.handleToolCall({ toolName: "bash", input: { command: "ls" } }, {});
		}

		const result = harness.handleToolCall(
			{ toolName: "read", input: { path: "/a.ts", offset: 0, limit: 100 } },
			{},
		);
		assert.strictEqual(result, null, "after TTL expiry should pass through");
	});
});

describe("agent-harness handler: error tracking via real handler", () => {
	it("passes through on first error", () => {
		const harness = new AgentHarness();
		// Simulate error via isError
		harness.handleToolCall({ toolName: "read", input: { path: "a.ts" }, isError: true }, {});
		const result = harness.handleToolCall({ toolName: "read", input: { path: "b.ts" } }, {});
		assert.strictEqual(result, null, "single error should not block");
	});

	it("blocks on 2+ accumulated errors", () => {
		const harness = new AgentHarness();
		harness.handleToolCall({ toolName: "read", input: { path: "a.ts" }, isError: true }, {});
		harness.handleToolCall({ toolName: "read", input: { path: "b.ts" }, isError: true }, {});

		const result = harness.handleToolCall({ toolName: "read", input: { path: "c.ts" } }, {});
		assert.ok(result !== null, "should block on 2 errors");
		assert.strictEqual(result.block, true);
		assert.ok(result.reason?.includes("errored"), "reason should mention errors");
	});
});

describe("agent-harness handler: call counter cascade via real handler", () => {
	it("passes through first CASCADE_THRESHOLD-1 same-tool calls", () => {
		const harness = new AgentHarness();
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			const result = harness.handleToolCall(
				{ toolName: "write", input: { path: `f${i}.ts`, content: "" } },
				{},
			);
			assert.strictEqual(result, null, `call ${i + 1} should pass through`);
		}
	});

	it("blocks on CASCADE_THRESHOLD consecutive same-tool call", () => {
		const harness = new AgentHarness();
		for (let i = 0; i < CASCADE_THRESHOLD - 1; i++) {
			harness.handleToolCall({ toolName: "write", input: { path: `f${i}.ts`, content: "" } }, {});
		}
		const result = harness.handleToolCall(
			{ toolName: "write", input: { path: "block.ts", content: "" } },
			{},
		);
		assert.ok(result !== null, `${CASCADE_THRESHOLD}th call should be blocked`);
		assert.strictEqual(result.block, true);
	});

	it("counter resets on tool change", () => {
		const harness = new AgentHarness();
		for (let i = 0; i < 3; i++) {
			harness.handleToolCall({ toolName: "write", input: { path: `f${i}.ts`, content: "" } }, {});
		}
		harness.handleToolCall({ toolName: "read", input: { path: "a.ts" } }, {});
		const result = harness.handleToolCall(
			{ toolName: "write", input: { path: "after.ts", content: "" } },
			{},
		);
		assert.strictEqual(result, null, "write after tool change should not cascade");
	});
});

describe("agent-harness handler: unknown tool", () => {
	it("does not crash on unknown tool name", () => {
		const harness = new AgentHarness();
		const result = harness.handleToolCall({ toolName: "unknown_tool_xyz", input: {} }, {});
		assert.strictEqual(result, null, "unknown tool should pass through");
	});
});
