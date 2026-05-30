// ─── Pipeline Handler ────────────────────────────────────────────
// Main /supervisor command handler: status loop, transitions, hook wiring.
// Orchestrates the full pipeline by importing from submodules.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunResult,
	SupervisorConfig,
	ProjectField,
	ProjectItem,
	PipelineAgentResult,
} from "../types.ts";
import { loadConfig, resolveTimeoutMs } from "../config.ts";
import {
	getProjectFields,
	getProjectItems,
	getProjectId,
	findIssueItem,
	getItemStatusName,
	findStatusOption,
	setItemStatus,
	postIssueComment,
	extractAgentCommentBody,
	extractStructuredAuditOutput,
	buildAuditCommentFallback,
	checkBlockedByDependencies,
	filterIssueData,
	commitAndPush,
} from "../github/index.ts";
import { parseAgentFile } from "../agent-loader.ts";
import { buildAgentTask, generateBranchName, summarizeComments } from "../agent-task.ts";
import { runAgent } from "../agent-runner.ts";
import { resolveNextStatus, extractAuditScore, type AuditScore, WORKFLOW } from "../workflow.ts";
import { countRejections, formatDuration } from "../formatting.ts";
import { runTscAndLspAudit } from "../pipeline-audit.ts";
import { buildPipelineSummary, validateAgentResult } from "../pipeline-output.ts";
import { handlePostPipelineMerge } from "../pipeline-merge.ts";
import { createWorktree, installWorktreeDeps, cleanupWorktree } from "./worktree.ts";
import { createPrOnApproval } from "./pr-creation.ts";
import { sendPipelineSummary, sendAgentResultMessage, sendPipelineError } from "./notifications.ts";

/**
 * Main supervisor handler — processes a GitHub issue through the full Kanban pipeline.
 */
export async function handleSupervisorCommand(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	const issueNum = parseInt(args?.trim() || "", 10);
	if (!issueNum || issueNum < 1) {
		ctx.ui.notify("Usage: /supervisor <issue-number>", "error");
		return;
	}

	const agentResults: PipelineAgentResult[] = [];
	let stopReason: string | undefined;
	let config!: SupervisorConfig;
	let issueTitle = "";
	let worktreePath: string | undefined;
	let worktreeBranch: string | undefined;

	try {
		config = loadConfig();

		// Initial fetch
		ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
		let issueData: Record<string, unknown> | null;
		try {
			issueData = await pi
				.exec("gh", [
					"issue",
					"view",
					String(issueNum),
					"--repo",
					config.repo,
					"--json",
					"number,title,body,author,comments",
				])
				.then((r) => JSON.parse(r.stdout || "{}"));
		} catch {
			ctx.ui.notify(`Issue #${issueNum} not found in ${config.repo}`, "error");
			return;
		}

		issueTitle = (issueData?.title as string) || `Issue #${issueNum}`;

		// Print issue header
		pi.sendMessage({
			customType: "supervisor",
			content: `## GitHub Issue: [#${issueNum}] ${issueTitle}\n\n**Repository:** \`${config.repo}\``,
			display: true,
		});

		// Code-level security: filter issue body + comments to trusted codeowners only
		const filteredData = filterIssueData(
			issueData as {
				author?: { login: string };
				body?: string;
				comments?: Array<{ author?: { login: string }; body?: string }>;
			},
			config.codeowners,
		);

		// Get board info
		ctx.ui.setStatus("supervisor", "Reading project board...");
		let fields: ProjectField[];
		let items: ProjectItem[];
		let projectId: string;

		try {
			fields = await getProjectFields(pi, config.projectNumber);
			items = await getProjectItems(pi, config.projectNumber);
			projectId = await getProjectId(pi, config.projectNumber);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("missing required scopes")) {
				ctx.ui.notify(
					"GitHub token missing 'project' scope. Run: gh auth refresh -s project",
					"error",
				);
			} else {
				ctx.ui.notify(`Failed to read project board: ${msg}`, "error");
			}
			ctx.ui.setStatus("supervisor", "");
			return;
		}

		const statusField = fields.find(
			(f) => f.name.toLowerCase() === config.statusField?.toLowerCase(),
		);
		if (!statusField) {
			ctx.ui.notify(
				`Status field '${config.statusField}' not found. Fields: ${fields.map((f) => f.name).join(", ")}`,
				"error",
			);
			ctx.ui.setStatus("supervisor", "");
			return;
		}

		const loopItem = findIssueItem(items, issueNum);
		if (!loopItem) {
			ctx.ui.notify(`Issue #${issueNum} not on project board #${config.projectNumber}.`, "error");
			ctx.ui.setStatus("supervisor", "");
			return;
		}

		// ── Dependency gate ──
		ctx.ui.setStatus("supervisor", "Checking dependencies...");
		try {
			const depsResult = await checkBlockedByDependencies(pi, issueNum, config.repo);
			if (depsResult.blocked) {
				const lines = depsResult.blockers.map((b) => {
					const prefix = b.type === "pullrequest" ? "!" : "#";
					return `${prefix}${b.number}: ${b.title} (open)`;
				});
				ctx.ui.notify(
					`Issue #${issueNum} is blocked by unresolved dependencies:\n${lines.join("\n")}`,
					"error",
				);
				ctx.ui.setStatus("supervisor", "");
				return;
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Dependency check failed: ${msg}`, "error");
			ctx.ui.setStatus("supervisor", "");
			return;
		}

		// ── Pipeline loop ──
		let loopStatus = getItemStatusName(loopItem);
		const MAX_LOOPS = 20;
		let lastAuditScore: AuditScore | null = null;
		let auditCycleCount = 0;

		for (let i = 0; i < MAX_LOOPS; i++) {
			ctx.ui.notify(`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`, "info");

			const step = WORKFLOW.find((s) => s.status.toLowerCase() === loopStatus.toLowerCase());
			if (!step) {
				const available = WORKFLOW.map((s) => s.status).join(", ");
				ctx.ui.notify(
					`No workflow step for status '${loopStatus}'. Available: ${available}`,
					"error",
				);
				stopReason = `No workflow step for status '${loopStatus}'`;
				break;
			}

			// ── Built-in: Backlog ──
			if (step.builtIn === "backlog") {
				const optId = findStatusOption(fields, statusField.id, "Architecture");
				if (!optId) {
					ctx.ui.notify("Cannot find 'Architecture' status option", "error");
					stopReason = "Backlog transition failed: cannot find 'Architecture' status option";
					break;
				}
				try {
					await setItemStatus(pi, loopItem.id, projectId, statusField.id, optId);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`Failed to set status: ${msg}`, "error");
					stopReason = `Backlog transition failed: ${msg}`;
					break;
				}
				ctx.ui.notify(`Issue #${issueNum} moved: Backlog → Architecture`, "info");
				loopStatus = "Architecture";
				continue;
			}

			// ── Built-in: Done ──
			if (step.builtIn === "done") {
				ctx.ui.notify(`Issue #${issueNum} is Done. Pipeline complete.`, "info");
				break;
			}

			const agentName = step.agentName || config.statusMapping[loopStatus];
			if (!agentName) {
				const mapped = Object.keys(config.statusMapping).join(", ");
				ctx.ui.notify(`No agent for status '${loopStatus}'. Mapped: ${mapped}`, "error");
				stopReason = `No agent for status '${loopStatus}'`;
				break;
			}

			// Re-read issue for fresh comments using pi.exec
			let freshData: Record<string, unknown>;
			try {
				const raw = await pi.exec("gh", [
					"issue",
					"view",
					String(issueNum),
					"--repo",
					config.repo,
					"--json",
					"number,title,body,author,comments",
				]);
				freshData = JSON.parse(raw.stdout || "{}");
			} catch {
				freshData = issueData as Record<string, unknown>;
			}

			const loopFilteredData = filterIssueData(
				freshData as {
					author?: { login: string };
					body?: string;
					comments?: Array<{ author?: { login: string }; body?: string }>;
				},
				config.codeowners,
			);

			// Rejection limit check
			if (step.maxRejections !== undefined && step.maxRejections > 0) {
				const rejectionCount = countRejections(
					loopFilteredData.comments.map((c) => ({ body: c.body })),
				);
				if (rejectionCount >= step.maxRejections) {
					ctx.ui.notify(
						`Issue #${issueNum} rejected ${step.maxRejections} times. Human intervention required.`,
						"error",
					);
					stopReason = `Rejection limit reached (${step.maxRejections})`;
					break;
				}
			}

			// Load agent file using pi.exec for exists check
			const agentPath = `.pi/extensions/supervisor/agents/${agentName}.md`;
			try {
				await pi.exec("test", ["-f", agentPath], { cwd: ctx.cwd });
			} catch {
				ctx.ui.notify(`Agent file not found: ${agentPath}`, "error");
				stopReason = `Agent file not found: ${agentPath}`;
				break;
			}

			let agent;
			try {
				agent = parseAgentFile(agentPath);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to parse agent: ${msg}`, "error");
				stopReason = `Failed to parse agent: ${msg}`;
				break;
			}

			ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");

			const timeoutMs = resolveTimeoutMs(agentName, config.agentTimeoutsMin);

			// ── Worktree creation ──
			if ((agentName === "developer" || agentName === "auditor") && !worktreePath) {
				worktreeBranch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);
				worktreePath = await createWorktree(
					pi,
					ctx.cwd,
					config.worktreeBase!,
					worktreeBranch,
					config.defaultBranch!,
				);
				await installWorktreeDeps(pi, worktreePath);
			}

			const submodules = config.submodules || [];

			const summarizedRejections =
				loopFilteredData.comments.length > 1
					? summarizeComments(loopFilteredData.comments)
					: undefined;

			const task = buildAgentTask(
				agentName,
				issueNum,
				config.repo,
				issueTitle,
				loopFilteredData,
				submodules,
				config.defaultBranch!,
				config.remote!,
				config.worktreeBase!,
				config.branchPrefix!,
				worktreePath,
				worktreeBranch,
				summarizedRejections,
			);

			const agentCwd =
				agentName === "developer" || agentName === "auditor" ? worktreePath : undefined;

			let result = await runAgent(agent, task, ctx, pi, timeoutMs, agentCwd);
			validateAgentResult(result);
			let usedRetry = false;

			if (result.budgetExceeded) {
				ctx.ui.notify(`Agent ${agent.config.name} exceeded budget — not retrying`, "warning");
			} else if (!result.success) {
				ctx.ui.notify(`Agent ${agent.config.name} failed. Retrying once...`, "warning");
				result = await runAgent(agent, task, ctx, pi, timeoutMs, agentCwd);
				usedRetry = true;
				validateAgentResult(result);
			}

			const statusLabel = !result.success
				? "FAILED"
				: usedRetry
					? "SUCCESS (after retry)"
					: "SUCCESS";

			const currentAuditScore = extractAuditScore(result.textOnly);
			if (currentAuditScore) {
				auditCycleCount++;
			}

			sendAgentResultMessage(
				pi,
				{
					agentName: result.agentName,
					success: result.success,
					statusLabel,
					toolCount: result.toolCount,
					tokenCount: result.tokenCount,
					durationMs: result.durationMs,
					textOutput: result.textOutput,
					textOnly: result.textOnly,
					output: result.output,
					summaryLine: result.summaryLine,
					thinkingOutput: result.thinkingOutput,
				},
				currentAuditScore ? `${currentAuditScore.passing}/${currentAuditScore.total}` : undefined,
			);

			// ── Post issue comments deterministically ──
			if (result.success) {
				const agentOutput = result.textOutput || result.output || "";

				if (
					agentName === "architect" ||
					agentName === "test-designer" ||
					agentName === "researcher"
				) {
					const commentBody = extractAgentCommentBody(agentOutput);
					if (commentBody) {
						try {
							await postIssueComment(pi, issueNum, config.repo, commentBody);
							ctx.ui.notify(`Posted ${agentName} comment on issue #${issueNum}`, "info");
						} catch (commentErr: unknown) {
							const cmtMsg = commentErr instanceof Error ? commentErr.message : String(commentErr);
							console.warn(`[supervisor] Failed to post ${agentName} comment: ${cmtMsg}`);
						}
					}
				}

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

				if (agentName === "auditor") {
					const auditOutput = extractStructuredAuditOutput(agentOutput);
					if (auditOutput) {
						if (auditOutput.decision === "APPROVED") {
							if (auditOutput.commentBody) {
								try {
									await postIssueComment(pi, issueNum, config.repo, auditOutput.commentBody);
									ctx.ui.notify("Audit approval comment posted", "info");
								} catch (acErr: unknown) {
									const acMsg = acErr instanceof Error ? acErr.message : String(acErr);
									console.warn(`[supervisor] Failed to post audit comment: ${acMsg}`);
								}
							} else {
								const fallbackBody = buildAuditCommentFallback(
									auditOutput.decision,
									result.textOnly,
								);
								if (fallbackBody) {
									try {
										await postIssueComment(pi, issueNum, config.repo, fallbackBody);
										ctx.ui.notify("Audit approval comment posted (deterministic fallback)", "info");
									} catch (acErr: unknown) {
										const acMsg = acErr instanceof Error ? acErr.message : String(acErr);
										console.warn(`[supervisor] Failed to post approval fallback comment: ${acMsg}`);
									}
								}
							}
						} else if (auditOutput.decision === "REJECTED") {
							let commentToPost: string | null = null;
							let source = "";
							if (auditOutput.commentBody) {
								commentToPost = auditOutput.commentBody;
								source = "COMMENT_BODY marker";
							} else {
								commentToPost = buildAuditCommentFallback(auditOutput.decision, result.textOnly);
								source = "deterministic fallback";
							}
							if (commentToPost) {
								try {
									await postIssueComment(pi, issueNum, config.repo, commentToPost);
									ctx.ui.notify(`Audit rejection comment posted (${source})`, "info");
								} catch (rcErr: unknown) {
									const rcMsg = rcErr instanceof Error ? rcErr.message : String(rcErr);
									console.warn(`[supervisor] Failed to post rejection ${source} comment: ${rcMsg}`);
								}
							} else {
								console.warn(
									`[supervisor] Auditor rejected issue #${issueNum} but no COMMENT_BODY marker or structured findings found — no comment posted. ` +
										"Auditor output may lack structured findings. Update auditor agent to use COMMENT_BODY marker.",
								);
							}
						}
					}
				}
			}

			agentResults.push({
				agentName: result.agentName,
				status: statusLabel as PipelineAgentResult["status"],
				durationMs: result.durationMs,
				tokenCount: result.tokenCount,
				toolCount: result.toolCount,
				model: agent?.config?.model,
			});

			const nextStatus =
				resolveNextStatus(step, result.textOnly) ?? resolveNextStatus(step, result.textOutput);

			// ── PR creation on approval ──
			if (agentName === "auditor" && result.success && nextStatus === "Done") {
				await createPrOnApproval(
					pi,
					ctx,
					issueNum,
					issueTitle,
					config,
					agentResults,
					worktreePath,
					worktreeBranch,
				);
			}

			if (result.budgetExceeded) {
				stopReason = `Agent ${result.agentName} exceeded budget (${result.toolCount} tools, ${result.tokenCount} tokens)`;
				break;
			}

			if (!result.success && nextStatus !== "Audit") {
				ctx.ui.notify(
					`Agent ${agent.config.name} failed. Pipeline stops before ${nextStatus || "next stage"}.`,
					"warning",
				);
				stopReason = `Agent ${agent.config.name} failed`;
				break;
			}
			if (!nextStatus) {
				const unclearNote = result.errorOutput
					? `Agent ${agent.config.name} output unclear. Stderr: ${result.errorOutput.slice(0, 200)}. Pipeline stopped.`
					: `Agent ${agent.config.name} output unclear. Pipeline stopped.`;
				ctx.ui.notify(unclearNote, "warning");
				stopReason = `Agent ${agent.config.name} output unclear`;
				break;
			}

			if (step.canLoopBackTo?.includes(nextStatus)) {
				ctx.ui.notify(`Feedback loop: ${loopStatus} → ${nextStatus}`, "info");
			}

			if (currentAuditScore && nextStatus && step.canLoopBackTo?.includes(nextStatus)) {
				if (auditCycleCount === 1) {
					ctx.ui.notify(
						`Audit #${auditCycleCount} score: ${currentAuditScore.passing}/${currentAuditScore.total}`,
						"info",
					);
				} else if (lastAuditScore) {
					const diff = currentAuditScore.passing - lastAuditScore.passing;
					let arrow: string;
					if (diff > 0) {
						arrow = "↑ improving";
					} else if (diff < 0) {
						arrow = "↓ declining";
					} else {
						arrow = "→ stable";
					}
					ctx.ui.notify(
						`Audit score: ${lastAuditScore.passing}/${lastAuditScore.total} → ${currentAuditScore.passing}/${currentAuditScore.total} (${arrow})`,
						"info",
					);
				}
				lastAuditScore = currentAuditScore;
			}

			// ── Hooks (CI/TSC/LSP) ──
			let effectiveNextStatus = nextStatus;
			if (
				step.hooks?.includes("ci") ||
				step.hooks?.includes("tsc") ||
				step.hooks?.includes("lsp")
			) {
				try {
					const auditResult = await runTscAndLspAudit(
						issueNum,
						issueTitle,
						config,
						agentName,
						loopFilteredData,
						worktreePath!,
						pi,
						ctx,
					);
					effectiveNextStatus = auditResult.nextStatus;
				} catch (auditErr: unknown) {
					const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
					ctx.ui.notify(`Pre-audit error: ${msg}`, "warning");
				}
			}

			const nextOptId = findStatusOption(fields, statusField.id, effectiveNextStatus);
			if (!nextOptId) {
				ctx.ui.notify(`Cannot find '${effectiveNextStatus}' option on board.`, "warning");
				stopReason = `Cannot find '${effectiveNextStatus}' option on board.`;
				break;
			}

			try {
				await setItemStatus(pi, loopItem.id, projectId, statusField.id, nextOptId);
				ctx.ui.notify(`Issue #${issueNum} moved: ${loopStatus} → ${effectiveNextStatus}`, "info");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to update status: ${msg}`, "error");
				stopReason = `Failed to update status: ${msg}`;
				break;
			}

			loopStatus = effectiveNextStatus;
		}

		// ── Post-pipeline: merge conflict check ──
		if (loopStatus.toLowerCase() === "done" && agentResults.length > 0) {
			await handlePostPipelineMerge(issueNum, issueTitle, loopStatus, config, pi, ctx);
		}

		// ── Pipeline completion ──
		if (agentResults.length > 0 || stopReason !== undefined) {
			let overallStatus: "success" | "failed" | "stopped";
			if (loopStatus.toLowerCase() === "done") {
				overallStatus = "success";
			} else if (agentResults.some((a) => a.status === "FAILED")) {
				overallStatus = "failed";
			} else {
				overallStatus = "stopped";
			}

			sendPipelineSummary(
				pi,
				ctx,
				agentResults,
				overallStatus,
				issueNum,
				issueTitle,
				config,
				stopReason,
			);
		} else {
			ctx.ui.setStatus("supervisor", "");
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		sendPipelineError(pi, ctx, agentResults, issueNum, issueTitle, config, msg);
	}

	// ── Worktree cleanup ──
	if (worktreePath && worktreeBranch) {
		await cleanupWorktree(pi, ctx.cwd, worktreePath, worktreeBranch);
	}
}
