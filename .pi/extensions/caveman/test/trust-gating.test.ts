/**
 * Phase 4: Project trust gating — pure function + use-case tests
 *
 * shouldAppendCavemanEntry(shouldAppendEntry, isTrusted) gates
 * pi.appendEntry("caveman-level") calls on project trust state.
 * Prevents extension state from leaking into untrusted sessions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldAppendCavemanEntry } from "../session.ts";

// ---------------------------------------------------------------------------
// Entity tests: shouldAppendCavemanEntry
// ---------------------------------------------------------------------------

describe("shouldAppendCavemanEntry — pure function", () => {
	it("shouldAppendEntry=true, isTrusted=true → returns true", () => {
		assert.equal(shouldAppendCavemanEntry(true, true), true);
	});

	it("shouldAppendEntry=true, isTrusted=false → returns false", () => {
		assert.equal(shouldAppendCavemanEntry(true, false), false);
	});

	it("shouldAppendEntry=false, isTrusted=true → returns false", () => {
		assert.equal(shouldAppendCavemanEntry(false, true), false);
	});

	it("shouldAppendEntry=false, isTrusted=false → returns false", () => {
		assert.equal(shouldAppendCavemanEntry(false, false), false);
	});
});
