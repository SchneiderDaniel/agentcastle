// ─── Pipeline Stages ─────────────────────────────────────────────
// Stage transition logic: agent dispatch, marker matching, status
// resolution, built-in status handling, audit score tracking,
// and post-agent-success side effects.
// Extracted from handler.ts to keep that file < 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	ProjectField,
	PipelineAgentResult,
	AgentRunResult,
	FilteredIssueData,
} from "../types.ts";
import { resolveNextStatus, extractAuditScore, type AuditScore, WORKFLOW } from "../workflow.ts";
import { findStatusOption, setItemStatus } from "../github/project.ts";
import {
	postIssueComment,
	extractAgentCommentBody,
	extractStructuredAuditOutput,
	buildAuditCommentFallback,
	commitAndPush,
} from "../github/index.ts";

// ─── Constants ────────────────────────────────────────────────────

export const MAX_PIPELINE_LOOPS = 20;

// ─── Stage State ──────────────────────────────────────────────────

/** Mutable state tracked across pipeline loop iterations. */
export interface StageState {
	loopStatus: string;
	lastAuditScore: AuditScore | null;
	auditCycleCount: number;
}

export function createStageState(initialStatus: string): StageState {
	return {
		loopStatus: initialStatus,
		lastAuditScore: null,
		auditCycleCount: 0,
	};
}

// ─── Built-in: Backlog ────────────────────────────────────────────

/**
 * Handle Backlog → Architecture transition.
 * Returns new status on success, throws with a message on failure.
 */
export async function handleBacklogTransition(
	pi: ExtensionAPI,
	fields: ProjectField[],
	statusFieldId: string,
	itemId: string,
	projectId: string,
): Promise<string> {
	const optId = findStatusOption(fields, statusFieldId, "Architecture");
	if (!optId) {
		throw new Error("Cannot find 'Architecture' status option");
	}
	try {
		await setItemStatus(pi, itemId, projectId, statusFieldId, optId);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to set status: ${msg}`);
	}
	return "Architecture";
}

// ─── Built-in: Done ───────────────────────────────────────────────

export function isDoneStatus(loopStatus: string): boolean {
	return loopStatus.toLowerCase() === "done";
}

// ─── Agent Name Resolution ────────────────────────────────────────

export function resolveAgentName(loopStatus: string, config: SupervisorConfig): string | null {
	const step = WORKFLOW.find((s) => s.status.toLowerCase() === loopStatus.toLowerCase());
	if (!step) return null;
	return step.agentName || config.statusMapping[loopStatus] || null;
}

// ─── Worktree Needed Check ────────────────────────────────────────

export function isWorktreeAgent(agentName: string): boolean {
	return agentName === "developer" || agentName === "auditor";
}

// ─── Check Rejection Limit ────────────────────────────────────────

export function isRejectionLimitReached(
	comments: Array<{ body: string }>,
	stepMaxRejections?: number,
): boolean {
	if (!stepMaxRejections || stepMaxRejections <= 0) return false;
	const rejectionCount = comments.filter((c) => {
		const body = c.body || "";
		return /##\s*Audit\s*Rejected/i.test(body);
	}).length;
	return rejectionCount >= stepMaxRejections;
}

// ─── Determine Next Status ────────────────────────────────────────

export interface NextStatusResult {
	status: string | null;
	stopReason?: string;
}

/**
 * Resolve next status from agent output using marker matching.
 * Returns null if no marker found (pipeline should stop).
 */
export function calculateNextStatus(
	agentName: string,
	agentOutput: string,
	textOnly: string,
): NextStatusResult {
	const step = WORKFLOW.find((s) => s.agentName === agentName);
	if (!step) return { status: null, stopReason: `No workflow step for agent '${agentName}'` };

	const nextStatus = resolveNextStatus(step, textOnly) ?? resolveNextStatus(step, agentOutput);
	if (!nextStatus) {
		return { status: null, stopReason: `No completion marker found in ${agentName} output` };
	}
	return { status: nextStatus };
}

// ─── Audit Score Tracking ─────────────────────────────────────────

export interface AuditScoreInfo {
	cycleCount: number;
	score: AuditScore;
	trend?: "improving" | "declining" | "stable";
}

/**
 * Track audit scores across pipeline iterations.
 * Returns the audit score info if a score marker is found, null otherwise.
 */
export function trackAuditScore(agentOutput: string, state: StageState): AuditScoreInfo | null {
	const currentAuditScore = extractAuditScore(agentOutput);
	if (!currentAuditScore) return null;

	state.auditCycleCount++;

	let trend: "improving" | "declining" | "stable" | undefined;
	if (state.lastAuditScore && state.auditCycleCount > 1) {
		const diff = currentAuditScore.passing - state.lastAuditScore.passing;
		if (diff > 0) trend = "improving";
		else if (diff < 0) trend = "declining";
		else trend = "stable";
	}

	state.lastAuditScore = currentAuditScore;

	return {
		cycleCount: state.auditCycleCount,
		score: currentAuditScore,
		trend,
	};
}

// ─── Status Transition ────────────────────────────────────────────

/**
 * Transition the issue to the next status on the project board.
 * Returns the new effective status.
 */
export async function applyStatusTransition(
	pi: ExtensionAPI,
	itemId: string,
	projectId: string,
	fields: ProjectField[],
	statusFieldId: string,
	targetStatus: string,
): Promise<string> {
	const optId = findStatusOption(fields, statusFieldId, targetStatus);
	if (!optId) {
		throw new Error(`Cannot find '${targetStatus}' option on board.`);
	}
	await setItemStatus(pi, itemId, projectId, statusFieldId, optId);
	return targetStatus;
}

// ─── Build Agent Result Entry ─────────────────────────────────────

export function buildAgentResultEntry(
	result: AgentRunResult,
	usedRetry: boolean,
): PipelineAgentResult {
	const statusLabel = !result.success ? "FAILED" : usedRetry ? "SUCCESS (after retry)" : "SUCCESS";

	return {
		agentName: result.agentName,
		status: statusLabel as PipelineAgentResult["status"],
		durationMs: result.durationMs,
		tokenCount: result.tokenCount,
		toolCount: result.toolCount,
	};
}

// ─── Post-Agent Success Processing ────────────────────────────────

/**
 * Handle post-agent-success side effects: issue comments, commit/push.
 */
export async function handlePostAgentSuccess(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: AgentRunResult,
	agentName: string,
	issueNum: number,
	config: SupervisorConfig,
	loopFilteredData: FilteredIssueData,
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
	issueTitle: string,
): Promise<void> {
	const agentOutput = result.textOutput || result.output || "";

	// Agent comments: architect, test-designer, researcher
	if (agentName === "architect" || agentName === "test-designer" || agentName === "researcher") {
		const commentBody = extractAgentCommentBody(agentOutput);
		if (commentBody) {
			try {
				await postIssueComment(pi, issueNum, config.repo, commentBody);
				ctx.ui.notify(`Posted ${agentName} comment on issue #${issueNum}`, "info");
			} catch (commentErr: unknown) {
				console.warn(
					`[supervisor] Failed to post ${agentName} comment: ${
						commentErr instanceof Error ? commentErr.message : String(commentErr)
					}`,
				);
			}
		}
	}

	// Commit and push for developer
	if (agentName === "developer" && worktreePath && worktreeBranch) {
		const commitMsg = `feat(#${issueNum}): ${issueTitle}`;
		try {
			await commitAndPush(pi, worktreePath, config.remote!, worktreeBranch, commitMsg);
			ctx.ui.notify("Changes committed and pushed to branch", "info");
		} catch (cpErr: unknown) {
			const cpMsg = cpErr instanceof Error ? cpErr.message : String(cpErr);
			ctx.ui.notify(`commitAndPush failed: ${cpMsg}`, "warning");
			console.warn(`[supervisor] commitAndPush failed: ${cpMsg}`);
		}
	}

	// Audit output processing
	if (agentName === "auditor") {
		await handleAuditorOutput(pi, ctx, agentOutput, result, issueNum, config);
	}
}

/**
 * Handle auditor-specific output: structured comments for approval/rejection.
 */
async function handleAuditorOutput(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentOutput: string,
	result: AgentRunResult,
	issueNum: number,
	config: SupervisorConfig,
): Promise<void> {
	const auditOutput = extractStructuredAuditOutput(agentOutput);
	if (!auditOutput) return;

	if (auditOutput.decision === "APPROVED") {
		if (auditOutput.commentBody) {
			try {
				await postIssueComment(pi, issueNum, config.repo, auditOutput.commentBody);
				ctx.ui.notify("Audit approval comment posted", "info");
			} catch (acErr: unknown) {
				console.warn(
					`[supervisor] Failed to post audit comment: ${
						acErr instanceof Error ? acErr.message : String(acErr)
					}`,
				);
			}
		} else {
			const fallbackBody = buildAuditCommentFallback(auditOutput.decision, result.textOnly);
			if (fallbackBody) {
				try {
					await postIssueComment(pi, issueNum, config.repo, fallbackBody);
					ctx.ui.notify("Audit approval comment posted (deterministic fallback)", "info");
				} catch (acErr: unknown) {
					console.warn(
						`[supervisor] Failed to post approval fallback comment: ${
							acErr instanceof Error ? acErr.message : String(acErr)
						}`,
					);
				}
			}
		}
	} else if (auditOutput.decision === "REJECTED") {
		const source = auditOutput.commentBody ? "COMMENT_BODY marker" : "deterministic fallback";
		const commentToPost =
			auditOutput.commentBody || buildAuditCommentFallback(auditOutput.decision, result.textOnly);
		if (commentToPost) {
			try {
				await postIssueComment(pi, issueNum, config.repo, commentToPost);
				ctx.ui.notify(`Audit rejection comment posted (${source})`, "info");
			} catch (rcErr: unknown) {
				console.warn(
					`[supervisor] Failed to post rejection ${source} comment: ${
						rcErr instanceof Error ? rcErr.message : String(rcErr)
					}`,
				);
			}
		} else {
			console.warn(
				`[supervisor] Auditor rejected issue #${issueNum} but no COMMENT_BODY marker ` +
					"or structured findings found — no comment posted.",
			);
		}
	}
}
