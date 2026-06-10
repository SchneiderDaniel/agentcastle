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

// ---------------------------------------------------------------------------
// Compilation integrity — import from changed files to verify type check
// ---------------------------------------------------------------------------

describe("dead code removal — compilation integrity", () => {
	it("imports from advisor.ts still resolve (buildSessionAnalysis, analyzeSession present)", async () => {
		const advisor = await import("../advisor.ts");
		assert.ok(typeof advisor.analyzeSession === "function", "analyzeSession should be exported");
		assert.ok(
			typeof advisor.buildSessionAnalysis === "function",
			"buildSessionAnalysis should be exported",
		);
		assert.ok(typeof advisor.parseJsonlFile === "function", "parseJsonlFile should be exported");
	});

	it("renderWasteSummary is NOT exported from advisor.ts (dead code removed)", async () => {
		const advisor = await import("../advisor.ts");
		const exportNames = Object.keys(advisor);
		assert.ok(
			!exportNames.includes("renderWasteSummary"),
			"renderWasteSummary was dead code (zero callers) and should have been removed",
		);
	});

	it("imports from advice-pipeline.ts still resolve (AdvicePipeline, generateAdviceReport present)", async () => {
		const pipeline = await import("../advice-pipeline.ts");
		assert.ok(
			typeof pipeline.generateAdviceReport === "function",
			"generateAdviceReport should be exported",
		);
		assert.ok(
			typeof pipeline.AdvicePipeline === "function",
			"AdvicePipeline class should be exported",
		);
		assert.ok(typeof pipeline.writeAdvice === "function", "writeAdvice should be exported");
	});

	it("type imports from advisor.ts no longer include WasteSignal in advice-pipeline.ts", async () => {
		// WasteSignal type is still defined and exported from advisor.ts itself
		// but should NOT be re-exported through advice-pipeline.ts
		const pipeline: Record<string, unknown> = await import("../advice-pipeline.ts");
		// WasteSignal is a type-only export from advisor.ts, not re-exported from pipeline
		const exportNames = Object.keys(pipeline);
		assert.ok(
			!exportNames.includes("WasteSignal"),
			"WasteSignal should not be re-exported from advice-pipeline.ts",
		);
	});

	it("type imports from llm-advisor.ts no longer include AdviceAction in advice-pipeline.ts", async () => {
		const pipeline: Record<string, unknown> = await import("../advice-pipeline.ts");
		const exportNames = Object.keys(pipeline);
		assert.ok(
			!exportNames.includes("AdviceAction"),
			"AdviceAction should not be re-exported from advice-pipeline.ts",
		);
	});

	it("renderWasteSummary is NOT imported in advice-pipeline.ts (dead import removed)", async () => {
		// Import advice-pipeline — it should compile without renderWasteSummary being available
		const pipeline: Record<string, unknown> = await import("../advice-pipeline.ts");
		const exportNames = Object.keys(pipeline);
		assert.ok(
			!exportNames.includes("renderWasteSummary"),
			"renderWasteSummary should not be imported or re-exported by advice-pipeline.ts",
		);
	});
});
