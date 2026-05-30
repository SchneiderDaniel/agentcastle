/**
 * Tests for session-advice getSessionAdviceState() export
 *
 * Run with:
 *   node --experimental-strip-types --test test/session-advice-state.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// These will be implemented after tests are written
import { getSessionAdviceState } from "../.pi/extensions/session-advice/index.ts";

describe("getSessionAdviceState", () => {
	it("module initial state: enabled=true → returns true", () => {
		// Default state from module-level declaration
		assert.strictEqual(getSessionAdviceState(), true);
	});

	it("module always returns a value (null only for unloaded extensions — not applicable since this IS the extension)", () => {
		const state = getSessionAdviceState();
		// The module exports this function, so it's always loaded
		// null is returned from a separate loading context (e.g., import failure)
		assert.ok(state === true || state === false, "state should be boolean");
	});
});
