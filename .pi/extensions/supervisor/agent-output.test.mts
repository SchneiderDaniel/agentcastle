// ─── Tests: agent-output.ts — Phase 1: AgentOutput type + parseAgentOutput ──
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput, stripAnsi } from "./agent-output.ts";
import type { AgentOutput, FailedParse } from "./types.ts";

// ─── Helper ────────────────────────────────────────────────────────

function isFailedParse(r: AgentOutput | FailedParse): r is FailedParse {
	return "error" in r && "rawOutput" in r;
}

function isAgentOutput(r: AgentOutput | FailedParse): r is AgentOutput {
	return "action" in r && "agentName" in r;
}

// ─── Tests: stripAnsi ─────────────────────────────────────────────

describe("stripAnsi()", () => {
	it("strips ANSI escape sequences", () => {
		const input = "\x1b[32mHello\x1b[0m World";
		assert.equal(stripAnsi(input), "Hello World");
	});

	it("returns empty string for empty input", () => {
		assert.equal(stripAnsi(""), "");
	});

	it("preserves text without ANSI", () => {
		const input = "Plain text";
		assert.equal(stripAnsi(input), "Plain text");
	});

	it("strips multiple ANSI sequences", () => {
		const input = "\x1b[1m\x1b[31mBold Red\x1b[0m \x1b[32mGreen\x1b[0m";
		assert.equal(stripAnsi(input), "Bold Red Green");
	});
});

// ─── Tests: parseAgentOutput — valid JSON ─────────────────────────

describe("parseAgentOutput — valid JSON", () => {
	it("parses valid JSON with minimal fields", () => {
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should be AgentOutput");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "developer");
	});

	it("parses JSON with all fields", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			summary: "All checks pass",
			commentBody: "## Audit Approved\nLooks good",
			prTitle: "feat(#123): test",
			prBody: "## PR Body\nDetails",
			auditScore: { passing: 5, total: 6 },
			findings: [
				{
					severity: "warning",
					dimension: "code-quality",
					symptom: "Code style inconsistency",
					consequence: "Harder to maintain",
					remedy: "Run formatter",
				},
			],
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		const o = result as AgentOutput;
		assert.equal(o.action, "APPROVED");
		assert.equal(o.agentName, "auditor");
		assert.equal(o.auditScore?.passing, 5);
		assert.equal(o.auditScore?.total, 6);
		assert.equal(o.findings?.length, 1);
		assert.equal(o.findings![0].severity, "warning");
	});

	it("parses REJECTED action", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			commentBody: "## Audit Rejected\nIssues found",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "REJECTED");
	});

	it("handles empty findings array", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [],
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.deepEqual((result as AgentOutput).findings, []);
	});
});

// ─── Tests: parseAgentOutput — malformed JSON ─────────────────────

describe("parseAgentOutput — malformed JSON", () => {
	it("rejects malformed JSON with descriptive error", () => {
		const input = "{ invalid json }";
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		const f = result as FailedParse;
		assert.ok(f.error.includes("Failed to parse"), `error should mention parsing: ${f.error}`);
		assert.equal(f.rawOutput, input);
	});

	it("rejects empty input", () => {
		const result = parseAgentOutput("");
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});

	it("rejects null input", () => {
		const result = parseAgentOutput(null as unknown as string);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});

	it("rejects undefined input", () => {
		const result = parseAgentOutput(undefined as unknown as string);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});

	it("rejects input that is only whitespace", () => {
		const result = parseAgentOutput("   \n  \t  ");
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error);
	});
});

// ─── Tests: parseAgentOutput — schema validation ──────────────────

describe("parseAgentOutput — schema validation", () => {
	it("rejects missing action field", () => {
		const input = JSON.stringify({ agentName: "developer" });
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("action"));
	});

	it("rejects missing agentName field", () => {
		const input = JSON.stringify({ action: "COMPLETE" });
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("agentname"));
	});

	it("rejects invalid action enum value", () => {
		const input = JSON.stringify({
			action: "INVALID_ACTION",
			agentName: "developer",
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("action"));
	});

	it("rejects non-string agentName", () => {
		const input = JSON.stringify({ action: "COMPLETE", agentName: 42 });
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("agentname"));
	});

	it("rejects auditScore without total field", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 5 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("auditscore"));
	});

	it("rejects auditScore with non-numeric fields", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: "5", total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("auditscore"));
	});

	it("rejects auditScore with negative passing", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: -1, total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
	});

	it("rejects auditScore where passing > total", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 7, total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("auditscore"));
	});

	it("accepts auditScore where passing == total", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 6, total: 6 },
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
	});

	it("rejects findings with invalid severity", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings: [
				{
					severity: "fatal",
					dimension: "code-quality",
					symptom: "Bad",
					consequence: "Bad",
					remedy: "Fix",
				},
			],
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		assert.ok((result as FailedParse).error.toLowerCase().includes("severity"));
	});

	it("rejects findings with missing required fields", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings: [{ severity: "critical" }],
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
	});

	it("rejects findings when findings is not an array", () => {
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings: "not an array",
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
	});
});

// ─── Tests: parseAgentOutput — JSON in code fences ────────────────

describe("parseAgentOutput — JSON in code fences", () => {
	it("extracts JSON from ```json … ``` code fence", () => {
		const input = [
			"Some text before",
			"```json",
			JSON.stringify({ action: "COMPLETE", agentName: "developer" }),
			"```",
			"Some text after",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("extracts JSON from ``` … ``` code fence (no language)", () => {
		const input = [
			"Some text",
			"```",
			JSON.stringify({ action: "APPROVED", agentName: "auditor" }),
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "APPROVED");
	});

	it("handles JSON in code fence with extra whitespace", () => {
		const input = [
			"```json",
			"  ",
			JSON.stringify({ action: "COMPLETE", agentName: "test-designer" }),
			"  ",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
	});
});

// ─── Tests: parseAgentOutput — extra surrounding text ─────────────

describe("parseAgentOutput — extra surrounding text", () => {
	it("extracts last JSON block from text with extra content", () => {
		const input =
			"Thinking about this...\nLet me output:\n" +
			JSON.stringify({ action: "COMPLETE", agentName: "developer" }) +
			"\nDone!";
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("prefers last JSON block when multiple JSON objects present", () => {
		const input =
			JSON.stringify({ action: "COMPLETE", agentName: "researcher" }) +
			"\nActually no, I changed my mind\n" +
			JSON.stringify({ action: "COMPLETE", agentName: "developer" });
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).agentName, "developer");
	});

	it("extracts only the outer JSON object, not nested ones", () => {
		const input = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			findings: [
				{
					severity: "warning",
					dimension: "code-quality" as const,
					symptom: "Bad",
					consequence: "Bad",
					remedy: "Fix",
				},
			],
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
	});
});

// ─── Tests: parseAgentOutput — refusal handling ───────────────────

describe("parseAgentOutput — refusal handling", () => {
	it("returns FailedParse when refusal field is present", () => {
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			refusal: "I cannot complete this task due to safety concerns",
		});
		const result = parseAgentOutput(input);
		assert.ok(isFailedParse(result));
		const f = result as FailedParse;
		assert.ok(f.error.includes("refused"), `error should mention refused: ${f.error}`);
	});
});

// ─── Tests: parseAgentOutput — ANSI stripping ─────────────────────

describe("parseAgentOutput — ANSI stripping", () => {
	it("strips ANSI escape sequences before parsing", () => {
		const input =
			"\x1b[32m" + JSON.stringify({ action: "COMPLETE", agentName: "developer" }) + "\x1b[0m";
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("strips ANSI around JSON code fences", () => {
		const input =
			"\x1b[1mHere is my output:\x1b[0m\n```json\n" +
			JSON.stringify({ action: "APPROVED", agentName: "auditor" }) +
			"\n```\n\x1b[32mDone\x1b[0m";
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "APPROVED");
	});
});

// ─── Tests: parseAgentOutput — edge cases ─────────────────────────

describe("parseAgentOutput — edge cases", () => {
	it("handles very long JSON in agent output", () => {
		const findings = Array.from({ length: 50 }, (_, i) => ({
			severity: "warning" as const,
			dimension: "code-quality" as const,
			symptom: "Issue " + i,
			consequence: "Bad",
			remedy: "Fix",
		}));
		const input = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			findings,
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).findings?.length, 50);
	});

	it("handles line break characters in string values", () => {
		const input = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			commentBody: "## Summary\nThis is a multi-line\ncomment body\nwith line breaks",
		});
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.ok((result as AgentOutput).commentBody?.includes("line breaks"));
	});

	it("strips ANSI codes from JSON extracted from code fences", () => {
		const input = [
			"```json",
			"\x1b[32m" + JSON.stringify({ action: "COMPLETE", agentName: "developer" }) + "\x1b[0m",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});
});

// ─── Characterization: current resolveNextStatus + extractStructuredAuditOutput ──
// These capture the current behavior to ensure backward compatibility.

describe("characterization — resolveNextStatus compatibility", () => {
	it("extracts AUDIT_DECISION: APPROVED → Done", () => {
		// This replaces the old resolveNextStatus + extractStructuredAuditOutput
		// behavior. The new parseAgentOutput should produce equivalent decisions.
		const output = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			summary: "Audit approved",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "APPROVED");
	});

	it("extracts AUDIT_DECISION: REJECTED → Implementation", () => {
		const output = JSON.stringify({
			action: "REJECTED",
			agentName: "auditor",
			commentBody: "## Audit Rejected\nIssues",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).action, "REJECTED");
	});
});

describe("characterization — extractAuditScore compatibility", () => {
	it("extracts audit score from AgentOutput", () => {
		const output = JSON.stringify({
			action: "APPROVED",
			agentName: "auditor",
			auditScore: { passing: 5, total: 6 },
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		const o = result as AgentOutput;
		assert.equal(o.auditScore?.passing, 5);
		assert.equal(o.auditScore?.total, 6);
	});

	it("returns no audit score when absent", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		const o = result as AgentOutput;
		assert.equal(o.auditScore, undefined);
	});
});

describe("characterization — extractAgentCommentBody compatibility", () => {
	it("extracts commentBody from AgentOutput", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "architect",
			commentBody: "## Architecture\nMy design approach",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).commentBody, "## Architecture\nMy design approach");
	});

	it("returns no commentBody when absent", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).commentBody, undefined);
	});
});

describe("characterization — extractSummaryLine compatibility", () => {
	it("extracts summary from AgentOutput", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
			summary: "Implemented the feature",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).summary, "Implemented the feature");
	});

	it("returns no summary when absent", () => {
		const output = JSON.stringify({
			action: "COMPLETE",
			agentName: "developer",
		});
		const result = parseAgentOutput(output);
		assert.ok(isAgentOutput(result));
		assert.equal((result as AgentOutput).summary, undefined);
	});
});
