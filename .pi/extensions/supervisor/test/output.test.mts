// ─── Tests: pipeline/output.ts — buildPipelineSummary with Closes #N ──
// Phase 2: Verify Closes #N line appears in PR body for GitHub cross-reference.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPipelineSummary } from "../pipeline/output.ts";
import type { PipelineAgentResult, SupervisorConfig, PrCreationResult } from "../config/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────

const defaultConfig: SupervisorConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {},
	codeowners: ["@owner"],
};

const emptyResults: PipelineAgentResult[] = [];

// ─── Tests: Closes #N in buildPipelineSummary ─────────────────────

describe("buildPipelineSummary — Closes #N line", () => {
	it("contains Closes #N when issueNum is provided", () => {
		const output = buildPipelineSummary(emptyResults, "success", 42, "Some title", defaultConfig);
		assert.ok(output.includes("Closes #42"), "Should contain Closes #42");
	});

	it("places Closes #N immediately after issue URL with no intervening content", () => {
		const output = buildPipelineSummary(emptyResults, "success", 42, "Some title", defaultConfig);
		const issueLineIdx = output.indexOf("**Issue:** https://github.com/owner/repo/issues/42");
		const closesLineIdx = output.indexOf("Closes #42");
		assert.ok(issueLineIdx >= 0, "Issue URL line present");
		assert.ok(closesLineIdx >= 0, "Closes #N line present");
		// Closes #N should come right after issue URL line
		const afterIssue = output.slice(issueLineIdx);
		const linesAfterIssue = afterIssue.split("\n");
		assert.ok(linesAfterIssue[0].includes("**Issue:**"), "First line is issue URL");
		assert.ok(linesAfterIssue[1].includes("Closes #42"), "Second line is Closes #42");
	});

	it("works for boundary issue number 1", () => {
		const output = buildPipelineSummary(emptyResults, "success", 1, "Title", defaultConfig);
		assert.ok(output.includes("Closes #1"), "Should contain Closes #1");
	});

	it("works for large issue number 99999", () => {
		const output = buildPipelineSummary(emptyResults, "success", 99999, "Title", defaultConfig);
		assert.ok(output.includes("Closes #99999"), "Should contain Closes #99999");
	});

	it("works for issue number 0", () => {
		const output = buildPipelineSummary(emptyResults, "success", 0, "Title", defaultConfig);
		assert.ok(output.includes("Closes #0"), "Should contain Closes #0");
	});

	it("contains Closes #N when prCreationResult is provided (success)", () => {
		const prResult: PrCreationResult = {
			success: true,
			prNumber: 100,
		};
		const output = buildPipelineSummary(
			emptyResults,
			"success",
			42,
			"Title",
			defaultConfig,
			undefined,
			prResult,
		);
		assert.ok(output.includes("Closes #42"), "Should contain Closes #42");
		assert.ok(output.includes("#100"), "Should contain PR number reference");
		assert.ok(output.includes("created"), "Should indicate PR was created");
	});

	it("contains Closes #N when prCreationResult is provided (failure)", () => {
		const prResult: PrCreationResult = {
			success: false,
			error: "Network error",
		};
		const output = buildPipelineSummary(
			emptyResults,
			"success",
			42,
			"Title",
			defaultConfig,
			undefined,
			prResult,
		);
		assert.ok(output.includes("Closes #42"), "Should contain Closes #42");
		assert.ok(output.includes("PR creation failed"), "Should mention failure");
	});

	it("does NOT include Closes #N line before the issue URL line", () => {
		const output = buildPipelineSummary(emptyResults, "success", 42, "Title", defaultConfig);
		const issueIdx = output.indexOf("**Issue:**");
		const closesIdx = output.indexOf("Closes #42");
		assert.ok(issueIdx >= 0, "Issue URL present");
		assert.ok(closesIdx >= 0, "Closes #N present");
		assert.ok(closesIdx > issueIdx, "Closes #N appears after issue URL");
	});

	// ─── Tests: Bug 2 — Skipped PR rendering ───────────────────────

	describe("buildPipelineSummary — skipped PR (Bug 2)", () => {
		it("skipped PR (ahead_by=0) renders as 'PR creation failed' not 'created'", () => {
			const prResult: PrCreationResult = {
				success: false,
				error: "No commits ahead of base — PR skipped",
			};
			const output = buildPipelineSummary(
				emptyResults,
				"success",
				42,
				"Title",
				defaultConfig,
				undefined,
				prResult,
			);
			// Should NOT render "created" or "#undefined"
			assert.ok(!output.includes("created"), "should NOT say 'created' for skipped PR");
			assert.ok(!output.includes("#undefined"), "should NOT render '#undefined' for skipped PR");
			// Should render the error message
			assert.ok(
				output.includes("PR creation failed"),
				"should indicate PR creation failed/skipped",
			);
			assert.ok(output.includes("No commits ahead of base"), "should show why PR was skipped");
		});

		it("skipped PR does not alter Closes #N line", () => {
			const prResult: PrCreationResult = {
				success: false,
				error: "No commits ahead of base — PR skipped",
			};
			const output = buildPipelineSummary(
				emptyResults,
				"success",
				42,
				"Title",
				defaultConfig,
				undefined,
				prResult,
			);
			assert.ok(output.includes("Closes #42"), "Closes #N should still be present");
		});
	});
});
