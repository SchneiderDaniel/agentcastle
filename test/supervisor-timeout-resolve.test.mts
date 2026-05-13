/**
 * Tests for resolveTimeoutMs() — pure timeout resolution function
 * from .pi/extensions/supervisor.ts
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-timeout-resolve.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ─── resolveTimeoutMs (duplicated from supervisor.ts for pure testing) ───

const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

/**
 * Resolve the timeout in milliseconds for a given agent.
 * - Looks up agentTimeoutsMin map by agent name (case-sensitive, exact match)
 * - Returns minutes * 60_000 if found
 * - Falls back to defaultMs (default 1_800_000 = 30 min) if not found or map is empty
 */
export function resolveTimeoutMs(
	agentName: string,
	agentTimeoutsMin: Record<string, number>,
	defaultMs: number = DEFAULT_TIMEOUT_MS,
): number {
	if (!agentTimeoutsMin || typeof agentTimeoutsMin !== "object") {
		return defaultMs;
	}

	const minutes = agentTimeoutsMin[agentName];
	if (minutes !== undefined && typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0) {
		return minutes * 60_000;
	}

	return defaultMs;
}

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
});
