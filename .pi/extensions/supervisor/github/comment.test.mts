// ─── Tests: github/comment.ts — issue comment posting + parsing ──
// Tests for postIssueComment, extractStructuredAuditOutput,
// extractAgentCommentBody.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	postIssueComment,
	extractStructuredAuditOutput,
	extractAgentCommentBody,
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

	// ── Bug fix: AUDIT_SCORE inside PR_BODY must not truncate ──

	it("PR_BODY with AUDIT_SCORE inside — captures full body including score", () => {
		// AUDIT_SCORE appears INSIDE PR_BODY in the auditor template.
		// The old regex would stop at AUDIT_SCORE: truncating the body.
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#123): add feature",
			"PR_BODY: ## PR Description",
			"",
			"Changes made:",
			"- Added new feature",
			"",
			"### Audit Score",
			"AUDIT_SCORE: 5/6",
			"",
			"COMMENT_BODY: ## Audit Approved",
			"Looks good!",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		assert.ok(result?.prBody, "PR_BODY should be captured");
		assert.ok(
			result?.prBody?.includes("AUDIT_SCORE: 5/6"),
			"PR_BODY should include AUDIT_SCORE: 5/6",
		);
		assert.ok(
			result?.prBody?.includes("### Audit Score"),
			"PR_BODY should include ### Audit Score",
		);
		assert.equal(result?.commentBody, "## Audit Approved\nLooks good!");
	});

	it("PR_BODY with AUDIT_SCORE followed by SUBMODULE_PR — captures correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#123): multi-repo",
			"PR_BODY: ## Changes",
			"AUDIT_SCORE: 6/6",
			"",
			"SUBMODULE_PR: submodule-repo main..feat-branch",
			"COMMENT_BODY: Done",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.ok(result?.prBody?.includes("AUDIT_SCORE: 6/6"));
		assert.ok(result?.prBody?.includes("## Changes"));
	});

	it("empty PR_BODY (no content before next marker) — prBody is empty string", () => {
		const output = "AUDIT_DECISION: APPROVED\nPR_TITLE: feat\nPR_BODY: \nCOMMENT_BODY: note";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "");
	});

	it("COMMENT_BODY with ALL_CAPS: content inside — not truncated", () => {
		const output = [
			"AUDIT_DECISION: REJECTED",
			"COMMENT_BODY: ## Audit Rejected",
			"- STATUS: needs work",
			"- REVIEW_RESULT: fail",
			"Please fix before next review.",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "REJECTED");
		assert.ok(result?.commentBody, "COMMENT_BODY should be captured");
		assert.ok(
			result?.commentBody?.includes("STATUS: needs work"),
			"COMMENT_BODY should include STATUS: needs work",
		);
		assert.ok(
			result?.commentBody?.includes("REVIEW_RESULT: fail"),
			"COMMENT_BODY should include REVIEW_RESULT: fail",
		);
	});

	it("COMMENT_BODY followed by SUBMODULE_PR boundary — stops correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat",
			"PR_BODY: desc",
			"COMMENT_BODY: ## Approved",
			"All checks passed.",
			"SUBMODULE_PR: sub-repo main..feat",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.commentBody, "## Approved\nAll checks passed.");
	});

	it("full auditor template output — all sections captured correctly", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#384): fix regex truncation bug",
			"PR_BODY: ## PR Description",
			"",
			"### Summary",
			"Fixed the extractStructuredAuditOutput regex bug that truncated PR_BODY",
			"at AUDIT_SCORE line.",
			"",
			"### Changes",
			"- Updated regex lookahead to use explicit section markers",
			"",
			"### Audit Score",
			"AUDIT_SCORE: 6/6",
			"",
			"COMMENT_BODY: ## Audit Approved",
			"",
			"### Summary",
			"Regex fix looks correct.",
			"",
			"### Review Findings",
			"- Architecture compliance: ✓",
			"- Code quality: ✓",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.decision, "APPROVED");
		assert.equal(result?.prTitle, "feat(#384): fix regex truncation bug");
		assert.ok(result?.prBody?.includes("AUDIT_SCORE: 6/6"), "PR_BODY must include AUDIT_SCORE");
		assert.ok(result?.prBody?.includes("### Audit Score"), "PR_BODY must include ### Audit Score");
		assert.ok(
			result?.prBody?.includes("### Changes"),
			"PR_BODY must include content after AUDIT_SCORE",
		);
		assert.ok(
			result?.commentBody?.includes("### Summary"),
			"COMMENT_BODY must include its content",
		);
		assert.ok(
			result?.commentBody?.includes("### Review Findings"),
			"COMMENT_BODY must have full content",
		);
		assert.ok(
			result?.commentBody?.includes("- Code quality: ✓"),
			"COMMENT_BODY must not be truncated",
		);
	});

	it("PR_BODY with only AUDIT_SCORE (no other content before next marker) — captures score", () => {
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat",
			"PR_BODY: AUDIT_SCORE: 4/6",
			"COMMENT_BODY: comment here",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result !== null);
		assert.equal(result?.prBody, "AUDIT_SCORE: 4/6");
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
