/**
 * Tests verifying dead code removal for session-logger
 *
 * recoverMissingReports was dead code — defined and re-exported but never
 * called. The actual recovery logic lives in pipeline.ts::recoverPastSessions(),
 * which calls generateMissingReports directly.
 *
 * waitForFile / WaitForFileOptions were dead code — exported from files.ts but
 * never imported or called in any production code. Only their own test file
 * referenced them.
 *
 * These tests verify the functions/interfaces are no longer exported after
 * removal.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-dead-code.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

describe("recoverMissingReports dead code removal", () => {
	// After removal: importing recoverMissingReports from index.ts should fail
	// or the value should be undefined. Use dynamic import to check at runtime.
	it("should NOT be exported from index.ts (was dead code — pipeline.ts::recoverPastSessions handles recovery)", async () => {
		const mod = await import("../index.ts");
		const modAny = mod as Record<string, unknown>;
		assert.strictEqual(
			typeof modAny.recoverMissingReports,
			"undefined",
			"recoverMissingReports must be removed — pipeline.ts::recoverPastSessions handles recovery inline",
		);
	});

	// Confirm no collateral damage — generateMissingReports must still be exported
	it("generateMissingReports should still be exported from index.ts", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.generateMissingReports, "function");
	});
});

describe("waitForFile dead code removal", () => {
	// After removal: importing waitForFile from files.ts should yield undefined
	it("waitForFile should NOT be exported from files.ts (dead code — no production callers)", async () => {
		const mod = await import("../files.ts");
		const modAny = mod as Record<string, unknown>;
		assert.strictEqual(
			typeof modAny.waitForFile,
			"undefined",
			"waitForFile must be removed — it had zero production callers",
		);
	});

	// Confirm no collateral damage — adjacent exports must still be intact
	it("createFileOps should still be exported from files.ts", async () => {
		const mod = await import("../files.ts");
		assert.strictEqual(typeof mod.createFileOps, "function");
	});

	it("createAtomicSymlink should still be exported from files.ts", async () => {
		const mod = await import("../files.ts");
		assert.strictEqual(typeof mod.createAtomicSymlink, "function");
	});
});
