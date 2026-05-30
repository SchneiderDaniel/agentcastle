// ─── Tests: agent-task.ts — Phase 2 comment summarization ──────────
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentTask, generateBranchName, summarizeComments } from "./agent-task.ts";
import type { FilteredIssueData } from "./types";

// ─── Fixtures ─────────────────────────────────────────────────────

function makeComment(author: string, body: string): { author: string; body: string } {
	return { author, body };
}

function makeLongComment(author: string, minLength: number): { author: string; body: string } {
	return { author, body: "A".repeat(minLength) };
}

function makeIssueData(comments: Array<{ author: string; body: string }>): FilteredIssueData {
	return {
		body: "Issue body content",
		comments,
	};
}

// ─── generateBranchName ───────────────────────────────────────────

describe("generateBranchName", () => {
	it("creates slug from title", () => {
		const name = generateBranchName(310, "Test Issue Title");
		assert.ok(name.includes("test-issue-title"));
		assert.ok(name.includes("310"));
	});

	it("prefix defaults to worktree-git-issue-", () => {
		const name = generateBranchName(5, "Fix Bug");
		assert.ok(name.startsWith("worktree-git-issue-"));
	});

	it("accepts custom prefix", () => {
		const name = generateBranchName(5, "Fix Bug", "custom-");
		assert.ok(name.startsWith("custom-"));
	});

	it("handles special characters in title", () => {
		const name = generateBranchName(1, "Bug: high token consumption — regression!");
		assert.ok(name.includes("bug-high-token-consumption-regression"));
	});
});

// ─── summarizeComments helper ─────────────────────────────────────

describe("summarizeComments", () => {
	it("single comment — passes through unchanged (no summarization)", () => {
		const comments = [makeComment("user1", "## Architecture\nSimple design")];
		const result = summarizeComments(comments);
		assert.equal(result, "--- Comment #1 by @user1 ---\n## Architecture\nSimple design");
	});

	it("3 comments — first 2 summarized as bullet list, 3rd (latest) in full", () => {
		const comments = [
			makeComment("architect", "## Architecture\nFull architecture text here"),
			makeComment("tester", "## Test Plan\nFull test plan text here"),
			makeComment("latest", "## Latest\nFull latest comment here"),
		];
		const result = summarizeComments(comments);
		// Latest comment should appear in full
		assert.ok(result.includes("## Latest"), "latest comment should appear in full");
		assert.ok(result.includes("Full latest comment here"));
		// Earlier comments should be summarized (not full)
		assert.ok(
			!result.includes("Full architecture text here"),
			"first comment should be summarized",
		);
		assert.ok(!result.includes("Full test plan text here"), "second comment should be summarized");
		// Summary should have bullet points
		assert.ok(result.includes("- @architect"), "summary should mention first author");
		assert.ok(result.includes("- @tester"), "summary should mention second author");
	});

	it("comment >2000 chars — truncated with [+N more chars] note", () => {
		const comments = [makeComment("architect", "A".repeat(2500))];
		const result = summarizeComments(comments);
		assert.ok(result.includes("more chars"), "truncated comment should have overflow note");
		assert.ok(!result.includes("A".repeat(2500)), "full long text should not appear");
	});

	it("0 comments — returns (no trusted comments) string", () => {
		const result = summarizeComments([]);
		assert.equal(result, "(no trusted comments)");
	});

	it("summarization preserves author attribution for each summarized comment", () => {
		const comments = [
			makeComment("architect1", "## Architecture\nSome design"),
			makeComment("tester1", "## Test Plan\nSome tests"),
			makeComment("dev1", "## Latest\nFinal comment"),
		];
		const result = summarizeComments(comments);
		assert.ok(result.includes("@architect1"), "first author mentioned in summary");
		assert.ok(result.includes("@tester1"), "second author mentioned in summary");
		assert.ok(result.includes("@dev1"), "latest author attribution preserved");
	});

	it("very long content in summarized comments — individual truncation before summary", () => {
		const longBody = "Long content ".repeat(300); // ~3600 chars
		const comments = [makeComment("architect", longBody), makeComment("tester", "Normal content")];
		const result = summarizeComments(comments);
		assert.ok(result.includes("@architect"), "first author mentioned");
		assert.ok(result.includes("@tester"), "second author mentioned");
	});
});

// ─── buildAgentTask — with and without summarizedRejections ──────

describe("buildAgentTask — comment summarization", () => {
	it("single comment passes through verbatim without summarizedRejections", () => {
		const data = makeIssueData([makeComment("user1", "## Architecture\nSimple design")]);
		const task = buildAgentTask(
			"developer",
			310,
			"owner/repo",
			"Test",
			data,
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("## Architecture"));
		assert.ok(task.includes("Simple design"));
	});

	it("3 comments with summarizedRejections — uses summarized block + latest", () => {
		const comments = [
			makeComment("architect", "## Architecture\nFull text"),
			makeComment("tester", "## Test Plan\nFull text"),
			makeComment("latest", "## Latest\nFinal comment text"),
		];
		const summarized = summarizeComments(comments);
		const data = makeIssueData(comments);
		const task = buildAgentTask(
			"developer",
			310,
			"owner/repo",
			"Test",
			data,
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
			undefined,
			undefined,
			summarized,
		);
		// Summarized block should replace the raw comments
		assert.ok(task.includes("Final comment text"), "latest comment should appear");
		assert.ok(task.includes("- @architect"), "summary should have architect");
		assert.ok(task.includes("- @tester"), "summary should have tester");
		assert.ok(!task.includes("## Architecture\nFull text"), "should not have raw first comment");
	});

	it("0 comments — outputs '(no trusted comments)'", () => {
		const data = makeIssueData([]);
		const task = buildAgentTask(
			"developer",
			310,
			"owner/repo",
			"Test",
			data,
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		assert.ok(task.includes("(no trusted comments)"));
	});

	it("without summarizedRejections param — old behavior preserved (all comments verbatim)", () => {
		const data = makeIssueData([
			makeComment("user1", "First comment body"),
			makeComment("user2", "Second comment body"),
		]);
		const task = buildAgentTask(
			"developer",
			310,
			"owner/repo",
			"Test",
			data,
			[],
			"main",
			"origin",
			"../",
			"worktree-git-issue-",
		);
		// Both comments should appear in full
		assert.ok(task.includes("First comment body"));
		assert.ok(task.includes("Second comment body"));
		assert.ok(task.includes("by @user1"));
		assert.ok(task.includes("by @user2"));
	});
});
