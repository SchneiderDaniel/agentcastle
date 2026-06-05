// ─── Tests: pipeline/pr-creation.ts — createPrOnApproval ──────────
// Unit tests for the PR creation flow. Mocks pi.exec and ctx.ui.
// Follows the same mock pattern as handler.test.mts.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, PipelineAgentResult } from "../../config/types.ts";
import { createPrOnApproval } from "../../pipeline/pr-creation.ts";

// ─── Call Tracking ────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

interface NotifyCall {
	message: string;
	level: string;
}

// ─── Mock Helpers ──────────────────────────────────────────────────

/**
 * Create a mock ExtensionAPI with controllable exec responses.
 * If result.code !== 0, pi.exec returns a rejected promise (simulating
 * command failure). Otherwise returns a resolved promise.
 */
function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			const result = results[idx++];
			if (!result || result.code !== 0) {
				const errMsg = result?.stderr || result?.stdout || `Command failed: ${cmd}`;
				return Promise.reject(new Error(errMsg));
			}
			return Promise.resolve(result);
		}) as ExtensionAPI["exec"],
		registerCommand: (() => {}) as ExtensionAPI["registerCommand"],
		sendMessage: (() => {}) as ExtensionAPI["sendMessage"],
	} as ExtensionAPI;
}

/**
 * Create a mock ExtensionCommandContext with trackable notifications.
 */
function createMockCtx(notifyCalls?: NotifyCall[]): ExtensionCommandContext {
	const notifyLog = notifyCalls || [];
	return {
		cwd: "/repo",
		ui: {
			notify: (message: string, level?: string) => {
				notifyLog.push({ message, level: level || "info" });
			},
			setStatus: () => {},
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
}

// ─── Fixtures ──────────────────────────────────────────────────────

const mockConfig: SupervisorConfig = {
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
	worktreeBase: "../worktrees",
	branchPrefix: "worktree-git-issue-",
};

const mockAgentResult: PipelineAgentResult = {
	agentName: "developer",
	status: "SUCCESS",
	durationMs: 10000,
	tokenCount: 5000,
	toolCount: 20,
};

/**
 * Helper: create a gh pr list response for no existing PR.
 */
function emptyPrListResponse(): string {
	return "[]";
}

/**
 * Helper: create a gh pr list response for an existing PR.
 */
function existingPrListResponse(prNumber: number = 123): string {
	return JSON.stringify([
		{
			number: prNumber,
			mergeable: "MERGEABLE",
			mergeStateStatus: "CLEAN",
			headRefName: "worktree-git-issue-42-test",
			baseRefName: "main",
		},
	]);
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("createPrOnApproval()", () => {
	it("Happy path with worktree: push → check PR → create PR → success notifications", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "Everything up-to-date", stderr: "" },
				// 2. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 3. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Verify exec call order: push, pr list, pr create
		assert.equal(execCalls.length, 3, "should have 3 exec calls");

		// 1. git push
		assert.equal(execCalls[0].cmd, "git");
		assert.equal(execCalls[0].args[0], "push");
		assert.equal(execCalls[0].args[1], "--force");
		assert.equal(execCalls[0].args[2], "origin");
		assert.equal(execCalls[0].args[3], "worktree-git-issue-42-test");
		assert.equal(execCalls[0].opts.cwd, "/worktrees/wt-42");
		assert.equal(execCalls[0].opts.timeout, 15000);

		// 2. gh pr list
		assert.equal(execCalls[1].cmd, "gh");
		assert.equal(execCalls[1].args[0], "pr");
		assert.equal(execCalls[1].args[1], "list");

		// 3. gh pr create
		assert.equal(execCalls[2].cmd, "gh");
		assert.equal(execCalls[2].args[0], "pr");
		assert.equal(execCalls[2].args[1], "create");

		// Verify success notifications
		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		assert.equal(infoNotifies.length, 1, "should have exactly 1 info notification");
		assert.ok(
			infoNotifies[0].message.includes("PR #456 created"),
			"should have PR creation success notification",
		);
	});

	it("Happy path without worktree: skip git push → check PR → create PR → success", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 2. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			undefined, // no worktreePath
			"worktree-git-issue-42-test",
		);

		// Verify no git push call
		const gitPushCalls = execCalls.filter((c) => c.cmd === "git" && c.args[0] === "push");
		assert.equal(gitPushCalls.length, 0, "no git push when worktreePath is undefined");

		// Verify PR was created
		assert.equal(execCalls.length, 2, "should have 2 exec calls");
		assert.equal(execCalls[0].cmd, "gh");
		assert.equal(execCalls[0].args[1], "list");
		assert.equal(execCalls[1].cmd, "gh");
		assert.equal(execCalls[1].args[1], "create");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const prCreatedNotify = infoNotifies.find((n) => n.message.includes("PR #456 created"));
		assert.ok(prCreatedNotify, "should have PR creation success notification");
	});

	it("Existing PR found: push → check PR → update via gh pr edit", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh pr list (existing PR found)
				{ code: 0, stdout: existingPrListResponse(123), stderr: "" },
				// 3. gh pr edit
				{ code: 0, stdout: "", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Verify call order: push, pr list, pr edit
		assert.equal(execCalls.length, 3);
		assert.equal(execCalls[0].cmd, "git");
		assert.equal(execCalls[1].cmd, "gh");
		assert.equal(execCalls[1].args[1], "list");
		assert.equal(execCalls[2].cmd, "gh");
		assert.equal(execCalls[2].args[0], "pr");
		assert.equal(execCalls[2].args[1], "edit");
		assert.equal(execCalls[2].args[2], "123"); // existing PR number

		// Verify no gh pr create call
		const prCreateCalls = execCalls.filter((c) => c.cmd === "gh" && c.args[1] === "create");
		assert.equal(prCreateCalls.length, 0, "no gh pr create when PR already exists");

		// Verify update notification
		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const updateNotify = infoNotifies.find((n) => n.message.includes("PR #123 updated"));
		assert.ok(updateNotify, "should have PR update notification");
	});

	it("Push failure: warning notification delivered, PR creation still attempted", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force FAILS
				{ code: 1, stdout: "", stderr: "push failed: network error" },
				// 2. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 3. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Verify warning notification for push failure
		const warningNotifies = notifyCalls.filter((n) => n.level === "warning");
		const pushWarning = warningNotifies.find((n) =>
			n.message.toLowerCase().includes("push failed"),
		);
		assert.ok(pushWarning, "should have warning notification for push failure");

		// Verify PR creation was still attempted
		assert.equal(execCalls.length, 3, "should have 3 exec calls despite push failure");
		assert.equal(execCalls[1].cmd, "gh");
		assert.equal(execCalls[1].args[1], "list");
		assert.equal(execCalls[2].cmd, "gh");
		assert.equal(execCalls[2].args[1], "create");
	});

	it("gh pr create failure: error notification delivered, function does not throw unhandled", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 3. gh pr create FAILS
				{ code: 1, stdout: "", stderr: "create failed: GraphQL error" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		// Function should NOT throw — errors are caught internally
		await assert.doesNotReject(
			createPrOnApproval(
				pi,
				ctx,
				42,
				"Test issue",
				mockConfig as any,
				[mockAgentResult],
				"/worktrees/wt-42",
				"worktree-git-issue-42-test",
			),
		);

		// Verify error notification
		const errorNotifies = notifyCalls.filter((n) => n.level === "error");
		const prErrorNotify = errorNotifies.find((n) => n.message.toLowerCase().includes("failed"));
		assert.ok(prErrorNotify, "should have error notification for PR creation failure");
	});

	it("gh pr list failure: caught, warning notification, PR creation still attempted", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh pr list FAILS
				{ code: 1, stdout: "", stderr: "network error" },
				// 3. gh pr create (fallback)
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Verify warning notification for checkPrConflicts failure
		const warningNotifies = notifyCalls.filter((n) => n.level === "warning");
		const checkWarning = warningNotifies.find((n) =>
			n.message.toLowerCase().includes("pr conflict check failed"),
		);
		assert.ok(checkWarning, "should have warning notification for PR conflict check failure");

		// Verify PR creation was still attempted
		assert.equal(execCalls.length, 3, "should have 3 exec calls despite check failure");
		assert.equal(execCalls[2].cmd, "gh");
		assert.equal(execCalls[2].args[1], "create", "should still attempt PR creation");
	});

	it("Regression: does NOT call git rev-list --count anywhere", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. git push --force
				{ code: 0, stdout: "push ok", stderr: "" },
				// 2. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 3. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			"/worktrees/wt-42",
			"worktree-git-issue-42-test",
		);

		// Scan all exec calls for rev-list
		const revListCalls = execCalls.filter(
			(c) => c.cmd === "git" && c.args.some((a) => a === "rev-list" || a.includes("rev-list")),
		);
		assert.equal(revListCalls.length, 0, "should NOT call git rev-list --count");
	});

	it("agentResults empty array: still writes PR body file and creates PR", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 2. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[], // empty agentResults
			undefined,
			"worktree-git-issue-42-test",
		);

		// Verify PR was created despite empty agentResults
		assert.equal(execCalls.length, 2, "should have 2 exec calls");
		const prCreateCalls = execCalls.filter((c) => c.cmd === "gh" && c.args[1] === "create");
		assert.equal(prCreateCalls.length, 1, "should create PR even with empty agentResults");

		const infoNotifies = notifyCalls.filter((n) => n.level === "info");
		const prCreatedNotify = infoNotifies.find((n) => n.message.includes("PR #456 created"));
		assert.ok(prCreatedNotify, "should have PR creation success notification");
	});

	it("Boundary: worktreeBranch undefined, no worktreePath: branch generated from issueNum and title", async () => {
		const execCalls: ExecCall[] = [];
		const notifyCalls: NotifyCall[] = [];
		const pi = createMockPi(
			[
				// 1. gh pr list (no existing PR)
				{ code: 0, stdout: emptyPrListResponse(), stderr: "" },
				// 2. gh pr create
				{ code: 0, stdout: "https://github.com/owner/repo/pull/456\n", stderr: "" },
			],
			execCalls,
		);
		const ctx = createMockCtx(notifyCalls);

		// Call without worktreePath and worktreeBranch to trigger auto-generation
		await createPrOnApproval(
			pi,
			ctx,
			42,
			"Test issue",
			mockConfig as any,
			[mockAgentResult],
			undefined, // no worktreePath
			undefined, // no worktreeBranch — will be auto-generated
		);

		// Verify the generated branch name appears in the gh pr list call
		const prListCall = execCalls.find((c) => c.cmd === "gh" && c.args[1] === "list");
		assert.ok(prListCall, "should have gh pr list call");
		const headArgIndex = prListCall!.args.indexOf("--head");
		assert.notEqual(headArgIndex, -1, "should have --head argument");
		const branchName = prListCall!.args[headArgIndex + 1];
		assert.ok(branchName, "branch name should be present");
		assert.ok(
			branchName.startsWith("worktree-git-issue-42-"),
			`branch name should be generated from issue number: ${branchName}`,
		);

		// Verify PR was created
		const prCreateCall = execCalls.find((c) => c.cmd === "gh" && c.args[1] === "create");
		assert.ok(prCreateCall, "should have gh pr create call");
		const createHeadArgIndex = prCreateCall!.args.indexOf("--head");
		assert.notEqual(createHeadArgIndex, -1, "should have --head argument in pr create");
		const createBranchName = prCreateCall!.args[createHeadArgIndex + 1];
		assert.equal(createBranchName, branchName, "pr create should use same generated branch name");
	});
});
