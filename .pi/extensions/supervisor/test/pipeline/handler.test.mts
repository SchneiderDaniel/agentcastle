// ─── Tests: pipeline/handler.ts — handlePostPipeline ordering ───
// Tests the extracted post-loop function to verify merge runs before cleanup.
// Mocks pi.exec and ctx.ui.confirm to simulate all code paths.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PipelineAgentResult } from "../../types.ts";
import { handlePostPipeline } from "../../pipeline/handler.ts";

// ─── Call tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

function createMockCtx(confirmResult: boolean = true): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			confirm: async () => confirmResult,
		},
	} as unknown as ExtensionCommandContext;
}

// ─── Fixtures ──────────────────────────────────────────────────────

const mockConfig = {
	repo: "owner/repo",
	projectNumber: 1,
	statusField: "Status",
	statusMapping: {
		Backlog: "",
		Architecture: "architect",
		Research: "researcher",
		TestDesign: "test-designer",
		Implementation: "developer",
		Audit: "auditor",
		Done: "",
	},
	maxRejections: 3,
	codeowners: ["user1"],
	defaultBranch: "main",
	remote: "origin",
	worktreeBase: "../worktrees/",
	branchPrefix: "worktree-git-issue-",
	agentTimeoutsMin: {},
};

const mockAgentResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 10000,
	tokenCount: 5000,
	toolCount: 20,
};

// Each exec call returns a JSON array for gh `pr list` by default (used by checkPrConflicts).
// Function resultBuilder builds the response array incrementally.
function prListResult(hasConflict: boolean): string {
	return JSON.stringify([
		{
			number: 123,
			mergeable: hasConflict ? "CONFLICTING" : "MERGEABLE",
			mergeStateStatus: hasConflict ? "DIRTY" : "CLEAN",
			headRefName: "worktree-git-issue-42-test",
			baseRefName: "main",
		},
	]);
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("handlePostPipeline() — merge/cleanup ordering (Phase 1)", () => {
	it("calls handlePostPipelineMerge before cleanupWorktree (call order: merge, cleanup)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// 1. checkPrConflicts → gh pr list returns conflict
				{ code: 0, stdout: prListResult(true), stderr: "" },
				// 2. tryAutoMerge: git fetch origin main
				{ code: 0, stdout: "fetch ok", stderr: "" },
				// 3. tryAutoMerge: git merge origin/main --no-edit
				{ code: 0, stdout: "merge ok", stderr: "" },
				// 4. git push
				{ code: 0, stdout: "push ok", stderr: "" },
				// 5. cleanupWorktree: git worktree remove --force
				{ code: 0, stdout: "", stderr: "" },
				// 6. cleanupWorktree: git worktree prune
				{ code: 0, stdout: "", stderr: "" },
				// 7. cleanupWorktree: git branch -D
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// Verify merge calls come before cleanup calls
		const mergeCalls = calls.filter(
			(c) =>
				c.cmd === "gh" ||
				(c.cmd === "git" &&
					(c.args[0] === "fetch" || c.args[0] === "merge" || c.args[0] === "push")),
		);
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);

		assert.ok(mergeCalls.length > 0, "should have merge-related exec calls");
		assert.ok(cleanupCalls.length > 0, "should have cleanup exec calls");

		// All merge calls must come before any cleanup call
		const lastMergeIdx = calls.lastIndexOf(mergeCalls[mergeCalls.length - 1]);
		const firstCleanupIdx = calls.indexOf(cleanupCalls[0]);
		assert.ok(
			lastMergeIdx < firstCleanupIdx,
			`merge calls (indices 0..${lastMergeIdx}) must precede cleanup calls (index ${firstCleanupIdx})`,
		);
	});

	it("calls both merge and cleanup when merge succeeds", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(true), stderr: "" },
				{ code: 0, stdout: "fetch ok", stderr: "" },
				{ code: 0, stdout: "merge ok", stderr: "" },
				{ code: 0, stdout: "push ok", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// Both merge and cleanup calls present
		const hasMerge = calls.some(
			(c) =>
				c.cmd === "gh" || (c.cmd === "git" && (c.args[0] === "fetch" || c.args[0] === "merge")),
		);
		const hasCleanup = calls.some((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(hasMerge, "merge calls should be present");
		assert.ok(hasCleanup, "cleanup calls should be present");
	});

	it("still calls cleanupWorktree when handlePostPipelineMerge succeeds (no-conflict path)", async () => {
		const calls: ExecCall[] = [];
		// No-conflict path: gh pr list returns mergeable PR, no tryAutoMerge
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(false), stderr: "" },
				// cleanupWorktree
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// cleanup should still run even though no auto-merge was needed
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run even when no merge needed");
	});

	it("skips merge when isDoneStatus is false, but still calls cleanup", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				// cleanupWorktree
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Architecture", // not Done
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// No gh calls (no merge attempted)
		const ghCalls = calls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "no merge/gh calls when not Done");

		// Cleanup should still run
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run even when merge skipped");
	});

	it("skips merge when agentResults is empty, but still calls cleanup", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[], // empty agentResults
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		const ghCalls = calls.filter((c) => c.cmd === "gh");
		assert.equal(ghCalls.length, 0, "no merge/gh calls when agentResults empty");

		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.ok(cleanupCalls.length > 0, "cleanup should still run");
	});

	it("skips cleanup when worktreePath is undefined, but merge still runs", async () => {
		const calls: ExecCall[] = [];
		// Merge runs (checkPrConflicts) — needs gh response
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(false), stderr: "" }, // gh pr list
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			undefined, // no worktreePath
			"worktree-git-issue-42-test",
		);

		// Merge runs (makes gh call), but cleanup skips
		const ghCalls = calls.filter((c) => c.cmd === "gh");
		assert.ok(ghCalls.length > 0, "merge/gh calls should still run");
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.equal(cleanupCalls.length, 0, "no cleanup calls when worktreePath undefined");
	});

	it("skips cleanup when worktreeBranch is undefined, but merge still runs", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: prListResult(false), stderr: "" }, // gh pr list
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			undefined, // no worktreeBranch
		);

		const ghCalls = calls.filter((c) => c.cmd === "gh");
		assert.ok(ghCalls.length > 0, "merge/gh calls should still run");
		const cleanupCalls = calls.filter((c) => c.cmd === "git" && c.args[0] === "worktree");
		assert.equal(cleanupCalls.length, 0, "no cleanup calls when worktreeBranch undefined");
	});

	it("runs cleanup even when merge check fails (network error, checkPrConflicts throws)", async () => {
		const calls: ExecCall[] = [];
		// gh call fails → checkPrConflicts throws → handlePostPipelineMerge catches it
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "network error" }, // gh fails
				// cleanup still runs
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		const ctx = createMockCtx(true);

		await handlePostPipeline(
			42,
			"Test issue",
			"Done",
			[mockAgentResult],
			mockConfig as any,
			pi,
			ctx,
			"/repo/../worktrees/worktree-git-issue-42-test",
			"worktree-git-issue-42-test",
		);

		// Cleanup should still run even though merge check failed
		const cleanupCalls = calls.filter(
			(c) => c.cmd === "git" && (c.args[0] === "worktree" || c.args[0] === "branch"),
		);
		assert.ok(cleanupCalls.length > 0, "cleanup should run even when merge check fails");
	});
});
