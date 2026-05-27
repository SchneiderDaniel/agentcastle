/**
 * Tests for structured auditor output parsing (Phase 3).
 *
 * Phase 3: buildAgentTask("auditor") simplified to structured output markers
 * - No gh issue comment, gh pr create, heredoc shell in prompt
 * - Uses AUDIT_DECISION, PR_TITLE, PR_BODY, COMMENT_BODY
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-agent-task-output.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Phase 3: buildAgentTask("auditor") simplified prompt
// ---------------------------------------------------------------------------

describe("buildAgentTask — auditor simplified (Phase 3)", () => {
	it("no longer contains gh issue comment", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"auditor",
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
			"Auditor prompt should not contain gh issue comment",
		);
	});

	it("no longer contains gh pr create", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"auditor",
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
		assert.ok(!task.includes("gh pr create"), "Auditor prompt should not contain gh pr create");
	});

	it("no longer contains shell heredoc (cat >)", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"auditor",
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
		assert.ok(!task.includes("cat >"), "Auditor prompt should not contain shell heredoc");
	});

	it("no longer contains SUMMARY_FILE variable", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"auditor",
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
		assert.ok(!task.includes("SUMMARY_FILE"), "Auditor prompt should not contain SUMMARY_FILE");
	});

	it("contains AUDIT_DECISION structured output marker instruction", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"auditor",
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
			task.includes("AUDIT_DECISION"),
			"Auditor prompt should contain AUDIT_DECISION instruction",
		);
	});

	it("contains PR_TITLE / PR_BODY / COMMENT_BODY instructions", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"auditor",
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
		assert.ok(task.includes("PR_TITLE"), "Auditor prompt should contain PR_TITLE");
		assert.ok(task.includes("PR_BODY"), "Auditor prompt should contain PR_BODY");
		assert.ok(task.includes("COMMENT_BODY"), "Auditor prompt should contain COMMENT_BODY");
	});

	it("no longer contains --body-file for submodule fallback", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const submodules = [{ path: "sub/a", repo: "owner/sub-a" }];
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			submodules,
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("gh pr create"),
			"Auditor prompt should not contain gh pr create even with submodules",
		);
	});

	it("still includes code review instructions", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const task = buildAgentTask(
			"auditor",
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
			task.includes("git diff") || task.includes("review"),
			"Auditor prompt should still include review instructions",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: buildAgentTask("auditor") with submodules — structured submodule
// ---------------------------------------------------------------------------

describe("buildAgentTask — auditor with submodules (Phase 3)", () => {
	it("submodule section uses structured markers not shell commands", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const submodules = [{ path: "sub/a", repo: "owner/sub-a" }];
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			submodules,
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("submodule") || task.includes("SUBMODULE"),
			"Should mention submodules exist",
		);
		assert.ok(!task.includes("cd sub/a"), "Should not contain shell cd to submodule");
	});

	it("references submodule repos for structured output", async () => {
		const { buildAgentTask } = await import("../.pi/extensions/supervisor/agent-task.ts");
		const submodules = [
			{ path: "sub/a", repo: "owner/sub-a" },
			{ path: "sub/b", repo: "owner/sub-b" },
		];
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			{ body: "body", comments: [] },
			submodules,
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("owner/sub-a") && task.includes("owner/sub-b"),
			"Should reference submodule repos",
		);
	});
});
