// ─── Tests: agent-output.ts — Phase 1: AgentOutput type + parseAgentOutput ──
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAgentOutput, stripAnsi } from "../agent-output.ts";
import type { AgentOutput, FailedParse } from "../types.ts";

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

	it("handles literal newlines in JSON string values (agent-style output)", () => {
		// Agents often output JSON with actual \n characters instead of \\n escapes
		const input = `{"action":"COMPLETE","agentName":"architect","commentBody":"## Architecture\nMy approach"}`;
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should parse despite literal newline");
		const agentOut = result as AgentOutput;
		assert.ok(agentOut.commentBody?.includes("Architecture"));
		assert.ok(agentOut.commentBody?.includes("My approach"));
	});

	it("handles literal newline in JSON inside code fence", () => {
		const input = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "researcher",',
			'  "commentBody": "## Findings\nFound stuff"',
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should parse literal newline in code fence");
		assert.ok((result as AgentOutput).commentBody?.includes("Findings"));
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

	it("extracts JSON with triple-backtick code blocks inside commentBody", () => {
		// Real agents (researcher, architect) include markdown code blocks
		// in their commentBody. The old fence regex stopped at the first ```
		// inside a JSON string value, truncating the JSON. Brace matching
		// (primary since the fix) correctly ignores ``` inside strings.
		const input = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "researcher",',
			'  "commentBody": "## Research Findings\\n\\n### Best Practices\\n- Use `structuredClone()` for deep copies\\n```ts\\nconst copy = structuredClone(obj);\\n```\\n- Source: https://example.com"',
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(input);
		assert.ok(isAgentOutput(result), "should extract JSON with triple backticks in commentBody");
		const agentOut = result as AgentOutput;
		assert.ok(agentOut.commentBody?.includes("structuredClone"));
		assert.ok(agentOut.commentBody?.includes("```ts"));
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

describe("extractLastJson — string-boundary-aware brace matching", () => {
	it("extracts JSON from text with braces in tool args", () => {
		const fullLog = [
			'🔧 search_code {"pattern":"function.*{","path":"/src"}',
			"✓ search_code",
			'🔧 read_file {"path":"/src/{feature,x}.ts"}',
			"✓ read_file",
			"💭 I see the issue",
			"",
			'{"commentBody":"Architect review","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from text with tool arg braces");
		assert.equal((result as AgentOutput).commentBody, "Architect review");
		assert.equal((result as AgentOutput).action, "COMPLETE");
	});

	it("extracts JSON when tool args have unbalanced braces", () => {
		const fullLog = [
			'🔧 search_code {"pattern":"if({{{","path":"/src"}',
			"✓ search_code",
			"💭 Found issue",
			"",
			'{"commentBody":"Fix nested brace","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON despite unbalanced braces in tool args");
		assert.equal((result as AgentOutput).commentBody, "Fix nested brace");
	});

	it("extracts JSON when commentBody contains braces", () => {
		const fullLog =
			'{"commentBody":"Fix {the off-by-one} in loop","action":"COMPLETE","agentName":"architect"}';
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON with braces in commentBody");
		assert.equal((result as AgentOutput).commentBody, "Fix {the off-by-one} in loop");
	});

	it("extracts JSON with mixed content (tool logs, thinking, JSON)", () => {
		const fullLog = [
			'🔧 read_file {"path":"/src/auth.ts"}',
			"✓ read_file",
			"💭 Need to check the auth flow",
			'🔧 search_code {"query":"function login"}',
			"✓ search_code",
			"",
			'{"commentBody":"Mixed content review","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from mixed content");
		assert.equal((result as AgentOutput).commentBody, "Mixed content review");
	});

	it("still extracts code-fenced JSON correctly", () => {
		const fullLog = [
			"Some text before",
			"",
			"\`\`\`json",
			'{"commentBody":"Code fenced","action":"COMPLETE","agentName":"researcher"}',
			"\`\`\`",
			"Some text after",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse code-fenced JSON");
		assert.equal((result as AgentOutput).commentBody, "Code fenced");
	});

	it("handles pure JSON (no surrounding text)", () => {
		const json = '{"commentBody":"Pure JSON","action":"COMPLETE","agentName":"architect"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must parse pure JSON");
		assert.equal((result as AgentOutput).commentBody, "Pure JSON");
	});

	it("extracts last JSON when multiple JSON objects present", () => {
		const fullLog = [
			'{"commentBody":"First JSON","action":"COMPLETE","agentName":"architect"}',
			"some text",
			'{"commentBody":"Last JSON","action":"COMPLETE","agentName":"architect"}',
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must pick last JSON object");
		assert.equal((result as AgentOutput).commentBody, "Last JSON");
	});

	// ── Fence scanner regression tests ──
	// Session 6 regression: brace-first approach broke architect because
	// markdown template {…} after code fence was picked up as "last JSON".
	// Fence scanner must find code-fenced JSON even when non-JSON braces
	// appear after the fence.

	it("ignores non-JSON braces in markdown after code fence", () => {
		// Architect output: JSON in code fence, then markdown with template braces
		const fullLog = [
			"Here is my architecture analysis:",
			"",
			"```json",
			'{"commentBody":"Architect design","action":"COMPLETE","agentName":"architect"}',
			"```",
			"",
			"The implementation should use `{ key: value }` objects.",
			"You can also use `{ foo: bar }` for config.",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse code-fenced JSON, not markdown template braces");
		assert.equal((result as AgentOutput).commentBody, "Architect design");
	});

	it("handles triple-backtick code blocks with literal newlines in commentBody", () => {
		// Researcher output: commentBody contains literal newlines and triple backticks.
		// This happens when fullLog entries are joined with \n — the JSON string
		// value contains literal newline characters (not \\n escape sequences).
		// sanitizeJsonStrings later escapes them to \\n for valid JSON parsing.
		const fullLog = [
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "researcher",',
			`  "commentBody": "## Findings\n\n\`\`\`bash\ntest command\n\`\`\`\nDone"`,
			"}",
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(
			isAgentOutput(result),
			"must parse JSON despite literal newlines + triple backticks in commentBody",
		);
		const agentOut = result as AgentOutput;
		assert.ok(agentOut.commentBody?.includes("test command"));
		assert.ok(agentOut.commentBody?.includes("```bash"));
	});

	it("picks last code fence when multiple fences exist", () => {
		// Agent may produce multiple code fences (e.g. showing example code
		// then the JSON output). Fence scanner must pick the LAST one.
		const fullLog = [
			"```json",
			'{"commentBody":"First JSON","action":"COMPLETE","agentName":"architect"}',
			"```",
			"Some text",
			"```json",
			'{"commentBody":"Final JSON","action":"COMPLETE","agentName":"architect"}',
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse last code-fenced JSON");
		assert.equal((result as AgentOutput).commentBody, "Final JSON");
	});

	it("handles code fence without 'json' language tag", () => {
		// Agent may use bare ``` without language tag
		const fullLog = [
			"```",
			'{"commentBody":"No lang tag","action":"COMPLETE","agentName":"architect"}',
			"```",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON in bare ``` fence");
		assert.equal((result as AgentOutput).commentBody, "No lang tag");
	});
});

// ─── Tests: thinking-prefix stripping — JSON in thinking blocks ────
// When agents use thinking:high, JSON output may be emitted inside
// thinking blocks. Event handlers push thinking lines to fullLog with
// "💭 " prefix per line. stripThinkingPrefix removes these prefixes
// so parseAgentOutput can still extract valid JSON.

describe("parseAgentOutput — JSON in thinking blocks (💭 prefix)", () => {
	it("extracts JSON from thinking-prefixed lines (thinking:high scenario)", () => {
		// Simulates fullLog when thinking:high agent outputs JSON inside thinking blocks
		const fullLog = [
			"💭 I need to design the architecture for this feature",
			"💭 Let me consider the clean architecture approach",
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "## Architecture - My design approach",',
			'💭   "summary": "Proposed architecture"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON embedded in thinking blocks");
		const o = result as AgentOutput;
		assert.equal(o.action, "COMPLETE");
		assert.equal(o.agentName, "architect");
		assert.equal(o.commentBody, "## Architecture - My design approach");
		assert.equal(o.summary, "Proposed architecture");
	});

	it("extracts JSON from mixed thinking+tool+text fullLog", () => {
		// Realistic fullLog: tool calls + thinking + JSON-in-thinking
		const fullLog = [
			'🔧 read_file {"path":"/src/module.ts"}',
			"✓ read_file",
			"💭 Analyzing code structure",
			'🔧 search_code {"pattern":"class.*Module"}',
			"✓ search_code",
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "Review complete"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from mixed log with 💭 prefix");
		assert.equal((result as AgentOutput).commentBody, "Review complete");
	});

	it("handles JSON entirely in thinking blocks (no text blocks)", () => {
		// JSON entirely within thinking blocks, no separate text output
		const fullLog = [
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "## Summary - Just thinking through this"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse JSON from pure thinking output");
		assert.ok((result as AgentOutput).commentBody?.includes("Summary"));
	});

	it("still handles normal (non-prefixed) JSON correctly", () => {
		// Regression: ensure non-prefixed JSON still works
		const json = '{"commentBody":"Normal text block","action":"COMPLETE","agentName":"architect"}';
		const result = parseAgentOutput(json);
		assert.ok(isAgentOutput(result), "must still parse normal JSON");
		assert.equal((result as AgentOutput).commentBody, "Normal text block");
	});

	it("handles JSON in code fence mixed with thinking prefix", () => {
		// JSON inside code fence but with some thinking lines before
		const fullLog = [
			"💭 Let me output the JSON",
			"```json",
			"{",
			'  "action": "COMPLETE",',
			'  "agentName": "architect",',
			'  "commentBody": "Code fenced approach"',
			"}",
			"```",
			"💭 And I'm done",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(isAgentOutput(result), "must parse code-fenced JSON with thinking lines");
		assert.equal((result as AgentOutput).commentBody, "Code fenced approach");
	});

	it("handles multi-line commentBody in thinking blocks", () => {
		// commentBody with embedded newline (\\n escape in JSON) inside thinking prefix
		const fullLog = [
			"💭 {",
			'💭   "action": "COMPLETE",',
			'💭   "agentName": "architect",',
			'💭   "commentBody": "## Summary\\nJust thinking through this"',
			"💭 }",
		].join("\n");
		const result = parseAgentOutput(fullLog);
		assert.ok(
			isAgentOutput(result),
			"must parse JSON with \\\\n in commentBody in thinking blocks",
		);
		// The \\n in the JSON text (from JavaScript string \\\\n) becomes \n after JSON.parse,
		// which is a literal backslash followed by n (not a real newline)
		assert.ok((result as AgentOutput).commentBody?.includes("Summary"));
		assert.ok(
			(result as AgentOutput).commentBody?.includes("\\n") ||
				(result as AgentOutput).commentBody?.includes("\n"),
		);
	});
});
