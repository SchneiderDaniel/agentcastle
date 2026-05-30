// ─── Tests: github/comment.ts — issue comment posting + parsing ──
// Tests for postIssueComment, extractStructuredAuditOutput,
// extractAgentCommentBody, buildAuditCommentFallback.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	postIssueComment,
	extractStructuredAuditOutput,
	extractAgentCommentBody,
	buildAuditCommentFallback,
} from "./comment.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockPi(execResult: { code: number; stdout: string; stderr: string }): ExtensionAPI {
	return {
		exec: async () => execResult,
	} as unknown as ExtensionAPI;
}

// ─── Tests: postIssueComment() ────────────────────────────────────

describe("postIssueComment()", () => {
	it("calls gh issue comment with correct args", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const pi = {
			exec: ((cmd: string, args: string[]) => {
				calls.push({ cmd, args });
				return Promise.resolve({ code: 0, stdout: "", stderr: "" });
			}) as ExtensionAPI["exec"],
		} as unknown as ExtensionAPI;
		await postIssueComment(pi, 123, "owner/repo", "Comment body");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "gh");
		assert.deepEqual(calls[0].args, [
			"issue",
			"comment",
			"123",
			"--repo",
			"owner/repo",
			"--body",
			"Comment body",
		]);
	});
});

// ─── Tests: extractStructuredAuditOutput() ────────────────────────

describe("extractStructuredAuditOutput()", () => {
	it("extracts APPROVED decision from AUDIT_DECISION marker", () => {
		const output = "Some text\nAUDIT_DECISION: APPROVED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
	});

	it("extracts REJECTED decision from AUDIT_DECISION marker", () => {
		const output = "Some text\nAUDIT_DECISION: REJECTED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	it("returns null when no audit marker present", () => {
		const result = extractStructuredAuditOutput("Just some text");
		assert.equal(result, null);
	});

	it("last AUDIT_DECISION wins when multiple present", () => {
		const output = "AUDIT_DECISION: APPROVED\nAUDIT_DECISION: REJECTED";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});

	it("extracts PR_TITLE from output", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_TITLE: feat(#123): add feature";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prTitle, "feat(#123): add feature");
	});

	it("extracts PR_BODY from output", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_BODY: Description here";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "Description here");
	});

	it("extracts COMMENT_BODY from output", () => {
		const output = "AUDIT_DECISION: REJECTED\nCOMMENT_BODY: Need fixes";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.commentBody, "Need fixes");
	});

	it("handles standalone AUDIT_APPROVED fallback", () => {
		const output = "Some text\nAUDIT_APPROVED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
	});

	it("handles standalone AUDIT_REJECTED fallback", () => {
		const output = "Some text\nAUDIT_REJECTED\nMore text";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
	});
});

// ─── Tests: extractAgentCommentBody() ─────────────────────────────

describe("extractAgentCommentBody()", () => {
	it("extracts text after COMMENT_BODY marker", () => {
		const output = "Some text\nCOMMENT_BODY: This is the comment\nCOMMENT_BODY_END\nMore text";
		const result = extractAgentCommentBody(output);
		assert.equal(result, "This is the comment");
	});

	it("returns null when no marker found", () => {
		const result = extractAgentCommentBody("Just some text");
		assert.equal(result, null);
	});

	it("last COMMENT_BODY marker wins", () => {
		const output = "COMMENT_BODY: First\nCOMMENT_BODY_END\nCOMMENT_BODY: Second\nCOMMENT_BODY_END";
		const result = extractAgentCommentBody(output);
		assert.equal(result, "Second");
	});

	it("handles COMMENT_BODY without COMMENT_BODY_END — extracts to end", () => {
		const output = "COMMENT_BODY: Trailing text";
		const result = extractAgentCommentBody(output);
		assert.equal(result, "Trailing text");
	});
});

// ─── Tests: buildAuditCommentFallback() ───────────────────────────

describe("buildAuditCommentFallback()", () => {
	it("builds rejection comment from structured findings", () => {
		const output = `**🔴 Critical — Dim: Title**\nSymptom: Issue detected\nConsequence: Breaks things\nRemedy: Fix it\nLocation: file.ts:42`;
		const result = buildAuditCommentFallback("REJECTED", output);
		assert.ok(result !== null);
		assert.ok(result.includes("Audit Rejected"));
		assert.ok(result.includes("Critical"));
	});

	it("builds approval comment from AUDIT_SCORE", () => {
		const output = "AUDIT_SCORE: 5/6\n- Quality: ✅";
		const result = buildAuditCommentFallback("APPROVED", output);
		assert.ok(result !== null);
		assert.ok(result.includes("Audit Approved"));
		assert.ok(result.includes("5/6"));
	});

	it("returns null for empty output", () => {
		const result = buildAuditCommentFallback("APPROVED", "");
		assert.equal(result, null);
	});
});
