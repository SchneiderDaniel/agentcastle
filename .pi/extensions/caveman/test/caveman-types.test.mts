/**
 * Tests for caveman types.ts + prompts.ts
 *
 * Phase 1: Pure type definitions and prompt constants.
 * Zero deps, zero I/O, instant tests.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	LEVELS,
	STOP_ALIASES,
	CAVEMAN_COMMAND_OPTIONS,
	DEFAULT_CONFIG,
} from "../types.ts";
import {
	ANIMATIONS,
	CAVEMAN_BASE,
	INTENSITY,
	FIRE_FRAMES,
} from "../prompts.ts";

// ---------------------------------------------------------------------------
// types.ts
// ---------------------------------------------------------------------------

describe("types.ts — LEVELS", () => {
	it("contains exactly ['off', 'lite', 'full', 'ultra'] in order", () => {
		assert.deepStrictEqual([...LEVELS], ["off", "lite", "full", "ultra"]);
	});

	it("Level type compiles from LEVELS", () => {
		for (const l of LEVELS) {
			assert.strictEqual(typeof l, "string");
		}
	});
});

describe("types.ts — STOP_ALIASES", () => {
	it("contains 'off', 'stop', 'quit'", () => {
		assert.strictEqual(STOP_ALIASES.has("off"), true);
		assert.strictEqual(STOP_ALIASES.has("stop"), true);
		assert.strictEqual(STOP_ALIASES.has("quit"), true);
		assert.strictEqual(STOP_ALIASES.has("lite"), false);
		assert.strictEqual(STOP_ALIASES.size, 3);
	});
});

describe("types.ts — CAVEMAN_COMMAND_OPTIONS", () => {
	it("includes all 7 entries with value, label, description", () => {
		assert.strictEqual(CAVEMAN_COMMAND_OPTIONS.length, 7);
		for (const opt of CAVEMAN_COMMAND_OPTIONS) {
			assert.ok(typeof opt.value === "string");
			assert.ok(typeof opt.label === "string");
			assert.ok(typeof opt.description === "string");
		}
	});
});

describe("types.ts — Animation interface", () => {
	it("ANIMATIONS has entries for lite, full, ultra with correct intervals", () => {
		assert.ok("lite" in ANIMATIONS);
		assert.ok("full" in ANIMATIONS);
		assert.ok("ultra" in ANIMATIONS);
		assert.ok(!("off" in ANIMATIONS));

		assert.strictEqual(ANIMATIONS.lite.interval, 300);
		assert.strictEqual(ANIMATIONS.full.interval, 200);
		assert.strictEqual(ANIMATIONS.ultra.interval, 100);

		for (const key of ["lite", "full", "ultra"] as const) {
			assert.ok(Array.isArray(ANIMATIONS[key].frames));
			assert.strictEqual(typeof ANIMATIONS[key].label, "string");
		}
	});
});

describe("types.ts — CavemanConfig interface", () => {
	it("DEFAULT_CONFIG has defaultLevel 'lite' and showStatus true", () => {
		assert.strictEqual(DEFAULT_CONFIG.defaultLevel, "lite");
		assert.strictEqual(DEFAULT_CONFIG.showStatus, true);
	});
});

// ---------------------------------------------------------------------------
// prompts.ts
// ---------------------------------------------------------------------------

describe("prompts.ts — CAVEMAN_BASE", () => {
	it("includes section headers: Rules, Persistence, Auto-Clarity, Boundaries", () => {
		assert.ok(CAVEMAN_BASE.includes("### Persistence"));
		assert.ok(CAVEMAN_BASE.includes("### Rules"));
		assert.ok(CAVEMAN_BASE.includes("### Auto-Clarity"));
		assert.ok(CAVEMAN_BASE.includes("### Boundaries"));
	});
});

describe("prompts.ts — INTENSITY", () => {
	it("has keys for lite, full, ultra only (not off)", () => {
		assert.ok("lite" in INTENSITY);
		assert.ok("full" in INTENSITY);
		assert.ok("ultra" in INTENSITY);
		assert.ok(!("off" in INTENSITY));
	});

	it("lite includes 'Professional but tight'", () => {
		assert.ok(INTENSITY.lite.includes("Professional but tight"));
	});

	it("full includes 'Drop articles'", () => {
		assert.ok(INTENSITY.full.includes("Drop articles"));
	});

	it("ultra includes 'Abbreviate' and arrow syntax", () => {
		assert.ok(INTENSITY.ultra.includes("Abbreviate"));
		assert.ok(INTENSITY.ultra.includes("→"));
	});
});

describe("prompts.ts — FIRE_FRAMES", () => {
	it("has 8 animation frames", () => {
		assert.strictEqual(FIRE_FRAMES.length, 8);
	});
});
