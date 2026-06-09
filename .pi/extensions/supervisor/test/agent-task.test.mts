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
import {
	generateBranchName,
	buildAgentTask,
	truncateComment,
	summarizeComments,
} from "../agent/task.ts";
import type { FilteredIssueData } from "../config/types.ts";

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
// Phase 1: truncateComment
// ---------------------------------------------------------------------------

describe("truncateComment", () => {
	it("body ≤2000 chars → returned unchanged, no overflow note", () => {
		const body = "short body";
		const result = truncateComment(body);
		assert.strictEqual(result, body);
	});

	it("body exactly 2000 chars → returned unchanged", () => {
		const body = "x".repeat(2000);
		const result = truncateComment(body);
		assert.strictEqual(result, body);
	});

	it("body 2001 chars → truncated at 2000 with overflow note", () => {
		const body = "x".repeat(2001);
		const result = truncateComment(body);
		assert.ok(result.endsWith("\n…[+1 more chars]"));
		assert.strictEqual(result.split("\n")[0].length, 2000);
	});

	it("body 10000 chars → truncated at 2000 with correct overflow count", () => {
		const body = "x".repeat(10000);
		const result = truncateComment(body);
		assert.ok(result.endsWith("\n…[+8000 more chars]"));
	});

	it("body empty string → returns empty string", () => {
		const result = truncateComment("");
		assert.strictEqual(result, "");
	});

	it("custom maxLength parameter truncates at custom boundary", () => {
		const body = "x".repeat(100);
		const result = truncateComment(body, 50);
		assert.ok(result.endsWith("\n…[+50 more chars]"));
	});

	it("body shorter than custom maxLength → no truncation", () => {
		const body = "short";
		const result = truncateComment(body, 100);
		assert.strictEqual(result, "short");
	});
});

// ---------------------------------------------------------------------------
// Phase 2: summarizeComments threshold change
// ---------------------------------------------------------------------------

describe("summarizeComments", () => {
	it("0 comments → returns (no trusted comments)", () => {
		const result = summarizeComments([]);
		assert.strictEqual(result, "(no trusted comments)");
	});

	it("1 comment → full verbatim with header", () => {
		const result = summarizeComments([{ author: "user1", body: "First comment body" }]);
		assert.ok(result.includes("--- Comment #1 by @user1 ---"));
		assert.ok(result.includes("First comment body"));
		assert.ok(!result.includes("### Previous Comments"));
	});

	it("2 comments → both rendered verbatim (no summary bullets)", () => {
		const result = summarizeComments([
			{ author: "user1", body: "First comment" },
			{ author: "user2", body: "Second comment" },
		]);
		assert.ok(result.includes("--- Comment #1 by @user1 ---"));
		assert.ok(result.includes("First comment"));
		assert.ok(result.includes("--- Comment #2 by @user2 ---"));
		assert.ok(result.includes("Second comment"));
		assert.ok(!result.includes("### Previous Comments"));
	});

	it("3 comments → all three verbatim", () => {
		const result = summarizeComments([
			{ author: "a", body: "Body A" },
			{ author: "b", body: "Body B" },
			{ author: "c", body: "Body C" },
		]);
		assert.ok(result.includes("--- Comment #1 by @a ---"));
		assert.ok(result.includes("--- Comment #2 by @b ---"));
		assert.ok(result.includes("--- Comment #3 by @c ---"));
		assert.ok(!result.includes("### Previous Comments"));
	});

	it("7 comments → all seven verbatim (boundary: exactly at threshold)", () => {
		const comments = Array.from({ length: 7 }, (_, i) => ({
			author: `user${i + 1}`,
			body: `Comment body ${i + 1}`,
		}));
		const result = summarizeComments(comments);
		for (let i = 0; i < 7; i++) {
			assert.ok(result.includes(`--- Comment #${i + 1} by @user${i + 1} ---`));
		}
		assert.ok(result.includes("Comment body 3"));
		assert.ok(!result.includes("### Previous Comments"));
	});

	it("8 comments → first 7 summarized as bullets, 8th full (first above threshold)", () => {
		const comments = Array.from({ length: 8 }, (_, i) => ({
			author: `user${i + 1}`,
			body: `Comment body ${i + 1}`,
		}));
		const result = summarizeComments(comments);
		// Has summary block
		assert.ok(result.includes("### Previous Comments (summarized)"));
		// First 7 summarized as bullets
		for (let i = 0; i < 7; i++) {
			assert.ok(result.includes(`- @user${i + 1}:`));
		}
		// Latest comment is full
		assert.ok(result.includes("--- Comment #8 by @user8 ---"));
		assert.ok(result.includes("Comment body 8"));
	});

	it("9+ comments → earlier N-1 summarized as bullets, latest full", () => {
		const comments = Array.from({ length: 10 }, (_, i) => ({
			author: `user${i + 1}`,
			body: `Comment body ${i + 1}`,
		}));
		const result = summarizeComments(comments);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		// First 9 summarized as bullets
		for (let i = 0; i < 9; i++) {
			assert.ok(result.includes(`- @user${i + 1}:`));
		}
		// 10th comment is full
		assert.ok(result.includes("--- Comment #10 by @user10 ---"));
		assert.ok(result.includes("Comment body 10"));
	});

	it("8 comments with bodies >2000 chars → earlier comments truncated by truncateComment before bullet extraction, latest truncated", () => {
		const longBody = "x".repeat(3000);
		const comments = Array.from({ length: 8 }, (_, i) => ({
			author: `user${i + 1}`,
			body: i < 7 ? longBody : "Latest comment",
		}));
		const result = summarizeComments(comments);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		// Bullets exist for first 7 comments
		for (let i = 0; i < 7; i++) {
			assert.ok(result.includes(`- @user${i + 1}:`));
		}
		// Latest comment is shown in full
		assert.ok(result.includes("--- Comment #8 by @user8 ---"));
		assert.ok(result.includes("Latest comment"));
	});

	it("8 comments where earlier comments have --- lines → firstLine extraction skips them", () => {
		const comments = Array.from({ length: 8 }, (_, i) => ({
			author: `user${i + 1}`,
			body: i < 7 ? `--- old marker ---\nActual meaningful line ${i + 1}` : "Latest comment",
		}));
		const result = summarizeComments(comments);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		for (let i = 0; i < 7; i++) {
			assert.ok(result.includes(`- @user${i + 1}: Actual meaningful line ${i + 1}`));
		}
	});

	it("8 comments where earlier comment body is only --- lines → falls back to full preview", () => {
		const comments = Array.from({ length: 8 }, (_, i) => ({
			author: `user${i + 1}`,
			body: i < 7 ? "---" : "Latest comment",
		}));
		const result = summarizeComments(comments);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		for (let i = 0; i < 7; i++) {
			assert.ok(result.includes(`- @user${i + 1}: ---`));
		}
	});

	it("8 comments where author name is empty → rendered as @ in bullet", () => {
		const comments = Array.from({ length: 8 }, (_, i) => ({
			author: i < 7 ? "" : "user8",
			body: `Body ${i + 1}`,
		}));
		const result = summarizeComments(comments);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		for (let i = 0; i < 7; i++) {
			assert.ok(result.includes("- @:"));
		}
	});

	it("8 comments where bullet content exactly 200 chars → not truncated further", () => {
		const exact200 = "a".repeat(200);
		const comments = Array.from({ length: 8 }, (_, i) => ({
			author: `user${i + 1}`,
			body: i < 7 ? exact200 : "Latest comment",
		}));
		const result = summarizeComments(comments);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		for (let i = 0; i < 7; i++) {
			assert.ok(result.includes(`- @user${i + 1}: ${exact200}`));
		}
	});

	it("8 comments where bullet content >200 chars → sliced to 200 chars", () => {
		const longLine = "a".repeat(300);
		const comments = Array.from({ length: 8 }, (_, i) => ({
			author: `user${i + 1}`,
			body: i < 7 ? longLine : "Latest comment",
		}));
		const result = summarizeComments(comments);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		for (let i = 0; i < 7; i++) {
			const expectedSlice = "a".repeat(200);
			assert.ok(result.includes(`- @user${i + 1}: ${expectedSlice}`));
		}
		assert.ok(!result.includes("a".repeat(201)));
	});

	// ─── Configurable threshold tests ────────────────────────────────

	it("custom threshold=3 → 3 comments verbatim, 4th triggers summary", () => {
		const comments = Array.from({ length: 4 }, (_, i) => ({
			author: `user${i + 1}`,
			body: `Comment body ${i + 1}`,
		}));
		const result = summarizeComments(comments, 3);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		assert.ok(result.includes("- @user1:"));
		assert.ok(result.includes("- @user2:"));
		assert.ok(result.includes("- @user3:"));
		assert.ok(result.includes("--- Comment #4 by @user4 ---"));
	});

	it("custom threshold=10 → 10 comments verbatim, 11th triggers summary", () => {
		const comments = Array.from({ length: 11 }, (_, i) => ({
			author: `user${i + 1}`,
			body: `Comment body ${i + 1}`,
		}));
		const result = summarizeComments(comments, 10);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		for (let i = 0; i < 10; i++) {
			assert.ok(result.includes(`- @user${i + 1}:`));
		}
		assert.ok(result.includes("--- Comment #11 by @user11 ---"));
	});

	it("threshold=0 → always summarize (empty bullet list, latest comment full)", () => {
		const comments = [{ author: "user1", body: "Single comment" }];
		const result = summarizeComments(comments, 0);
		// threshold=0 skips verbatim branch (threshold>0 guard), goes to summarize path
		assert.ok(result.includes("### Previous Comments (summarized)"), "should have summary heading");
		assert.ok(result.includes("--- Comment #1 by @user1 ---"), "should have latest comment");
		assert.ok(result.includes("Single comment"), "should include comment body");
	});

	it("custom maxCommentChars=100 → truncates at 100 chars", () => {
		const longBody = "x".repeat(250);
		const comments = [
			{ author: "user1", body: longBody },
			{ author: "user2", body: "Short" },
		];
		const result = summarizeComments(comments, 7, 100);
		// Both comments are under threshold so rendered verbatim
		assert.ok(result.includes("--- Comment #1 by @user1 ---"));
		assert.ok(result.includes("…[+150 more chars]"));
		assert.ok(result.includes("--- Comment #2 by @user2 ---"));
	});

	it("custom maxCommentChars=100 with >threshold comments → bullets truncated at 100, latest truncated", () => {
		const longBody = "y".repeat(200);
		const comments = Array.from({ length: 5 }, (_, i) => ({
			author: `user${i + 1}`,
			body: i < 4 ? longBody : "z".repeat(200),
		}));
		const result = summarizeComments(comments, 3, 100);
		assert.ok(result.includes("### Previous Comments (summarized)"));
		// Bullets get first line of truncated body (100 chars of y)
		assert.ok(result.includes("- @user1:"));
		// Latest comment truncated
		assert.ok(result.includes("…[+100 more chars]"));
	});
});

// ---------------------------------------------------------------------------
// Phase 2: buildAgentTask auditor — structured output markers
// ---------------------------------------------------------------------------
// The auditor task uses structured output markers (AUDIT_DECISION, PR_BODY,
// COMMENT_BODY) instead of running gh CLI commands. Pipeline reads markers
// and handles PR creation/comment posting programmatically.

describe("buildAgentTask — auditor JSON output markers", () => {
	it("contains JSON action: APPROVED and REJECTED markers", () => {
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
		assert.ok(task.includes('"action": "APPROVED"'), "Should contain APPROVED action");
		assert.ok(task.includes('"action": "REJECTED"'), "Should contain REJECTED action");
	});

	it("contains prBody and commentBody keys in approved flow", () => {
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
		assert.ok(task.includes('"prBody"'), "Should contain prBody key");
		assert.ok(task.includes('"commentBody"'), "Should contain commentBody key");
	});

	it("contains prTitle with issue number", () => {
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
		assert.ok(task.includes('"prTitle"'), "Should contain prTitle key");
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

	it("contains commentBody in REJECT flow section", () => {
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
		const rejectSection = task.substring(task.lastIndexOf('"action": "REJECTED"'));
		assert.ok(rejectSection.includes('"commentBody"'), "REJECT flow contains commentBody key");
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

describe("buildAgentTask — other agents (JSON output markers)", () => {
	it("architect task: JSON output instead of gh CLI", () => {
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
		assert.ok(task.includes('"commentBody"'), "JSON commentBody key");
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action");
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
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action present");
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

	it("test-designer task: JSON output with commentBody", () => {
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
		assert.ok(task.includes('"commentBody"'), "JSON commentBody key");
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action");
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

	it("backward compat — auditor task has git diff and JSON markers without optional params", () => {
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
		assert.ok(task.includes('"action"'), "JSON action key present");
	});
});
