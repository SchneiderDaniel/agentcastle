/**
 * Tests for resolveTimeoutMs() — pure timeout resolution function
 * from .pi/extensions/supervisor.ts
 *
 * Imports the real resolveTimeoutMs via createRequire (not a duplicate).
 *
 * Run with:
 *   npx tsx --test test/supervisor-timeout-resolve.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

// Use createRequire to import CJS module from ESM test context.
// tsx transpiles supervisor.ts and makes its exports available via require().
const require = createRequire(import.meta.url);
const {
	resolveTimeoutMs,
	DEFAULT_AGENT_TIMEOUT_MS,
} = require("../.pi/extensions/supervisor.ts");

// ─── Tests ──────────────────────────────────────────────────────────

describe("resolveTimeoutMs", () => {
	it("developer with 60 min → 3_600_000 ms", () => {
		const result = resolveTimeoutMs("developer", { developer: 60 });
		assert.strictEqual(result, 3_600_000);
	});

	it("auditor not in map → default 1_800_000", () => {
		const result = resolveTimeoutMs("auditor", { developer: 60 });
		assert.strictEqual(result, 1_800_000);
	});

	it("empty map → default 1_800_000", () => {
		const result = resolveTimeoutMs("developer", {});
		assert.strictEqual(result, 1_800_000);
	});

	it("undefined map → default 1_800_000", () => {
		const result = resolveTimeoutMs("developer", undefined as any);
		assert.strictEqual(result, 1_800_000);
	});

	it("case-sensitive: 'Developer' vs 'developer' → default", () => {
		const result = resolveTimeoutMs("Developer", { developer: 60 });
		assert.strictEqual(result, 1_800_000);
	});

	it("1 minute → 60_000 ms", () => {
		const result = resolveTimeoutMs("developer", { developer: 1 });
		assert.strictEqual(result, 60_000);
	});

	it("custom defaultMs parameter works", () => {
		const result = resolveTimeoutMs("auditor", { developer: 60 }, 600_000);
		assert.strictEqual(result, 600_000);
	});

	it("null map → default", () => {
		const result = resolveTimeoutMs("developer", null as any);
		assert.strictEqual(result, 1_800_000);
	});

	it("DEFAULT_AGENT_TIMEOUT_MS is 1_800_000 (30 minutes)", () => {
		assert.strictEqual(DEFAULT_AGENT_TIMEOUT_MS, 1_800_000);
	});
});
