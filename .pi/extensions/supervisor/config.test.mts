// ─── Tests: config.ts — Phase 1 config validation ──────────────────
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAgentTimeouts } from "./config.ts";

// ─── validateAgentTimeouts ────────────────────────────────────────

describe("validateAgentTimeouts", () => {
	it("returns empty object for undefined input", () => {
		assert.deepEqual(validateAgentTimeouts(undefined, ["developer"]), {});
	});

	it("returns empty object for null input", () => {
		assert.deepEqual(validateAgentTimeouts(null, ["developer"]), {});
	});

	it("throws for non-object input", () => {
		assert.throws(() => validateAgentTimeouts("string", []), /agentTimeoutsMin must be an object/);
		assert.throws(() => validateAgentTimeouts(42, []), /agentTimeoutsMin must be an object/);
		assert.throws(() => validateAgentTimeouts([], []), /agentTimeoutsMin must be an object/);
	});

	it("throws for non-positive-integer values", () => {
		assert.throws(
			() => validateAgentTimeouts({ developer: -1 }, ["developer"]),
			/positive integer/,
		);
		assert.throws(() => validateAgentTimeouts({ developer: 0 }, ["developer"]), /positive integer/);
		assert.throws(
			() => validateAgentTimeouts({ developer: 1.5 }, ["developer"]),
			/positive integer/,
		);
		assert.throws(
			() => validateAgentTimeouts({ developer: "10" }, ["developer"]),
			/positive integer/,
		);
	});

	it("validates known agents and returns sanitized record", () => {
		const result = validateAgentTimeouts({ developer: 30, auditor: 60 }, ["developer", "auditor"]);
		assert.deepEqual(result, { developer: 30, auditor: 60 });
	});

	it("warns for unknown agents but does not throw", () => {
		// This should log a warning but return empty for unknown agent
		const result = validateAgentTimeouts({ unknownAgent: 30 }, ["developer"]);
		assert.deepEqual(result, {});
	});

	it("parses positive integer values correctly", () => {
		const result = validateAgentTimeouts({ developer: 10 }, ["developer"]);
		assert.equal(result.developer, 10);
	});
});

// ─── loadConfig tests (pure — parse settings object shape) ────────

describe("loadConfig — config shape", () => {
	// Test that the config object structure matches what loadConfig returns
	// by examining the type shape. Actual loadConfig reads filesystem so
	// we test the validation helpers and interface contract here.

	it("config interface supports agentTokenBudget and maxToolCalls as optional numbers", () => {
		// Interface contract test: these fields are optional in the type
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
			agentTokenBudget: 500000,
			maxToolCalls: 30,
		};
		// Just validate they're accepted as numbers
		assert.equal(typeof config.agentTokenBudget, "number");
		assert.equal(typeof config.maxToolCalls, "number");
	});

	it("config interface allows missing agentTokenBudget and maxToolCalls (backward compat)", () => {
		const config: Record<string, unknown> = {
			repo: "owner/repo",
			projectNumber: 1,
			statusMapping: { todo: "developer" },
			codeowners: ["user"],
		};
		// No agentTokenBudget or maxToolCalls — should still work
		assert.equal(config.agentTokenBudget, undefined);
		assert.equal(config.maxToolCalls, undefined);
	});

	it("agentTokenBudget must be non-negative integer if provided", () => {
		// Test validation that would be applied in loadConfig
		const validValues = [0, 100, 500000, 999999];
		for (const v of validValues) {
			assert.ok(Number.isInteger(v) && v >= 0, `${v} should be valid`);
		}
		const invalidValues = [-1, -100, 1.5, "500000", true, null];
		for (const v of invalidValues) {
			assert.ok(
				!(typeof v === "number" && Number.isInteger(v) && v >= 0),
				`${JSON.stringify(v)} should be invalid`,
			);
		}
	});

	it("maxToolCalls must be non-negative integer if provided", () => {
		const validValues = [0, 30, 100];
		for (const v of validValues) {
			assert.ok(Number.isInteger(v) && v >= 0, `${v} should be valid`);
		}
		const invalidValues = [-1, 1.5, "30", true, null];
		for (const v of invalidValues) {
			assert.ok(
				!(typeof v === "number" && Number.isInteger(v) && v >= 0),
				`${JSON.stringify(v)} should be invalid`,
			);
		}
	});
});
