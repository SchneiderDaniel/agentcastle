/**
 * Tests for agent-task.ts
 *
 * Phase 1: generateBranchName (characterization — existing behavior preserved)
 * Phase 2: buildAgentTask auditor — structured output markers (new behavior)
 * Phase 3: buildAgentTask other agents — structured output markers (current impl)
 * Phase 4: buildAgentTask auditor worktree path + branch name
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { generateBranchName, buildAgentTask } from "../agent-task.ts";
import type { FilteredIssueData } from "../types.ts";

// ---------------------------------------------------------------------------
// Phase 4: worktree path + branch name in auditor task (Bug: auditor checks
//          main instead of feature worktree — false rejection)
// ---------------------------------------------------------------------------
// Tests for new optional worktreePath+branchName params on buildAgentTask.
// Auditor case must embed the worktree path so agent's bash tool uses correct
// cwd. Developer/architect/researcher/test-designer cases unchanged.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFilteredData(overrides?: Partial<FilteredIssueData>): FilteredIssueData {
	return {
		body: "Issue body content",
		comments: [
			{ author: "architect", body: "## Architecture\nDesign approach" },
			{ author: "designer", body: "## Test Plan\nTest approach" },
		],
		...overrides,
	};
}

const DEFAULT_SUBMODULES: Array<{ path: string; repo: string }> = [];

const BASE_ARGS = {
	agentName: "auditor",
	issueNum: 42,
	repo: "owner/repo",
	title: "Fix bug",
	filteredData: makeFilteredData(),
	submodules: DEFAULT_SUBMODULES,
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../",
	branchPrefix: "worktree-git-issue-",
};

// ---------------------------------------------------------------------------
// Phase 1: generateBranchName
// ---------------------------------------------------------------------------

describe("generateBranchName", () => {
	it("basic: issue 42, title 'Fix bug' → worktree-git-issue-42-fix-bug", () => {
		const result = generateBranchName(42, "Fix bug", "worktree-git-issue-");
		assert.strictEqual(result, "worktree-git-issue-42-fix-bug");
	});

	it("drops non-alphanumeric chars from title", () => {
		const result = generateBranchName(7, "Title with SPECIAL chars!!!");
		assert.strictEqual(result, "worktree-git-issue-7-title-with-special-chars");
	});

	it("truncates slug to ≤50 chars before prefix", () => {
		const result = generateBranchName(99, "A".repeat(100));
		const full = result;
		const slug = full.replace(/^worktree-git-issue-\d+-/, "");
		assert.ok(slug.length <= 50, `slug length ${slug.length} exceeds 50: "${slug}"`);
	});

	it("accepts custom prefix", () => {
		const result = generateBranchName(5, "test", "custom-");
		assert.strictEqual(result, "custom-5-test");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: buildAgentTask auditor — structured output markers
// ---------------------------------------------------------------------------
// The auditor task uses structured output markers (AUDIT_DECISION, PR_BODY,
// COMMENT_BODY) instead of running gh CLI commands. Pipeline reads markers
// and handles PR creation/comment posting programmatically.

describe("buildAgentTask — auditor structured output markers", () => {
	it("contains AUDIT_DECISION: APPROVED marker", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("AUDIT_DECISION: APPROVED"), "Should contain APPROVED marker");
		assert.ok(task.includes("AUDIT_DECISION: REJECTED"), "Should contain REJECTED marker");
	});

	it("contains PR_BODY and COMMENT_BODY markers for approved flow", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("PR_BODY:"), "Should contain PR_BODY marker");
		assert.ok(task.includes("COMMENT_BODY:"), "Should contain COMMENT_BODY marker");
	});

	it("contains PR_TITLE with issue number and title", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("PR_TITLE: feat(#42): Fix bug"), "Should contain PR_TITLE with issue");
	});

	it("contains git diff defaultBranch instruction", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("git diff main"), "Should contain git diff main instruction");
	});

	it("contains REJECT marker with COMMENT_BODY", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		const rejectSection = task.substring(task.lastIndexOf("AUDIT_DECISION: REJECTED"));
		assert.ok(rejectSection.includes("COMMENT_BODY:"), "REJECT flow contains COMMENT_BODY marker");
	});

	it("contains structured output format heading", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			BASE_ARGS.submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("### Structured Output Format"), "Structured output heading present");
	});

	it("with empty submodules list — no submodule repos listed", () => {
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			[],
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(task.includes("(none)") || !task.includes("submodule"), "No submodules listed");
	});
});

// ---------------------------------------------------------------------------
// Phase 3: other agents (structured output markers)
// ---------------------------------------------------------------------------

describe("buildAgentTask — other agents (structured output markers)", () => {
	it("architect task: COMMENT_BODY/COMMENT_BODY_END markers instead of gh CLI", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("COMMENT_BODY:"));
		assert.ok(task.includes("COMMENT_BODY_END"));
		assert.ok(task.includes("ARCHITECTURE_COMPLETE"));
		// No gh CLI calls in architect task
		assert.ok(!task.includes("gh issue comment"));
	});

	it("developer task: no git add/git commit, has work-from-cwd + branch name", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		// Pipeline handles commit/push — agent task doesn't include git add/commit
		assert.ok(!task.includes("git worktree add"), "No git worktree add in developer task");
		assert.ok(!task.includes("git add"), "No git add in developer task");
		assert.ok(!task.includes("git commit"), "No git commit in developer task");
		// Branch info still present
		assert.ok(task.includes("worktree-git-issue-42-fix-bug"), "Branch name in task");
		// Current-directory workflow
		assert.ok(
			task.includes("Work from current directory") || task.includes("worktree already set up"),
			"Worktree pre-setup mentioned",
		);
		assert.ok(task.includes("IMPLEMENTATION_COMPLETE"), "Completion marker present");
	});

	it("researcher task: web_crawl + ## Research Findings", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("web_crawl"), "web_crawl in researcher task");
		assert.ok(task.includes("## Research Findings"), "Research Findings heading");
	});

	it("test-designer task: COMMENT_BODY markers for test plan output", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("test plan"), "Test plan reference");
		assert.ok(task.includes("COMMENT_BODY:"), "COMMENT_BODY marker for output");
		assert.ok(task.includes("COMMENT_BODY_END"), "COMMENT_BODY_END marker");
		assert.ok(task.includes("TEST_PLAN_COMPLETE"), "Completion marker");
	});

	it("unknown agent name → default fallback task without crash", () => {
		const task = buildAgentTask(
			"unknown-agent",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("Complete the task for issue #42"));
		assert.ok(!task.includes("undefined"));
	});
});

// ---------------------------------------------------------------------------
// Phase 4: worktree path + branch name in auditor task
// ---------------------------------------------------------------------------

describe("buildAgentTask — auditor worktree path + branch name (Phase 4)", () => {
	it("auditor with worktreePath → task contains 'Your current working directory IS the worktree' with path", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/worktree-git-issue-42-fix-bug",
		);
		assert.ok(
			task.includes("Your current working directory IS the worktree"),
			"Should contain worktree path announcement",
		);
		assert.ok(
			task.includes("/home/worktree-git-issue-42-fix-bug"),
			"Should contain the actual worktree path",
		);
	});

	it("auditor with worktreePath + branchName → task contains both", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
			"fix-bug",
		);
		assert.ok(
			task.includes("Your current working directory IS the worktree"),
			"Should contain worktree announcement",
		);
		assert.ok(task.includes("/home/wt"), "Should contain worktree path");
		assert.ok(task.includes("fix-bug"), "Should contain branch name");
		assert.ok(
			task.includes("git branch --show-current"),
			"Should contain git branch --show-current instruction",
		);
	});

	it("auditor with worktreePath → task contains 'prepend: cd <path> &&' instruction", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(task.includes("cd /home/wt"), "Should contain cd to worktree path instruction");
		assert.ok(
			task.includes("Before any bash command"),
			"Should contain instruction to prepend cd before bash commands",
		);
	});

	it("auditor without worktreePath → no worktree path in task (backward compat)", () => {
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Should NOT contain worktree announcement when no worktreePath given",
		);
	});

	it("developer with worktreePath → developer task unchanged (no worktree path in task text)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
			"fix-bug",
		);
		assert.ok(task.includes("Work from current directory"), "Developer task unchanged");
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Developer should NOT have the auditor's worktree announcement",
		);
	});

	it("architect with worktreePath → architect task unchanged", () => {
		const task = buildAgentTask(
			"architect",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Architect should NOT have worktree announcement",
		);
		assert.ok(task.includes("architecture comment"), "Architect task unchanged");
	});

	it("researcher with worktreePath → task unchanged", () => {
		const task = buildAgentTask(
			"researcher",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Researcher should NOT have worktree announcement",
		);
		assert.ok(task.includes("web_crawl"), "Researcher task unchanged");
	});

	it("test-designer with worktreePath → task unchanged", () => {
		const task = buildAgentTask(
			"test-designer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			"/home/wt",
		);
		assert.ok(
			!task.includes("Your current working directory IS the worktree"),
			"Test-designer should NOT have worktree announcement",
		);
		assert.ok(task.includes("test plan"), "Test-designer task unchanged");
	});

	it("All existing tests still pass with new optional params — backward compat", () => {
		// Same call as existing tests — no worktreePath, no branchName
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("git diff main"), "Existing auditor behavior preserved");
		assert.ok(task.includes("AUDIT_DECISION"), "Existing auditor behavior preserved");
	});
});
