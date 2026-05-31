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
import {
	resolveNextStatus,
	resolveNextStatusFromAgentOutput,
	extractAuditScore,
	type AuditScore,
	type WorkflowStep,
	WORKFLOW,
} from "../workflow.ts";
import { findStatusOption, setItemStatus } from "../github/project.ts";
import {
	postIssueComment,
	extractAgentCommentBody,
	extractStructuredAuditOutput,
	commitAndPush,
} from "../github/index.ts";
import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../agent-output.ts";
import type { AgentOutput } from "../types.ts";

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
 * Resolve next status from agent output.
 * Uses structured JSON parsing (parseAgentOutput) when possible,
 * falls back to text marker matching for backward compatibility.
 * Returns null if no status can be determined (pipeline should stop).
 */
export function calculateNextStatus(
	agentName: string,
	agentOutput: string,
	textOnly: string,
): NextStatusResult {
	const step = WORKFLOW.find((s) => s.agentName === agentName);
	if (!step) return { status: null, stopReason: `No workflow step for agent '${agentName}'` };

	// Phase 2: Try structured AgentOutput parsing first
	// Use agentOutput (raw text) for JSON parsing since textOnly strips JSON
	const structuredStatus = resolveNextStatusFromAgentOutput(step, agentOutput);
	if (structuredStatus) {
		return { status: structuredStatus };
	}

	// Fallback: old marker-based detection (for backward compatibility)
	const nextStatus = resolveNextStatus(step, textOnly) ?? resolveNextStatus(step, agentOutput);
	if (!nextStatus) {
		// No marker found — try to infer forward status from step's markerMap
		// This handles cases where agent completed work but output lacks marker
		const inferredStatus = inferForwardStatus(step);
		if (inferredStatus) {
			return { status: inferredStatus };
		}
		return { status: null, stopReason: `No completion marker found in ${agentName} output` };
	}
	return { status: nextStatus };
}

/**
 * Infer the forward status from a workflow step's markerMap.
 * Returns the first marker value whose key is a forward marker
 * (doesn't start with AUDIT or FEEDBACK). Returns first value if
 * none match, or null if markerMap is empty.
 */
export function inferForwardStatus(step: WorkflowStep): string | null {
	if (!step.markerMap) return null;
	const entries = Object.entries(step.markerMap);
	// Prefer forward markers (keys without AUDIT_/FEEDBACK_ prefix)
	for (const [key, val] of entries) {
		if (!key.startsWith("AUDIT") && !key.startsWith("FEEDBACK")) {
			return val;
		}
	}
	// Fall back to first entry (audit/feedback only) if no forward marker
	return entries[0]?.[1] || null;
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
	model?: string,
): PipelineAgentResult {
	const statusLabel = !result.success ? "FAILED" : usedRetry ? "SUCCESS (after retry)" : "SUCCESS";

	return {
		agentName: result.agentName,
		status: statusLabel as PipelineAgentResult["status"],
		durationMs: result.durationMs,
		tokenCount: result.tokenCount,
		toolCount: result.toolCount,
		model,
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
): Promise<boolean> {
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
			return false;
		}
	}

	// Audit output processing
	if (agentName === "auditor") {
		await handleAuditorOutput(pi, ctx, agentOutput, result, issueNum, config);
	}

	// Default: pipeline should continue
	return true;
}

/**
 * Handle auditor-specific output: structured comments for approval/rejection.
 * Uses parseAgentOutput for deterministic comment building.
 */
async function handleAuditorOutput(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentOutput: string,
	result: AgentRunResult,
	issueNum: number,
	config: SupervisorConfig,
): Promise<void> {
	// Try structured AgentOutput parsing first
	const parseResult = parseAgentOutput(agentOutput);
	let actionFromOutput: "APPROVED" | "REJECTED" | undefined;
	let commentBodyFromOutput: string | undefined;

	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		if (output.action === "APPROVED" || output.action === "REJECTED") {
			actionFromOutput = output.action;
			commentBodyFromOutput = output.commentBody;
		}
	}

	// Fallback to old text-marker-based extraction
	if (!actionFromOutput) {
		const auditOutput = extractStructuredAuditOutput(agentOutput);
		if (!auditOutput) return;

		if (auditOutput.decision === "APPROVED") {
			const bodyToPost = auditOutput.commentBody || agentOutput;
			if (bodyToPost) {
				try {
					await postIssueComment(pi, issueNum, config.repo, bodyToPost);
					ctx.ui.notify("Audit comment posted (text marker fallback)", "info");
				} catch (acErr: unknown) {
					console.warn(
						`[supervisor] Failed to post audit comment: ${
							acErr instanceof Error ? acErr.message : String(acErr)
						}`,
					);
				}
			}
		} else if (auditOutput.decision === "REJECTED") {
			const bodyToPost = auditOutput.commentBody || agentOutput;
			if (bodyToPost) {
				try {
					await postIssueComment(pi, issueNum, config.repo, bodyToPost);
					ctx.ui.notify("Audit rejection comment posted (text marker fallback)", "info");
				} catch (rcErr: unknown) {
					console.warn(
						`[supervisor] Failed to post rejection comment: ${
							rcErr instanceof Error ? rcErr.message : String(rcErr)
						}`,
					);
				}
			}
		}
		return;
	}

	// Structured path: build comment from AgentOutput
	if (actionFromOutput === "APPROVED") {
		const bodyToPost = commentBodyFromOutput || buildApprovalCommentFromOutput(result.textOnly);
		if (bodyToPost) {
			try {
				await postIssueComment(pi, issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit approval comment posted (from structured output)", "info");
			} catch (acErr: unknown) {
				console.warn(
					`[supervisor] Failed to post audit comment: ${
						acErr instanceof Error ? acErr.message : String(acErr)
					}`,
				);
			}
		}
	} else if (actionFromOutput === "REJECTED") {
		const bodyToPost = commentBodyFromOutput || agentOutput;
		if (bodyToPost) {
			try {
				await postIssueComment(pi, issueNum, config.repo, bodyToPost);
				ctx.ui.notify("Audit rejection comment posted (from structured output)", "info");
			} catch (rcErr: unknown) {
				console.warn(
					`[supervisor] Failed to post rejection comment: ${
						rcErr instanceof Error ? rcErr.message : String(rcErr)
					}`,
				);
			}
		} else {
			console.warn(
				`[supervisor] Auditor rejected issue #${issueNum} but no comment body provided in structured output.`,
			);
		}
	}
}

/**
 * Build an approval comment from AgentOutput fields when no explicit commentBody provided.
 */
function buildApprovalCommentFromOutput(agentOutput: string): string | null {
	// Try to extract structured content from the agent output
	const parseResult = parseAgentOutput(agentOutput);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		const lines: string[] = ["## Audit Approved", ""];

		if (output.auditScore) {
			const passing = output.auditScore.passing;
			const total = output.auditScore.total;
			lines.push(
				`**Score:** ${passing}/${total} — ${passing === total ? "All dimensions passing" : `${passing} of ${total} dimensions passing`}`,
			);
			lines.push("");
		}

		if (output.findings && output.findings.length > 0) {
			lines.push("### Findings");
			lines.push("");
			for (const finding of output.findings) {
				lines.push(`- **${finding.severity} — ${finding.dimension}**`);
				if (finding.symptom) lines.push(`  - Symptom: ${finding.symptom}`);
				if (finding.consequence) lines.push(`  - Consequence: ${finding.consequence}`);
				if (finding.remedy) lines.push(`  - Remedy: ${finding.remedy}`);
				if (finding.location) lines.push(`  - Location: ${finding.location}`);
			}
			lines.push("");
		}

		lines.push("Fix and resubmit if issues remain.");
		return lines.join("\n");
	}

	return null;
}
