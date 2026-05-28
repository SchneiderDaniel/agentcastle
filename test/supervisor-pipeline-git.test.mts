/**
 * Tests for pipeline git/gh operations (Phase 2+4).
 *
 * Phase 2: pipeline posts issue comments deterministically after each agent
 * Phase 4: pipeline calls commitAndPush after developer agent succeeds
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-pipeline-git.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Tests — buildAgentTask no longer contains gh/git commands for non-auditor
// ---------------------------------------------------------------------------

describe("buildAgentTask — no gh issue comment in prompts (Phase 2)", () => {
	it("architect task no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(!task.includes("gh issue comment"), "Architect should not contain gh issue comment");
	});

	it("test-designer task no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("gh issue comment"),
			"Test-designer should not contain gh issue comment",
		);
	});

	it("researcher task no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(!task.includes("gh issue comment"), "Researcher should not contain gh issue comment");
	});

	it("developer task no longer contains git add/commit/push", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(!task.includes("git add -A"), "Developer should not contain git add -A");
		assert.ok(!task.includes("git commit"), "Developer should not contain git commit");
		assert.ok(!task.includes("git push"), "Developer should not contain git push");
	});
});

// ---------------------------------------------------------------------------
// Tests — extractStructuredAuditOutput helper (from github.ts)
// ---------------------------------------------------------------------------

describe("extractStructuredAuditOutput", () => {
	it("extracts AUDIT_DECISION from agent output", async () => {
		const { extractStructuredAuditOutput } = await import("../.pi/extensions/supervisor/github.ts");
		const output =
			"AUDIT_DECISION: APPROVED\nPR_TITLE: feat(#42): fix\nPR_BODY: desc\nCOMMENT_BODY: nice";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "APPROVED");
	});

	it("returns null when no AUDIT_DECISION marker", async () => {
		const { extractStructuredAuditOutput } = await import("../.pi/extensions/supervisor/github.ts");
		const result = extractStructuredAuditOutput("no markers here");
		assert.strictEqual(result, null);
	});

	it("extracts PR_TITLE, PR_BODY, COMMENT_BODY", async () => {
		const { extractStructuredAuditOutput } = await import("../.pi/extensions/supervisor/github.ts");
		const output = [
			"AUDIT_DECISION: APPROVED",
			"PR_TITLE: feat(#42): add feature",
			"PR_BODY: ## Summary",
			"Change description here",
			"## Details",
			"- Item 1",
			"- Item 2",
			"COMMENT_BODY: ## Audit Approved",
			"Looks good!",
		].join("\n");
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "APPROVED");
		assert.strictEqual(result!.prTitle, "feat(#42): add feature");
		assert.strictEqual(
			result!.prBody,
			"## Summary\nChange description here\n## Details\n- Item 1\n- Item 2",
		);
		assert.strictEqual(result!.commentBody, "## Audit Approved\nLooks good!");
	});

	it("handles REJECTED decision without PR fields", async () => {
		const { extractStructuredAuditOutput } = await import("../.pi/extensions/supervisor/github.ts");
		const output = "AUDIT_DECISION: REJECTED\nCOMMENT_BODY: ## Audit Rejected\nMissing tests";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "REJECTED");
		assert.strictEqual(result!.commentBody, "## Audit Rejected\nMissing tests");
	});

	it("last AUDIT_DECISION marker wins", async () => {
		const { extractStructuredAuditOutput } = await import("../.pi/extensions/supervisor/github.ts");
		const output =
			"AUDIT_DECISION: APPROVED\nPR_TITLE: first\nAUDIT_DECISION: REJECTED\nCOMMENT_BODY: nope";
		const result = extractStructuredAuditOutput(output);
		assert.ok(result);
		assert.strictEqual(result!.decision, "REJECTED");
	});
});

// ---------------------------------------------------------------------------
// Tests — pipeline marker resolution
// ---------------------------------------------------------------------------

describe("Pipeline marker resolution for structured auditor output", () => {
	it("AUDIT_APPROVED marker resolves to Done", async () => {
		const { resolveNextStatus } = await import("../.pi/extensions/supervisor/workflow.ts");
		const auditStep = {
			status: "Audit",
			markerMap: { AUDIT_APPROVED: "Done", AUDIT_REJECTED: "Implementation" },
		};
		const result = resolveNextStatus(auditStep, "AUDIT_DECISION: APPROVED\nAUDIT_APPROVED");
		assert.strictEqual(result, "Done");
	});

	it("AUDIT_REJECTED marker resolves to Implementation", async () => {
		const { resolveNextStatus } = await import("../.pi/extensions/supervisor/workflow.ts");
		const auditStep = {
			status: "Audit",
			markerMap: { AUDIT_APPROVED: "Done", AUDIT_REJECTED: "Implementation" },
		};
		const result = resolveNextStatus(auditStep, "AUDIT_DECISION: REJECTED\nAUDIT_REJECTED");
		assert.strictEqual(result, "Implementation");
	});
});
