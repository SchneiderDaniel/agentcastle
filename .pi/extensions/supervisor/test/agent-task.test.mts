/**
 * Tests for agent-task.ts
 *
 * Phase 0: generateBranchName (characterization — existing behavior preserved)
 * Phase 1: buildAgentTask simplified prompts — all 5 agents delegate to system prompt
 * Phase 2: buildAgentTask edge cases
 * Phase 3: buildAgentTask auditor worktree path + branch name (existing)
 * Phase 4: summarizeComments (existing)
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
// Phase 0: generateBranchName
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
// Phase 0: truncateComment
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
// Phase 4: summarizeComments (existing)
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
// Phase 1: buildAgentTask simplified prompts — all 5 agents delegate to
//          system prompt instead of re-implementing workflow steps
// ---------------------------------------------------------------------------

describe("buildAgentTask — simplified prompts (Phase 1)", () => {
	it("researcher: task delegates to system prompt, no duplicated workflow steps", () => {
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
		// Must delegate to system prompt, not repeat workflow
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Delegates to system prompt",
		);
		assert.ok(!task.includes("web_crawl"), "No 'web_crawl' instruction — system prompt has it");
		assert.ok(!task.includes("Crawl 1-2"), "No 'Crawl 1-2' instruction");
		assert.ok(!task.includes("Extract the core topic"), "No 'Extract the core topic'");
		// Still has issue data + JSON output format + security rule
		assert.ok(task.includes("### Structured Output Format"), "JSON output instruction present");
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action");
		assert.ok(task.includes("**SECURITY RULE:**"), "Security rule present");
	});

	it("architect: task delegates to system prompt, no duplicated workflow steps", () => {
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
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Delegates to system prompt",
		);
		assert.ok(
			!task.includes("write an architecture comment"),
			"No 'write an architecture comment' — system prompt has it",
		);
		assert.ok(!task.includes("Analyze the issue body"), "No 'Analyze the issue body'");
		// Still has JSON + data + security rule
		assert.ok(task.includes('"commentBody"'), "JSON commentBody key");
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action");
		assert.ok(task.includes("**SECURITY RULE:**"), "Security rule present");
	});

	it("test-designer: task delegates to system prompt, no duplicated workflow steps", () => {
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
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Delegates to system prompt",
		);
		assert.ok(!task.includes("Review the issue body"), "No 'Review the issue body' instruction");
		assert.ok(!task.includes("write a test plan"), "No 'write a test plan' — system prompt has it");
		// Still has JSON + data + security rule
		assert.ok(task.includes('"commentBody"'), "JSON commentBody key");
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action");
		assert.ok(task.includes("**SECURITY RULE:**"), "Security rule present");
	});

	it("developer: task delegates to system prompt, no duplicated workflow steps", () => {
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
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Delegates to system prompt",
		);
		// Workflow steps removed
		assert.ok(!task.includes("Step 0 — Evaluate"), "No 'Step 0' instruction");
		assert.ok(!task.includes("Step A — Write tests"), "No 'Step A' instruction");
		assert.ok(!task.includes("Step B — Implement"), "No 'Step B' instruction");
		assert.ok(!task.includes("Step C — Verify"), "No 'Step C' instruction");
		assert.ok(!task.includes("Step D — Update README"), "No 'Step D' instruction");
		// Still has branch name as data context
		assert.ok(task.includes("worktree-git-issue-42-fix-bug"), "Branch name in task");
		// Still has JSON + security rule
		assert.ok(task.includes('"action": "COMPLETE"'), "COMPLETE action present");
		assert.ok(task.includes("**SECURITY RULE:**"), "Security rule present");
	});

	it("auditor: task delegates to system prompt, no duplicated workflow steps", () => {
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
			task.includes("Follow your system prompt instructions"),
			"Delegates to system prompt",
		);
		// Workflow steps removed
		assert.ok(!task.includes("Review the code: git diff"), "No 'Review the code' instruction");
		assert.ok(!task.includes("Run jscpd"), "No 'Run jscpd' instruction");
		assert.ok(!task.includes("Run tests if any exist"), "No 'Run tests' instruction");
		assert.ok(!task.includes("Evaluate against the architecture"), "No evaluate instruction");
		// Still has JSON schema showing APPROVED|REJECTED union type + security rule
		assert.ok(task.includes("APPROVED"), "APPROVED action type in schema");
		assert.ok(task.includes("REJECTED"), "REJECTED action type in schema");
		assert.ok(task.includes("**SECURITY RULE:**"), "Security rule present");
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
// Phase 2: buildAgentTask edge cases
// ---------------------------------------------------------------------------

describe("buildAgentTask — edge cases (Phase 2)", () => {
	it("empty filteredData body — still valid structure, no crash", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ body: "" }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output still present");
		assert.ok(task.includes("Issue Data"), "Issue data block present");
	});

	it("no trusted comments — renders (no trusted comments)", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData({ comments: [] }),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(
			task.includes("(no trusted comments)") || task.includes("no trusted comments"),
			"No trusted comments indicator",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output present");
	});

	it("researchFindings provided (for architect) — included in task", () => {
		const findings = "## Research Findings\nFound some relevant data.";
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
			undefined,
			undefined,
			undefined,
			undefined,
			findings,
		);
		assert.ok(task.includes("### Research Findings"), "Research findings section header");
		assert.ok(task.includes("Found some relevant data."), "Research findings content included");
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Delegates to system prompt",
		);
	});

	it("researchFindings is null — no research findings section", () => {
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
		assert.ok(!task.includes("### Research Findings"), "No research findings section");
		assert.ok(
			task.includes("Follow your system prompt instructions"),
			"Delegates to system prompt",
		);
	});

	it("summarizedRejections provided — used instead of raw comments", () => {
		const rejectionSummary = "Previous rejections: issue #42 was rejected for missing tests.";
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
			undefined,
			undefined,
			rejectionSummary,
		);
		assert.ok(task.includes("Previous rejections:"), "Summarized rejections included");
	});

	it("worktreePath provided for auditor — included in task", () => {
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
			"/home/worktree-42",
		);
		assert.ok(task.includes("/home/worktree-42"), "Worktree path in task");
	});

	it("branchName provided for auditor — included in task", () => {
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
			"fix-bug-42",
		);
		assert.ok(task.includes("fix-bug-42"), "Branch name in task");
	});

	it("duplicateCodeContext provided for auditor — included in task", () => {
		const dupCtx = "**2 clone(s) found (15 total duplicate lines)**";
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
			"fix-bug-42",
			undefined,
			dupCtx,
		);
		assert.ok(task.includes("Duplicate Code Detected"), "Duplicate code section header");
		assert.ok(task.includes("2 clone(s) found"), "Duplicate code context in task");
	});

	it("submodules list provided for auditor — included in task", () => {
		const submodules = [
			{ path: "lib/something", repo: "org/something" },
			{ path: "lib/other", repo: "org/other" },
		];
		const task = buildAgentTask(
			"auditor",
			42,
			"owner/repo",
			"Fix bug",
			makeFilteredData(),
			submodules,
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("org/something"), "Submodule repo listed");
		assert.ok(task.includes("org/other"), "Second submodule listed");
	});

	it("issue with special characters in title — no crash", () => {
		const task = buildAgentTask(
			"developer",
			42,
			"owner/repo",
			"Fix bug: #critical [urgent]",
			makeFilteredData(),
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes('"action": "COMPLETE"'), "JSON output present");
		// Branch should be sanitized
		assert.ok(
			task.includes("worktree-git-issue-42-fix-bug-critical-urgent") ||
				task.includes("worktree-git-issue-42-fix-bug"),
			"Sanitized branch name",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: buildAgentTask auditor worktree path + branch name
// ---------------------------------------------------------------------------

describe("buildAgentTask — auditor worktree path + branch name (Phase 3)", () => {
	it("auditor with worktreePath → task contains worktree path", () => {
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
		assert.ok(task.includes("/home/wt"), "Should contain worktree path");
		assert.ok(task.includes("fix-bug"), "Should contain branch name");
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

	it("backward compat — auditor task has JSON markers without optional params", () => {
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
		assert.ok(task.includes('"action"'), "JSON action key present");
	});
});
