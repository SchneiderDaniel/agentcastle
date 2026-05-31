// ─── Tests: workflow.ts — audit score computation + pipeline gates ──
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractAuditScore,
	computeAuditScoreFromFindings,
	resolveNextStatus,
	resolveNextStatusFromAgentOutput,
	hasResearchFindings,
	type AuditScore,
} from "./workflow.ts";
import type { Finding } from "./types.ts";
import { WORKFLOW } from "./workflow.ts";

// ─── Helpers ───────────────────────────────────────────────────────

const auditorStep = WORKFLOW.find((s) => s.agentName === "auditor")!;
const researcherStep = WORKFLOW.find((s) => s.agentName === "researcher")!;

// ─── Tests: extractAuditScore ──────────────────────────────────────

describe("extractAuditScore", () => {
	it("parses structured JSON auditScore", () => {
		const output = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 5, total: 6 },
		});
		const result = extractAuditScore(output);
		assert.ok(result);
		assert.equal(result!.passing, 5);
		assert.equal(result!.total, 6);
	});

	it("falls back to AUDIT_SCORE text marker", () => {
		const output = "Some text\nAUDIT_SCORE: 3/6\nmore text";
		const result = extractAuditScore(output);
		assert.ok(result);
		assert.equal(result!.passing, 3);
		assert.equal(result!.total, 6);
	});

	it("returns null when no score found", () => {
		const result = extractAuditScore("No score in this output");
		assert.equal(result, null);
	});

	it("last occurrence of AUDIT_SCORE wins", () => {
		const output = "AUDIT_SCORE: 2/6\nAUDIT_SCORE: 5/6";
		const result = extractAuditScore(output);
		assert.equal(result!.passing, 5);
		assert.equal(result!.total, 6);
	});
});

// ─── Tests: computeAuditScoreFromFindings ──────────────────────────

describe("computeAuditScoreFromFindings", () => {
	it("returns 6/6 for no findings", () => {
		const result = computeAuditScoreFromFindings([]);
		assert.equal(result.passing, 6);
		assert.equal(result.total, 6);
	});

	it("deducts for critical findings", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "Issue",
				consequence: "Bad",
				remedy: "Fix",
			},
		];
		const result = computeAuditScoreFromFindings(findings);
		assert.equal(result.passing, 5);
		assert.equal(result.total, 6);
	});

	it("deducts for warning findings", () => {
		const findings: Finding[] = [
			{
				severity: "warning",
				dimension: "code-quality",
				symptom: "Issue",
				consequence: "Bad",
				remedy: "Fix",
			},
		];
		const result = computeAuditScoreFromFindings(findings);
		assert.equal(result.passing, 5);
		assert.equal(result.total, 6);
	});

	it("does NOT deduct for suggestion findings", () => {
		const findings: Finding[] = [
			{
				severity: "suggestion",
				dimension: "code-quality",
				symptom: "Suggestion",
				consequence: "Minor",
				remedy: "Consider",
			},
		];
		const result = computeAuditScoreFromFindings(findings);
		assert.equal(result.passing, 6);
		assert.equal(result.total, 6);
	});

	it("multiple findings in same dimension only deduct once per dimension", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "Issue1",
				consequence: "Bad1",
				remedy: "Fix1",
			},
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "Issue2",
				consequence: "Bad2",
				remedy: "Fix2",
			},
		];
		const result = computeAuditScoreFromFindings(findings);
		// Only one dimension failed (code-quality), even with 2 findings
		assert.equal(result.passing, 5);
		assert.equal(result.total, 6);
	});

	it("multiple dimensions with critical findings deducts per dimension", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "code-quality",
				symptom: "Issue",
				consequence: "Bad",
				remedy: "Fix",
			},
			{
				severity: "critical",
				dimension: "correctness-safety",
				symptom: "Issue",
				consequence: "Bad",
				remedy: "Fix",
			},
		];
		const result = computeAuditScoreFromFindings(findings);
		assert.equal(result.passing, 4);
		assert.equal(result.total, 6);
	});

	it("mixed severities — only critical and warning fail dimensions", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "correctness-safety",
				symptom: "Bug",
				consequence: "Crash",
				remedy: "Fix",
			},
			{
				severity: "suggestion",
				dimension: "code-quality",
				symptom: "Style",
				consequence: "Minor",
				remedy: "Format",
			},
			{
				severity: "warning",
				dimension: "completeness",
				symptom: "Missing edge case",
				consequence: "Potential issue",
				remedy: "Add handling",
			},
		];
		const result = computeAuditScoreFromFindings(findings);
		assert.equal(result.passing, 4); // 2 dimensions failed: correctness-safety, completeness
		assert.equal(result.total, 6);
	});

	it("handles unknown dimensions gracefully", () => {
		const findings: Finding[] = [
			{
				severity: "critical",
				dimension: "custom-dimension",
				symptom: "Issue",
				consequence: "Bad",
				remedy: "Fix",
			},
		];
		// Unknown dimensions still count as failed
		const result = computeAuditScoreFromFindings(findings);
		assert.equal(result.passing, 5);
		assert.equal(result.total, 6);
	});

	it("all 6 dimensions failing returns 0/6", () => {
		const dimensions = [
			"architecture-compliance",
			"ticket-fulfillment",
			"tests-passed",
			"test-quality",
			"correctness-safety",
			"code-quality",
			"completeness",
		];
		const findings: Finding[] = dimensions.slice(0, 6).map((d) => ({
			severity: "critical" as const,
			dimension: d,
			symptom: "Issue",
			consequence: "Bad",
			remedy: "Fix",
		}));
		const result = computeAuditScoreFromFindings(findings);
		assert.equal(result.passing, 0);
		assert.equal(result.total, 6);
	});
});

// ─── Tests: hasResearchFindings ────────────────────────────────────

describe("hasResearchFindings", () => {
	it("returns true when issue data body contains ## Research Findings", () => {
		const result = hasResearchFindings({
			body: "## Research Findings\nSome findings",
			comments: [],
		});
		assert.equal(result, true);
	});

	it("returns true when a comment contains ## Research Findings", () => {
		const result = hasResearchFindings({
			body: "Issue body",
			comments: [{ author: "bot", body: "## Research Findings\nSome research" }],
		});
		assert.equal(result, true);
	});

	it("returns false when neither body nor comments contain ## Research Findings", () => {
		const result = hasResearchFindings({
			body: "Issue body",
			comments: [{ author: "architect", body: "## Architecture\nDesign" }],
		});
		assert.equal(result, false);
	});

	it("returns false for empty body and empty comments", () => {
		const result = hasResearchFindings({
			body: "",
			comments: [],
		});
		assert.equal(result, false);
	});

	it("searches case-insensitively", () => {
		const result = hasResearchFindings({
			body: "## research findings\nsome stuff",
			comments: [],
		});
		assert.equal(result, true);
	});
});

// ─── Tests: resolveNextStatus (maintaining backward compat) ────────

describe("resolveNextStatus — backward compatibility", () => {
	it("extracts AUDIT_DECISION: APPROVED → Done", () => {
		const result = resolveNextStatus(auditorStep, "Some text\nAUDIT_DECISION: APPROVED");
		assert.equal(result, "Done");
	});

	it("extracts AUDIT_DECISION: REJECTED → Implementation", () => {
		const result = resolveNextStatus(auditorStep, "Some text\nAUDIT_DECISION: REJECTED");
		assert.equal(result, "Implementation");
	});

	it("last marker wins for researcher (FEEDBACK_ARCHITECTURE overrides RESEARCH_COMPLETE)", () => {
		const result = resolveNextStatus(researcherStep, "RESEARCH_COMPLETE\nFEEDBACK_ARCHITECTURE");
		assert.equal(result, "Architecture");
	});
});

// ─── Tests: resolveNextStatusFromAgentOutput ──────────────────────

describe("resolveNextStatusFromAgentOutput", () => {
	it("maps APPROVED action to Done via AUDIT_DECISION: APPROVED marker", () => {
		const output = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
		});
		const result = resolveNextStatusFromAgentOutput(auditorStep, output);
		assert.equal(result, "Done");
	});

	it("maps REJECTED action to Implementation via AUDIT_DECISION: REJECTED marker", () => {
		const output = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
		});
		const result = resolveNextStatusFromAgentOutput(auditorStep, output);
		assert.equal(result, "Implementation");
	});

	it("maps COMPLETE action to Research for architect step", () => {
		const architectStep = WORKFLOW.find((s) => s.agentName === "architect")!;
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
		});
		const result = resolveNextStatusFromAgentOutput(architectStep, output);
		assert.equal(result, "Research");
	});

	it("falls back to text marker when JSON parsing fails", () => {
		const output = "Some text\nAUDIT_DECISION: APPROVED\nmore text";
		const result = resolveNextStatusFromAgentOutput(auditorStep, output);
		assert.equal(result, "Done");
	});
});
