/**
 * Tests for agent-task.ts
 *
 * Phase 1: generateBranchName (characterization — existing behavior preserved)
 * Phase 2: buildAgentTask auditor — summary file flow (new behavior)
 * Phase 3: buildAgentTask other agent types unchanged (regression safety net)
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { generateBranchName, buildAgentTask } from "../.pi/extensions/supervisor/agent-task.ts";
import type { FilteredIssueData } from "../.pi/extensions/supervisor/types.ts";

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
// Phase 2: buildAgentTask auditor — summary file flow
// ---------------------------------------------------------------------------

describe("buildAgentTask — auditor summary file flow", () => {
	it("contains SUMMARY_FILE variable for temp file path", () => {
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
		assert.ok(
			task.includes("SUMMARY_FILE=/tmp/audit-summary-42.md"),
			"Expected SUMMARY_FILE variable set to /tmp/audit-summary-42.md",
		);
	});

	it("contains --body-file (via $SUMMARY_FILE) for gh pr create", () => {
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
		assert.ok(task.includes("--body-file"), "Expected --body-file flag in task");
		assert.ok(task.includes("gh pr create"), "Expected gh pr create command in task");
		// Verify SUMMARY_FILE referenced somewhere near --body-file
		const lines = task.split("\n").filter((l) => l.includes("--body-file"));
		assert.ok(lines.length > 0, "Expected lines containing --body-file");
	});

	it("contains --body-file for gh issue comment", () => {
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
		assert.ok(task.includes("gh issue comment"), "Expected gh issue comment command in task");
		const commentLines = task
			.split("\n")
			.filter((l) => l.includes("gh issue comment") && l.includes("--body-file"));
		assert.ok(commentLines.length > 0, "Expected gh issue comment with --body-file");
	});

	it("contains write-summary-to-temp-file step BEFORE gh pr create", () => {
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
		const summaryFileAssign = task.indexOf("SUMMARY_FILE=/tmp/audit-summary-42.md");
		const catSummary = task.indexOf('cat > "$SUMMARY_FILE"');
		const prCreate = task.indexOf("gh pr create");

		assert.notStrictEqual(summaryFileAssign, -1, "Expected SUMMARY_FILE assignment");
		assert.notStrictEqual(catSummary, -1, 'Expected cat > "$SUMMARY_FILE"');
		assert.notStrictEqual(prCreate, -1, "Expected gh pr create");
		assert.ok(
			summaryFileAssign < prCreate,
			"Summary file assignment should appear before gh pr create",
		);
		assert.ok(catSummary < prCreate, 'cat > "$SUMMARY_FILE" should appear before gh pr create');
	});

	it("contains fallback to --body 'Closes #N' when summary file empty", () => {
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
		assert.ok(
			task.includes('--body "Closes #42"'),
			"Expected fallback --body 'Closes #42' in task",
		);
	});

	it("contains shell conditional for summary file existence check", () => {
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
		assert.ok(task.includes("if [ -s"), "Expected shell conditional checking summary file size");
	});

	it("with 1 submodule — companion PR uses --body-file with fallback", () => {
		const submodules = [{ path: "sub/a", repo: "owner/sub-a" }];
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(
			task.includes("gh pr create --repo owner/sub-a"),
			"Expected submodule pr create for owner/sub-a",
		);
		assert.ok(
			task.includes("--body-file"),
			"Expected --body-file in task (including submodule commands)",
		);
		// The hardcoded companion fallback string should be present as fallback
		assert.ok(
			task.includes('--body "Companion PR for'),
			"Expected fallback companion string in submodule section",
		);
	});

	it("with 1 submodule — contains fallback companion string when file empty", () => {
		const submodules = [{ path: "sub/a", repo: "owner/sub-a" }];
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		assert.ok(
			task.includes('--body "Companion PR for owner/repo#42"'),
			"Expected fallback companion PR body in submodule section",
		);
	});

	it("with empty submodules list — no submodule section generated", () => {
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
		assert.ok(!task.includes("submodule"), "Should not contain submodule section when list empty");
	});

	it("with 2 submodules — both use --body-file in their PR commands", () => {
		const submodules = [
			{ path: "sub/a", repo: "owner/sub-a" },
			{ path: "sub/b", repo: "owner/sub-b" },
		];
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		const matches = task.match(/--body-file/g);
		assert.ok(matches !== null, "Expected --body-file references");
		assert.ok(
			matches!.length >= 4,
			`Expected at least 4 --body-file references, got ${matches!.length}`,
		);
	});

	it("with 2 submodules — each submodule block uses --body-file", () => {
		const submodules = [
			{ path: "sub/a", repo: "owner/sub-a" },
			{ path: "sub/b", repo: "owner/sub-b" },
		];
		const task = buildAgentTask(
			"auditor",
			BASE_ARGS.issueNum,
			BASE_ARGS.repo,
			BASE_ARGS.title,
			BASE_ARGS.filteredData,
			submodules,
			BASE_ARGS.defaultBranch,
			BASE_ARGS.remote,
			BASE_ARGS.worktreeBase,
			BASE_ARGS.branchPrefix,
		);
		const subACmd = task.indexOf("gh pr create --repo owner/sub-a");
		const subBCmd = task.indexOf("gh pr create --repo owner/sub-b");
		assert.notStrictEqual(subACmd, -1, "Expected sub-a PR create command");
		assert.notStrictEqual(subBCmd, -1, "Expected sub-b PR create command");

		const subABody = task.slice(subACmd, subBCmd > -1 ? subBCmd : undefined);
		assert.ok(subABody.includes("--body-file"), "Submodule sub-a PR create should use --body-file");
	});
});

// ---------------------------------------------------------------------------
// Phase 3: other agent types unchanged (regression)
// ---------------------------------------------------------------------------

describe("buildAgentTask — other agents unchanged or adjusted", () => {
	it("architect task unchanged: contains gh issue comment with body", () => {
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
		assert.ok(task.includes("gh issue comment 42 --repo owner/repo --body"));
		assert.ok(task.includes('--body "...your architecture..."'));
	});

	it("developer task: no worktree setup, has commit + branch info + work-from-cwd note", () => {
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
		// Worktree is created by supervisor — no longer in agent task
		assert.ok(!task.includes("git worktree add"), "Should NOT contain git worktree add");
		// Commit instructions preserved (without cd prefix)
		assert.ok(task.includes("git add -A"));
		assert.ok(task.includes('git commit -m "feat(#42): Fix bug"'));
		// Branch info still present
		assert.ok(task.includes("worktree-git-issue-42-fix-bug"), "Should contain branch name");
		// Should mention current-directory workflow
		assert.ok(
			task.includes("Work from current directory") || task.includes("worktree already set up"),
			"Should mention worktree is pre-setup",
		);
	});

	it("researcher task unchanged: contains web_crawl + research format", () => {
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
		assert.ok(task.includes("web_crawl"));
		assert.ok(task.includes("## Research Findings"));
	});

	it("test-designer task unchanged: contains test plan comment instructions", () => {
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
		assert.ok(task.includes("test plan"));
		assert.ok(task.includes("gh issue comment"));
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
