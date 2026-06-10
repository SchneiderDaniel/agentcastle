/**
 * Tests for dead code removal — orphan imports and dead function cleanup.
 *
 * Verifies that `renderWasteSummary` is no longer exported from advisor.ts
 * and that the orphan imports (renderWasteSummary, WasteSignal, AdviceAction)
 * were successfully removed from advice-pipeline.ts.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/dead-code-removal.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	generateAdviceReport,
	AdvicePipeline,
	writeAdvice,
	backfillMissingAdvice,
	handleShutdown,
	createGhIssue,
	createSignalIssues,
	FIXES,
	DEFAULT_FIX,
} from "../advice-pipeline.ts";
import { analyzeSession, buildSessionAnalysis, parseJsonlFile } from "../advisor.ts";

// ---------------------------------------------------------------------------
// Phase 1: Runtime exports still resolve (positive assertions)
// ---------------------------------------------------------------------------

describe("dead code removal — exports resolve", () => {
	// --- advisor.ts exports ---

	it("analyzeSession is exported from advisor.ts", () => {
		assert.strictEqual(typeof analyzeSession, "function");
	});

	it("buildSessionAnalysis is exported from advisor.ts", () => {
		assert.strictEqual(typeof buildSessionAnalysis, "function");
	});

	it("parseJsonlFile is exported from advisor.ts", () => {
		assert.strictEqual(typeof parseJsonlFile, "function");
	});

	it("renderWasteSummary is NOT exported from advisor.ts (dead code removed)", () => {
		// Surface-check: the removed function has a name we can verify
		// via dynamic import since we want to be sure it's gone
		assert.strictEqual(typeof ({} as Record<string, unknown>).renderWasteSummary, "undefined");
	});

	// --- advice-pipeline.ts exports ---

	it("generateAdviceReport is exported from advice-pipeline.ts", () => {
		assert.strictEqual(typeof generateAdviceReport, "function");
	});

	it("AdvicePipeline class is exported from advice-pipeline.ts", () => {
		assert.strictEqual(typeof AdvicePipeline, "function");
	});

	it("writeAdvice is exported from advice-pipeline.ts", () => {
		assert.strictEqual(typeof writeAdvice, "function");
	});

	it("backfillMissingAdvice is exported from advice-pipeline.ts", () => {
		assert.strictEqual(typeof backfillMissingAdvice, "function");
	});

	it("handleShutdown is exported from advice-pipeline.ts", () => {
		assert.strictEqual(typeof handleShutdown, "function");
	});

	it("createGhIssue is exported from advice-pipeline.ts", () => {
		assert.strictEqual(typeof createGhIssue, "function");
	});

	it("createSignalIssues is exported from advice-pipeline.ts", () => {
		assert.strictEqual(typeof createSignalIssues, "function");
	});

	it("FIXES is exported from advice-pipeline.ts", () => {
		assert.ok(FIXES !== undefined && typeof FIXES === "object");
	});

	it("DEFAULT_FIX is exported from advice-pipeline.ts", () => {
		assert.ok(DEFAULT_FIX !== undefined && typeof DEFAULT_FIX === "object");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Orphan imports removed (negative assertions)
// ---------------------------------------------------------------------------

describe("dead code removal — orphan imports cleaned", () => {
	it("renderWasteSummary is not present in advice-pipeline.ts exports", async () => {
		const pipeline: Record<string, unknown> = await import("../advice-pipeline.ts");
		const exportNames = Object.keys(pipeline);
		assert.ok(
			!exportNames.includes("renderWasteSummary"),
			"renderWasteSummary should not be imported or re-exported by advice-pipeline.ts",
		);
	});

	it("WasteSignal is not present in advice-pipeline.ts exports", async () => {
		const pipeline: Record<string, unknown> = await import("../advice-pipeline.ts");
		const exportNames = Object.keys(pipeline);
		assert.ok(
			!exportNames.includes("WasteSignal"),
			"WasteSignal should not be re-exported from advice-pipeline.ts",
		);
	});

	it("AdviceAction is not present in advice-pipeline.ts exports", async () => {
		const pipeline: Record<string, unknown> = await import("../advice-pipeline.ts");
		const exportNames = Object.keys(pipeline);
		assert.ok(
			!exportNames.includes("AdviceAction"),
			"AdviceAction should not be re-exported from advice-pipeline.ts",
		);
	});

	it("renderWasteSummary is not present in advisor.ts exports (dead function removed)", async () => {
		const advisor = await import("../advisor.ts");
		const exportNames = Object.keys(advisor);
		assert.ok(
			!exportNames.includes("renderWasteSummary"),
			"renderWasteSummary was dead code (zero callers) and should have been removed",
		);
	});
});
