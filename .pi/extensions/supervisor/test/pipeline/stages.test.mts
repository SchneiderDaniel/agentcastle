// ─── Tests: pipeline/stages.ts — pure + async functions ─────────
// Covers all exported functions in stages.ts with mock dependencies.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	ProjectField,
	AgentRunResult,
	FilteredIssueData,
} from "../../config/types.ts";
import {
	resolveAgentName,
	isDoneStatus,
	isWorktreeAgent,
	isRejectionLimitReached,
	calculateNextStatus,
	trackAuditScore,
	buildAgentResultEntry,
	createStageState,
	type StageState,
	handleBacklogTransition,
	applyStatusTransition,
	handlePostAgentSuccess,
} from "../../pipeline/stages.ts";

// ─── Mock Helpers ──────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

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

function createMockCtx(): ExtensionCommandContext {
	return {
		cwd: "/repo",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: {
				fg: (_style: string, text: string) => text,
			},
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

function makeProjectFields(statusFieldId: string): ProjectField[] {
	return [
		{
			id: statusFieldId,
			name: "Status",
			type: "single_select",
			options: [
				{ id: "opt_bk", name: "Backlog" },
				{ id: "opt_ar", name: "Architecture" },
				{ id: "opt_re", name: "Research" },
				{ id: "opt_td", name: "TestDesign" },
				{ id: "opt_im", name: "Implementation" },
				{ id: "opt_au", name: "Audit" },
				{ id: "opt_dn", name: "Done" },
			],
		},
	];
}

// ─── Tests: resolveAgentName() ────────────────────────────────────

describe("resolveAgentName()", () => {
	it("returns mapped agent name for known status via workflow agentName", () => {
		// "Architecture" maps to "architect" in WORKFLOW's agentName
		const result = resolveAgentName("Architecture", mockConfig);
		assert.equal(result, "architect");
	});

	it("returns null for unknown status", () => {
		const result = resolveAgentName("NonExistentStatus", mockConfig);
		assert.equal(result, null);
	});

	it("returns null when status has no agent mapping and no statusMapping entry", () => {
		// "Done" is in WORKFLOW, has no agentName property, and not in statusMapping
		const result = resolveAgentName("Done", { ...mockConfig, statusMapping: {} });
		assert.equal(result, null);
	});
});

// ─── Tests: isDoneStatus() ────────────────────────────────────────

describe("isDoneStatus()", () => {
	it("returns true for 'Done'", () => {
		assert.equal(isDoneStatus("Done"), true);
	});

	it("returns true for 'done' (lowercase)", () => {
		assert.equal(isDoneStatus("done"), true);
	});

	it("returns true for 'DONE' (uppercase)", () => {
		assert.equal(isDoneStatus("DONE"), true);
	});

	it("returns false for any other string", () => {
		assert.equal(isDoneStatus("Architecture"), false);
		assert.equal(isDoneStatus("In Progress"), false);
		assert.equal(isDoneStatus(""), false);
		assert.equal(isDoneStatus("don"), false);
	});
});

// ─── Tests: isWorktreeAgent() ─────────────────────────────────────

describe("isWorktreeAgent()", () => {
	it("returns true for 'developer'", () => {
		assert.equal(isWorktreeAgent("developer"), true);
	});

	it("returns true for 'auditor'", () => {
		assert.equal(isWorktreeAgent("auditor"), true);
	});

	it("returns false for 'architect'", () => {
		assert.equal(isWorktreeAgent("architect"), false);
	});

	it("returns false for 'researcher'", () => {
		assert.equal(isWorktreeAgent("researcher"), false);
	});

	it("returns false for 'test-designer'", () => {
		assert.equal(isWorktreeAgent("test-designer"), false);
	});
});

// ─── Tests: isRejectionLimitReached() ─────────────────────────────

describe("isRejectionLimitReached()", () => {
	it("returns true when rejection marker count >= maxRejections", () => {
		const comments = [
			{ body: "## Audit Rejected\nSome issue" },
			{ body: "## Audit Rejected\nAnother issue" },
			{ body: "## Audit Rejected\nThird issue" },
			{ body: "## Audit Approved\nLooks good" },
		];
		assert.equal(isRejectionLimitReached(comments, 3), true);
	});

	it("returns false when below maxRejections", () => {
		const comments = [
			{ body: "## Audit Rejected\nSome issue" },
			{ body: "## Audit Approved\nLooks good" },
		];
		assert.equal(isRejectionLimitReached(comments, 3), false);
	});

	it("returns false when maxRejections is 0", () => {
		const comments = [{ body: "## Audit Rejected\nSome issue" }];
		assert.equal(isRejectionLimitReached(comments, 0), false);
	});

	it("returns false when maxRejections is undefined", () => {
		const comments = [{ body: "## Audit Rejected\nSome issue" }];
		assert.equal(isRejectionLimitReached(comments, undefined), false);
	});

	it("matches case-insensitive '## Audit Rejected'", () => {
		const comments = [
			{ body: "## audit rejected\nsome issue" },
			{ body: "## AUDIT REJECTED\nanother" },
			{ body: "## Audit Rejected\nthird" },
		];
		assert.equal(isRejectionLimitReached(comments, 3), true);
	});

	it("does not match unrelated headers", () => {
		const comments = [
			{ body: "## Audit Approved\nLooks good" },
			{ body: "## Some other header\ncontent" },
		];
		assert.equal(isRejectionLimitReached(comments, 1), false);
	});
});

// ─── Tests: calculateNextStatus() ─────────────────────────────────

describe("calculateNextStatus()", () => {
	it("returns matching status for latest marker in textOnly", () => {
		// Auditor step has markerMap with AUDIT_DECISION: APPROVED → Done
		const result = calculateNextStatus(
			"auditor",
			"some output",
			"Some text\nAUDIT_DECISION: APPROVED\nmore text",
		);
		assert.equal(result.status, "Done");
	});

	it("falls back to textOutput when textOnly has no marker", () => {
		const result = calculateNextStatus(
			"architect",
			"Some output\nARCHITECTURE_COMPLETE",
			"text only no markers here",
		);
		assert.equal(result.status, "Research");
	});

	it("infers forward status when no marker found", () => {
		const result = calculateNextStatus("developer", "just some output", "just some text");
		// Developer's markerMap has { IMPLEMENTATION_COMPLETE: "Audit" }
		// inferForwardStatus returns "Audit" as the forward status
		assert.equal(result.status, "Audit");
	});

	it("last occurrence wins (overrides earlier markers)", () => {
		// Researcher can map to both TestDesign and Architecture (via canLoopBackTo)
		// Test: last marker wins
		const result = calculateNextStatus(
			"researcher",
			"RESEARCH_COMPLETE\nsome text\nFEEDBACK_ARCHITECTURE",
			"RESEARCH_COMPLETE\nsome text\nFEEDBACK_ARCHITECTURE",
		);
		// Last marker is FEEDBACK_ARCHITECTURE → Architecture
		assert.equal(result.status, "Architecture");
	});

	it("returns null for unknown agent name", () => {
		const result = calculateNextStatus("unknown-agent", "some output", "some text");
		assert.equal(result.status, null);
		assert.ok(result.stopReason);
	});
});

// ─── Tests: trackAuditScore() ─────────────────────────────────────

describe("trackAuditScore()", () => {
	it("parses 'AUDIT_SCORE: 3/5' to {passing: 3, total: 5}", () => {
		const state = createStageState("Audit");
		const result = trackAuditScore("Some output\nAUDIT_SCORE: 3/5", state);
		assert.ok(result);
		assert.equal(result!.score.passing, 3);
		assert.equal(result!.score.total, 5);
	});

	it("returns null when no marker", () => {
		const state = createStageState("Audit");
		const result = trackAuditScore("Some output with no score", state);
		assert.equal(result, null);
	});

	it("tracks 'improving' trend across consecutive calls", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 2/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 4/5", state);
		assert.equal(result!.trend, "improving");
	});

	it("tracks 'declining' trend across consecutive calls", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 4/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 2/5", state);
		assert.equal(result!.trend, "declining");
	});

	it("tracks 'stable' trend when score unchanged", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 3/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 3/5", state);
		assert.equal(result!.trend, "stable");
	});

	it("increments cycleCount each call with valid marker", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 3/5", state);
		trackAuditScore("AUDIT_SCORE: 4/5", state);
		const result = trackAuditScore("AUDIT_SCORE: 5/5", state);
		assert.equal(result!.cycleCount, 3);
	});

	it("does not increment cycleCount when no marker found", () => {
		const state = createStageState("Audit");
		trackAuditScore("AUDIT_SCORE: 3/5", state);
		trackAuditScore("no score here", state); // no marker
		const result = trackAuditScore("AUDIT_SCORE: 4/5", state);
		assert.equal(result!.cycleCount, 2); // only 2 valid calls
	});

	it("last occurrence of AUDIT_SCORE wins", () => {
		const state = createStageState("Audit");
		const result = trackAuditScore("AUDIT_SCORE: 2/5\nsome stuff\nAUDIT_SCORE: 5/5", state);
		assert.equal(result!.score.passing, 5);
		assert.equal(result!.score.total, 5);
	});
});

// ─── Tests: buildAgentResultEntry() ───────────────────────────────

describe("buildAgentResultEntry()", () => {
	const baseResult: AgentRunResult = {
		output: "",
		success: true,
		agentName: "developer",
		toolCount: 10,
		tokenCount: 5000,
		durationMs: 30000,
		textOutput: "done",
		summaryLine: "Implemented feature",
		errorOutput: "",
		textOnly: "IMPLEMENTATION_COMPLETE",
	};

	it("maps success=true to 'SUCCESS'", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.status, "SUCCESS");
	});

	it("maps success=true + usedRetry=true to 'SUCCESS (after retry)'", () => {
		const entry = buildAgentResultEntry(baseResult, true);
		assert.equal(entry.status, "SUCCESS (after retry)");
	});

	it("maps success=false to 'FAILED'", () => {
		const entry = buildAgentResultEntry({ ...baseResult, success: false }, false);
		assert.equal(entry.status, "FAILED");
	});

	it("copies durationMs/tokenCount/toolCount/agentName from result", () => {
		const entry = buildAgentResultEntry(
			{
				...baseResult,
				success: true,
				agentName: "auditor",
				durationMs: 15000,
				tokenCount: 3000,
				toolCount: 5,
			},
			false,
		);
		assert.equal(entry.agentName, "auditor");
		assert.equal(entry.durationMs, 15000);
		assert.equal(entry.tokenCount, 3000);
		assert.equal(entry.toolCount, 5);
	});

	it("model is undefined when not provided", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		assert.equal(entry.model, undefined);
	});

	it("model is set when provided", () => {
		const entry = buildAgentResultEntry(baseResult, false, "anthropic/claude-sonnet-4-20250514");
		assert.equal(entry.model, "anthropic/claude-sonnet-4-20250514");
	});

	it("model shows as short name in pipeline output", () => {
		const entry = buildAgentResultEntry(baseResult, false, "anthropic/claude-sonnet-4-20250514");
		const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");
		assert.equal(shortModel(entry.model), "claude-sonnet-4-20250514");
	});

	it("model is undefined when not provided, shows dash in output", () => {
		const entry = buildAgentResultEntry(baseResult, false);
		const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");
		assert.equal(shortModel(entry.model), "—");
	});
});

// ─── Tests: handleBacklogTransition() ─────────────────────────────

describe("handleBacklogTransition()", () => {
	const statusFieldId = "sf_status";

	it("calls setItemStatus with correct args and returns 'Architecture' on success", async () => {
		const calls: ExecCall[] = [];
		// setItemStatus calls gh(pi, ["project", "item-edit", ...])
		// which calls pi.exec("gh", [...])
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const fields = makeProjectFields(statusFieldId);

		const result = await handleBacklogTransition(
			pi,
			fields,
			statusFieldId,
			"item_123",
			"project_456",
		);
		assert.equal(result, "Architecture");

		// Verify the gh project item-edit call was made
		assert.ok(calls.length >= 1);
		const ghCall = calls.find((c) => c.cmd === "gh");
		assert.ok(ghCall, "setItemStatus should call gh");
		assert.ok(ghCall!.args.includes("item_123"));
		assert.ok(ghCall!.args.includes("project_456"));
	});

	it("throws when 'Architecture' option not found", async () => {
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }]);
		// No "Architecture" option
		const fields: ProjectField[] = [
			{
				id: statusFieldId,
				name: "Status",
				type: "single_select",
				options: [
					{ id: "opt_bk", name: "Backlog" },
					{ id: "opt_re", name: "Research" },
				],
			},
		];

		await assert.rejects(
			() => handleBacklogTransition(pi, fields, statusFieldId, "item_123", "project_456"),
			/Cannot find 'Architecture' status option/,
		);
	});

	it("throws when setItemStatus fails", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "network error" }], calls);
		const fields = makeProjectFields(statusFieldId);

		await assert.rejects(
			() => handleBacklogTransition(pi, fields, statusFieldId, "item_123", "project_456"),
			/Failed to set status/,
		);
	});
});

// ─── Tests: applyStatusTransition() ───────────────────────────────

describe("applyStatusTransition()", () => {
	const statusFieldId = "sf_status";

	it("calls setItemStatus with correct option id and returns targetStatus", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const fields = makeProjectFields(statusFieldId);

		const result = await applyStatusTransition(
			pi,
			"item_123",
			"project_456",
			fields,
			statusFieldId,
			"Audit",
		);
		assert.equal(result, "Audit");

		// Verify gh was called
		const ghCall = calls.find((c) => c.cmd === "gh");
		assert.ok(ghCall, "setItemStatus should call gh");
	});

	it("throws when option not found", async () => {
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }]);
		const fields: ProjectField[] = [
			{
				id: statusFieldId,
				name: "Status",
				type: "single_select",
				options: [{ id: "opt_bk", name: "Backlog" }],
			},
		];

		await assert.rejects(
			() => applyStatusTransition(pi, "item_123", "project_456", fields, statusFieldId, "Audit"),
			/Cannot find 'Audit' option on board/,
		);
	});
});

// ─── Tests: handlePostAgentSuccess() ─────────────────────────────

describe("handlePostAgentSuccess()", () => {
	const baseResult: AgentRunResult = {
		output: "",
		success: true,
		agentName: "architect",
		toolCount: 5,
		tokenCount: 2000,
		durationMs: 10000,
		textOutput: "COMMENT_BODY:\n## Architecture\nSome design\nCOMMENT_BODY_END",
		summaryLine: "Wrote architecture",
		errorOutput: "",
		textOnly:
			"COMMENT_BODY:\n## Architecture\nSome design\nCOMMENT_BODY_END\nARCHITECTURE_COMPLETE",
	};

	it("posts comment for architect when output contains COMMENT_BODY — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const ctx = createMockCtx();
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			baseResult,
			"architect",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "architect comment post succeeds — pipeline should continue");
		// Should call gh issue comment
		const ghCall = calls.find((c) => c.cmd === "gh" && c.args.includes("issue"));
		assert.ok(ghCall, "should call gh issue comment for architect");
	});

	it("architect comment post fails (gh error) — returns true (advisory), pipeline continues", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "network error" }], calls);
		const ctx = createMockCtx();
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			baseResult,
			"architect",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "architect comment failure is advisory — pipeline should continue");
	});

	it("posts comment for test-designer when output contains COMMENT_BODY — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "test-designer",
			textOutput: "COMMENT_BODY:\n## Test Plan\nLots of tests\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Test Plan\nLots of tests\nCOMMENT_BODY_END\nTEST_PLAN_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"test-designer",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "test-designer success — pipeline should continue");
		const ghCall = calls.find((c) => c.cmd === "gh" && c.args.includes("issue"));
		assert.ok(ghCall, "should call gh issue comment for test-designer");
	});

	it("posts comment for researcher when output contains COMMENT_BODY — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "researcher",
			textOutput: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END\nRESEARCH_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"researcher",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "researcher success — pipeline should continue");
		const ghCall = calls.find((c) => c.cmd === "gh" && c.args.includes("issue"));
		assert.ok(ghCall, "should call gh issue comment for researcher");
	});

	it("researcher comment post fails (gh error) — returns true (advisory), pipeline continues", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "timeout" }], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "researcher",
			textOutput: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END",
			textOnly: "COMMENT_BODY:\n## Research Findings\nStuff\nCOMMENT_BODY_END\nRESEARCH_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"researcher",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(
			success,
			true,
			"researcher comment failure is advisory — pipeline should continue",
		);
	});

	it("commits and pushes for developer when worktreePath and branch provided — returns true", async () => {
		const calls: ExecCall[] = [];
		// developer commit+pull uses: commitAndPush which calls git add, commit, push
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add -A
				{ code: 0, stdout: "", stderr: "" }, // git commit
				{ code: 0, stdout: "", stderr: "" }, // git push
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "commit/push succeeds — pipeline should continue");
		// Should call git operations
		const gitCalls = calls.filter((c) => c.cmd === "git");
		assert.ok(gitCalls.length > 0, "should call git operations for developer");
	});

	it("developer git add fails (code 1) — returns false, signals critical failure", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "fatal: could not add" }, // git add fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git add failure must return false — pipeline should stop");
	});

	it("developer git commit fails with real error (not 'nothing to commit') — returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 1, stdout: "", stderr: "fatal: bad object" }, // git commit fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git commit failure must return false — pipeline should stop");
	});

	it("developer git push fails (network error) — returns false", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 0, stdout: "", stderr: "" }, // git commit succeeds
				{ code: 1, stdout: "", stderr: "fatal: could not push" }, // git push fails
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, false, "git push failure must return false — pipeline should stop");
	});

	it("developer commit returns 'nothing to commit' — returns true (still pushes, branch may not exist on remote)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // git add succeeds
				{ code: 1, stdout: "", stderr: "nothing to commit, working tree clean" }, // git commit: nothing to commit
				{ code: 0, stdout: "Everything up-to-date", stderr: "" }, // git push succeeds
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "'nothing to commit' returns silently — pipeline continues");
		// calls: git add, git commit, git push (branch may not exist on remote), git diff (README check)
		assert.equal(calls.length, 4, "should call add + commit + push + diff");
		// Verify push was called (fix #595: branch may not exist on remote yet)
		const pushCall = calls[2];
		assert.equal(pushCall.cmd, "git", "third call should be git");
		assert.equal(pushCall.args[0], "push", "third call should be push");
		// Verify the commit call happened
		const commitCall = calls[1];
		assert.ok(commitCall.args.includes("commit"), "second call should be commit");
	});

	it("developer with worktreePath undefined — returns true (no-op)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			undefined,
			"feature-branch",
			"Test issue",
		);

		assert.equal(success, true, "no worktreePath — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});

	it("developer with worktreeBranch undefined — returns true (no-op)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			"/repo/worktree",
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "no worktreeBranch — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});

	it("handles auditor approval output with structured AUDIT_DECISION — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput:
				"AUDIT_DECISION: APPROVED\nCOMMENT_BODY:\n## Audit Approved\nLooks good\nCOMMENT_BODY_END",
			textOnly:
				"AUDIT_DECISION: APPROVED\nCOMMENT_BODY:\n## Audit Approved\nLooks good\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "auditor — pipeline should continue");
		// Should call gh issue comment
		const ghCall = calls.find((c) => c.cmd === "gh" && c.args.includes("comment"));
		assert.ok(ghCall, "should post audit approval comment");
	});

	it("handles auditor rejection output — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput:
				"AUDIT_DECISION: REJECTED\nCOMMENT_BODY:\n## Audit Rejected\nFix it\nCOMMENT_BODY_END",
			textOnly:
				"AUDIT_DECISION: REJECTED\nCOMMENT_BODY:\n## Audit Rejected\nFix it\nCOMMENT_BODY_END",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "auditor — pipeline should continue");
		const ghCall = calls.find((c) => c.cmd === "gh" && c.args.includes("comment"));
		assert.ok(ghCall, "should post audit rejection comment");
	});

	it("handles auditor output with no COMMENT_BODY marker using deterministic fallback — returns true", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" }, // post issue comment fallback
			],
			calls,
		);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "auditor",
			textOutput: "AUDIT_DECISION: APPROVED\nSome details\nAUDIT_SCORE: 4/6",
			textOnly: "AUDIT_DECISION: APPROVED\nSome details\nAUDIT_SCORE: 4/6",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"auditor",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		assert.equal(success, true, "auditor — pipeline should continue");
		const ghCall = calls.find((c) => c.cmd === "gh" && c.args.includes("comment"));
		assert.ok(ghCall, "should post fallback comment");
	});

	it("does not post comment for developer (no comment body extraction needed)", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([], calls);
		const ctx = createMockCtx();
		const result: AgentRunResult = {
			...baseResult,
			agentName: "developer",
			textOutput: "IMPLEMENTATION_COMPLETE",
			textOnly: "IMPLEMENTATION_COMPLETE",
		};
		const filteredData: FilteredIssueData = {
			body: "",
			comments: [],
		};

		const success = await handlePostAgentSuccess(
			pi,
			ctx,
			result,
			"developer",
			42,
			mockConfig,
			filteredData,
			undefined,
			undefined,
			"Test issue",
		);

		// No gh calls expected for developer without worktree
		assert.equal(success, true, "no worktree — no-op, pipeline should continue");
		assert.equal(calls.length, 0);
	});
});

// ─── Tests: createStageState() ────────────────────────────────────

describe("createStageState()", () => {
	it("creates state with given initial status", () => {
		const state = createStageState("Architecture");
		assert.equal(state.loopStatus, "Architecture");
		assert.equal(state.lastAuditScore, null);
		assert.equal(state.auditCycleCount, 0);
	});

	it("creates state with 'Done' status", () => {
		const state = createStageState("Done");
		assert.equal(state.loopStatus, "Done");
	});
});
