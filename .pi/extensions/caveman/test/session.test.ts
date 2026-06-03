/**
 * Phase 2 + Phase 3: Session-level resolver as pure function
 *
 * Architecture extracts session-start decision into pure function
 * resolveSessionLevel(config, sessionEntries) for testability.
 * Phase 3: session_shutdown level reset verify getLevel returns "off".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionLevel, resetSessionLevel } from "../session.ts";
import type { Level } from "../types.ts";
import type { CavemanConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(level: Level) {
	return { type: "custom", customType: "caveman-level", data: { level } };
}

function config(overrides: Partial<CavemanConfig> = {}): CavemanConfig {
	return { defaultLevel: "lite", showStatus: true, ...overrides };
}

// ---------------------------------------------------------------------------
// Phase 2: Session-level resolver
// ---------------------------------------------------------------------------

describe("resolveSessionLevel (pure function)", () => {
	it("new session, defaultLevel=off, empty entries → returns off, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "off" }), []);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("new session, defaultLevel=lite, empty entries → returns lite, shouldAppendEntry=true", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), []);
		assert.equal(result.level, "lite");
		assert.equal(result.shouldAppendEntry, true);
	});

	it("new session, defaultLevel=full, empty entries → returns full, shouldAppendEntry=true", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), []);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, true);
	});

	it("resume session, defaultLevel=off, session entry full → returns full, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "off" }), [entry("full")]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("resume session, defaultLevel=lite, session entry ultra → returns ultra, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [entry("ultra")]);
		assert.equal(result.level, "ultra");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("resume session, defaultLevel=full, session entry off → returns off, shouldAppendEntry=false", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), [entry("off")]);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("boundary: new session, defaultLevel=off, empty entries → shouldAppendEntry=false (no off entry logged)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "off" }), []);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("session entries contain non-caveman entries only → treats as new session, applies defaultLevel", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), [
			{ type: "custom", customType: "other-type", data: { foo: "bar" } },
		]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, true);
	});

	// ---------------------------------------------------------------------------
	// Bug #475: resolveSessionLevel must return LAST matching entry, not first
	// ---------------------------------------------------------------------------

	it("multiple level changes: lite→full→ultra → returns ultra (last)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [
			entry("lite"),
			entry("full"),
			entry("ultra"),
		]);
		assert.equal(result.level, "ultra");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("multiple level changes: lite→full → returns full (last)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [
			entry("lite"),
			entry("full"),
		]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("multiple level changes: full→ultra→off → returns off (last)", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "full" }), [
			entry("full"),
			entry("ultra"),
			entry("off"),
		]);
		assert.equal(result.level, "off");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("interleaved: non-caveman entries between level changes → returns last caveman-level", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [
			{ type: "custom", customType: "other-type", data: { foo: "bar" } },
			entry("lite"),
			{ type: "custom", customType: "other-type", data: { baz: "qux" } },
			entry("full"),
			{ type: "custom", customType: "text-message", data: { text: "some message" } },
			entry("ultra"),
		]);
		assert.equal(result.level, "ultra");
		assert.equal(result.shouldAppendEntry, false);
	});

	it("single entry: resume with one caveman-level entry → returns that level", () => {
		const result = resolveSessionLevel(config({ defaultLevel: "lite" }), [entry("full")]);
		assert.equal(result.level, "full");
		assert.equal(result.shouldAppendEntry, false);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: session_shutdown level reset
// ---------------------------------------------------------------------------

describe("resetSessionLevel (session_shutdown)", () => {
	it("resets from full to off", () => {
		assert.equal(resetSessionLevel("full"), "off");
	});

	it("resets from ultra to off", () => {
		assert.equal(resetSessionLevel("ultra"), "off");
	});

	it("idempotent: resetting off returns off", () => {
		assert.equal(resetSessionLevel("off"), "off");
	});
});
