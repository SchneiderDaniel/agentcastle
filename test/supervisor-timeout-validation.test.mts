/**
 * Tests for validateAgentTimeouts() — pure validation function
 * from .pi/extensions/supervisor.ts
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-timeout-validation.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";

// ─── validateAgentTimeouts (duplicated from supervisor.ts for pure testing) ───

/**
 * Validate the raw agentTimeoutsMin config value.
 * Returns a sanitized Record<string, number>.
 * - undefined/null/empty → {}
 * - Positive integers only
 * - Unknown agent names: warn and strip
 * - Non-integer / non-positive → throw
 */
export function validateAgentTimeouts(
	raw: unknown,
	knownAgents: string[],
): Record<string, number> {
	// Handle undefined/null
	if (raw === undefined || raw === null) {
		return {};
	}

	// Must be an object
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		throw new Error(
			`agentTimeoutsMin must be an object, got ${typeof raw}`,
		);
	}

	const record = raw as Record<string, unknown>;
	const result: Record<string, number> = {};

	for (const [key, value] of Object.entries(record)) {
		// Check if agent name is known
		if (!knownAgents.includes(key)) {
			console.warn(
				`agentTimeoutsMin: unknown agent "${key}" — entry ignored`,
			);
			continue;
		}

		// Validate value
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			throw new Error(
				`agentTimeoutsMin.${key} must be a positive integer, got ${JSON.stringify(value)}`,
			);
		}

		result[key] = value;
	}

	return result;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("validateAgentTimeouts", () => {
	const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];

	it("valid config returns sanitized map", () => {
		const result = validateAgentTimeouts(
			{ developer: 60, auditor: 10 },
			knownAgents,
		);
		assert.deepStrictEqual(result, { developer: 60, auditor: 10 });
	});

	it("empty object returns {}", () => {
		const result = validateAgentTimeouts({}, knownAgents);
		assert.deepStrictEqual(result, {});
	});

	it("undefined returns {}", () => {
		const result = validateAgentTimeouts(undefined, knownAgents);
		assert.deepStrictEqual(result, {});
	});

	it("null returns {}", () => {
		const result = validateAgentTimeouts(null, knownAgents);
		assert.deepStrictEqual(result, {});
	});

	it("value 0 throws", () => {
		assert.throws(
			() => validateAgentTimeouts({ developer: 0 }, knownAgents),
			/agentTimeoutsMin\.developer must be a positive integer, got 0/,
		);
	});

	it("value -5 throws", () => {
		assert.throws(
			() => validateAgentTimeouts({ developer: -5 }, knownAgents),
			/agentTimeoutsMin\.developer must be a positive integer, got -5/,
		);
	});

	it("value 3.5 throws", () => {
		assert.throws(
			() => validateAgentTimeouts({ developer: 3.5 }, knownAgents),
			/agentTimeoutsMin\.developer must be a positive integer, got 3\.5/,
		);
	});

	it("string value throws", () => {
		assert.throws(
			() => validateAgentTimeouts({ developer: "sixty" }, knownAgents),
			/agentTimeoutsMin\.developer must be a positive integer, got "sixty"/,
		);
	});

	it("unknown agent name logs warning and is stripped", () => {
		const warnSpy = mock.method(console, "warn", () => {});
		const result = validateAgentTimeouts(
			{ develper: 10 },
			knownAgents,
		);
		assert.deepStrictEqual(result, {});
		assert.ok(warnSpy.mock.calls.length >= 1);
		const warnMsg = warnSpy.mock.calls[0]?.arguments[0];
		assert.ok((warnMsg as string)?.includes("develper"));
		mock.reset();
	});

	it("mixed valid + unknown returns only valid", () => {
		const warnSpy = mock.method(console, "warn", () => {});
		const result = validateAgentTimeouts(
			{ developer: 60, develper: 10 },
			knownAgents,
		);
		assert.deepStrictEqual(result, { developer: 60 });
		assert.ok(warnSpy.mock.calls.length >= 1);
		mock.reset();
	});

	it("knownAgents empty — all entries stripped", () => {
		const warnSpy = mock.method(console, "warn", () => {});
		const result = validateAgentTimeouts(
			{ developer: 60, auditor: 10 },
			[],
		);
		assert.deepStrictEqual(result, {});
		// Both should trigger warnings
		assert.ok(warnSpy.mock.calls.length >= 2);
		mock.reset();
	});

	it("non-object input (array) throws", () => {
		assert.throws(
			() => validateAgentTimeouts([1, 2, 3], knownAgents),
			/must be an object/,
		);
	});

	it("non-object input (string) throws", () => {
		assert.throws(
			() => validateAgentTimeouts("foo", knownAgents),
			/must be an object/,
		);
	});
});
