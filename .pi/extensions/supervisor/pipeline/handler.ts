// ─── Pipeline Handler ────────────────────────────────────────────
// Main /supervisor command handler: status loop, transitions, hook wiring.
// Orchestrates the full pipeline by importing from submodules.
// Stage transition logic is extracted to stages.ts.
// Helpers are in helpers.ts with injected ExecFn/NotifyFn dependencies.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunResult,
	SupervisorConfig,
	PipelineAgentResult,
	ParsedAgent,
	DebugLogger,
} from "../types.ts";
import { loadConfig, resolveTimeoutMs } from "../config.ts";
import { findIssueItem, getItemStatusName, filterIssueData } from "../github/index.ts";
import { buildAgentTask, generateBranchName, summarizeComments } from "../agent-task.ts";
import { runAgent, runAgentSubprocess } from "../agent-runner.ts";
import { WORKFLOW } from "../workflow.ts";
import { runTscAndLspAudit } from "../pipeline-audit.ts";
import { buildPipelineSummary, validateAgentResult } from "../pipeline-output.ts";
import { handlePostPipelineMerge } from "../pipeline-merge.ts";
import { createWorktree, installWorktreeDeps, cleanupWorktree } from "./worktree.ts";
import { createPrOnApproval } from "./pr-creation.ts";
import { sendPipelineSummary, sendAgentResultMessage, sendPipelineError } from "./notifications.ts";
import {
	MAX_PIPELINE_LOOPS,
	createStageState,
	handleBacklogTransition,
	isDoneStatus,
	resolveAgentName,
	isWorktreeAgent,
	isRejectionLimitReached,
	calculateNextStatus,
	trackAuditScore,
	applyStatusTransition,
	buildAgentResultEntry,
	handlePostAgentSuccess,
	shouldSkipResearcher,
	checkReadmeUpdated,
	inferForwardStatus,
} from "./stages.ts";
import {
	fetchIssue,
	readProjectBoard,
	checkDependencies,
	fetchFreshIssueData,
	loadAgentFile as loadAgentFileHelper,
} from "./helpers.ts";
import type { ExecFn, NotifyFn } from "./helpers.ts";
import {
	parseSupervisorArgs,
	enableDebugLogger,
	getDebugLogger,
	setDebugLogger,
	resetDebugLogger,
} from "../debug.ts";

/**
 * Main supervisor handler — processes a GitHub issue through the full Kanban pipeline.
 * Supports --debug flag for structured JSONL logging to /tmp/.
 */
export async function handleSupervisorCommand(
	args: string | undefined,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
): Promise<void> {
	// Parse args: "--debug 103", "103 --debug", "103"
	const parsed = parseSupervisorArgs(args);
	const issueNum = parsed.issueNum;
	const isDebug = parsed.isDebug;

	// Setup debug logger if --debug flag present
	if (isDebug) {
		const logger = enableDebugLogger(ctx.cwd || process.cwd());
		logger.info("handler", "Supervisor pipeline started with --debug", {
			args,
			parsedIssueNum: issueNum,
			cwd: ctx.cwd,
		});
		ctx.ui.notify(`Debug logging enabled → ${logger.getLogPath()}`, "info");
	}

	if (!issueNum || issueNum < 1) {
		ctx.ui.notify("Usage: /supervisor [--debug] <issue-number>", "error");
		if (isDebug) {
			getDebugLogger().error("handler", "Invalid issue number", { args, parsed });
		}
		resetDebugLogger();
		return;
	}

	// Clear any stale supervisor status from previous pipeline runs
	ctx.ui.setStatus("supervisor", undefined);

	const agentResults: PipelineAgentResult[] = [];
	let stopReason: string | undefined;
	let config!: SupervisorConfig;
	let issueTitle = "";
	let worktreePath: string | undefined;
	let worktreeBranch: string | undefined;

	// Build ExecFn and NotifyFn from pi/ctx for helpers
	const exec: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, opts);
	const notify: NotifyFn = {
		info: (msg) => ctx.ui.notify(msg, "info"),
		error: (msg) => ctx.ui.notify(msg, "error"),
		setStatus: (status) => ctx.ui.setStatus("supervisor", status),
	};

	try {
		config = loadConfig();
		getDebugLogger().info("handler", "Config loaded", {
			repo: config.repo,
			projectNumber: config.projectNumber,
			submodules: config.submodules?.length,
		});

		// Fetch issue
		ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
		const issueData = await fetchIssue(exec, notify, config, issueNum);
		if (!issueData) return;
		issueTitle = (issueData?.title as string) || `Issue #${issueNum}`;

		pi.sendMessage({
			customType: "supervisor",
			content: `## GitHub Issue: [#${issueNum}] ${issueTitle}\n\n**Repository:** \`${config.repo}\``,
			display: true,
		});

		getDebugLogger().info("handler", "Issue fetched", {
			issueNum,
			title: issueTitle,
			repo: config.repo,
		});

		const filteredData = filterIssueData(issueData, config.codeowners);

		// Read project board
		ctx.ui.setStatus("supervisor", "Reading project board...");
		const { fields, items, projectId, statusField } = await readProjectBoard(
			exec,
			notify,
			config,
			issueNum,
		);
		if (!fields || !statusField) {
			getDebugLogger().error("handler", "Project board read failed", {
				hasFields: !!fields,
				hasStatusField: !!statusField,
			});
			return;
		}
		const loopItem = findIssueItem(items, issueNum);
		if (!loopItem) {
			ctx.ui.notify(`Issue #${issueNum} not on project board #${config.projectNumber}.`, "error");
			getDebugLogger().error("handler", "Issue not on project board", {
				issueNum,
				projectNumber: config.projectNumber,
			});
			ctx.ui.setStatus("supervisor", undefined);
			return;
		}

		getDebugLogger().info("handler", "Project board read OK", {
			itemId: loopItem.id,
			status: getItemStatusName(loopItem),
		});

		// Dependency gate
		ctx.ui.setStatus("supervisor", "Checking dependencies...");
		if (!(await checkDependencies(exec, notify, config, issueNum))) {
			getDebugLogger().warn("handler", "Dependency check blocked", { issueNum });
			return;
		}

		// Pipeline main loop
		const stageState = createStageState(getItemStatusName(loopItem));
		let { loopStatus } = stageState;

		for (let i = 0; i < MAX_PIPELINE_LOOPS; i++) {
			ctx.ui.notify(`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`, "info");
			getDebugLogger().info("handler", `Pipeline iteration ${i + 1}`, {
				loopStatus,
				iteration: i,
			});

			const step = WORKFLOW.find((s) => s.status.toLowerCase() === loopStatus.toLowerCase());
			if (!step) {
				stopReason = `No workflow step for status '${loopStatus}'`;
				ctx.ui.notify(
					`No workflow step for status '${loopStatus}'. Available: ${WORKFLOW.map((s) => s.status).join(", ")}`,
					"error",
				);
				getDebugLogger().error("handler", "No workflow step", { loopStatus });
				break;
			}

			// Built-in: Backlog → Architecture
			if (step.builtIn === "backlog") {
				loopStatus = await handleBacklogTransition(
					pi,
					fields,
					statusField.id,
					loopItem.id,
					projectId,
				);
				ctx.ui.notify(`Issue #${issueNum} moved: Backlog → Architecture`, "info");
				getDebugLogger().info("handler", "Backlog → Architecture");
				continue;
			}

			// Built-in: Done
			if (step.builtIn === "done") {
				ctx.ui.notify(`Issue #${issueNum} is Done. Pipeline complete.`, "info");
				getDebugLogger().info("handler", "Pipeline complete — Done status");
				break;
			}

			// Resolve agent for this status
			const agentName = resolveAgentName(loopStatus, config);
			if (!agentName) {
				stopReason = `No agent for status '${loopStatus}'`;
				ctx.ui.notify(`No agent for status '${loopStatus}'`, "error");
				getDebugLogger().error("handler", "No agent for status", { loopStatus });
				break;
			}

			// Fetch fresh issue data for this iteration
			const loopFilteredData = await fetchFreshIssueData(exec, config, issueNum, issueData);

			// Rejection limit check
			if (isRejectionLimitReached(loopFilteredData.comments, step.maxRejections)) {
				stopReason = `Rejection limit reached (${step.maxRejections})`;
				ctx.ui.notify(
					`Issue #${issueNum} rejected ${step.maxRejections} times. Human intervention required.`,
					"error",
				);
				getDebugLogger().warn("handler", "Rejection limit reached", {
					maxRejections: step.maxRejections,
				});
				break;
			}

			// Deduplication gate: skip researcher if findings already exist
			if (agentName === "researcher" && shouldSkipResearcher(loopStatus, loopFilteredData)) {
				ctx.ui.notify(
					`Issue #${issueNum} already has research findings — skipping researcher`,
					"info",
				);
				getDebugLogger().info("handler", "Skipping researcher — findings exist");
				// Find the next forward status for the researcher step
				const nextStatus = inferForwardStatus(step);
				if (nextStatus) {
					loopStatus = await applyStatusTransition(
						pi,
						loopItem.id,
						projectId,
						fields,
						statusField.id,
						nextStatus,
					);
					ctx.ui.notify(
						`Issue #${issueNum} moved: Research → ${nextStatus} (deduplication gate)`,
						"info",
					);
					getDebugLogger().info("handler", `Research → ${nextStatus} (dedup gate)`);
					continue;
				}
			}

			// Load agent
			const agent = await loadAgentFileHelper(exec, notify, ctx.cwd, agentName);
			if (!agent) {
				stopReason = `Agent file not found: ${agentName}`;
				getDebugLogger().error("handler", "Agent file not found", { agentName });
				break;
			}

			ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");
			const timeoutMs = resolveTimeoutMs(agentName, config.agentTimeoutsMin!);

			// Worktree creation (once per pipeline run)
			if (isWorktreeAgent(agentName) && !worktreePath) {
				worktreeBranch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);
				getDebugLogger().info("handler", "Creating worktree", {
					branch: worktreeBranch,
					base: config.worktreeBase,
				});
				worktreePath = await createWorktree(
					pi,
					ctx.cwd,
					config.worktreeBase!,
					worktreeBranch,
					config.defaultBranch!,
				);
				await installWorktreeDeps(pi, worktreePath);
				getDebugLogger().info("handler", "Worktree ready", { worktreePath });
			}

			// Build task
			const task = buildAgentTask(
				agentName,
				issueNum,
				config.repo,
				issueTitle,
				loopFilteredData,
				config.submodules || [],
				config.defaultBranch!,
				config.remote!,
				config.worktreeBase!,
				config.branchPrefix!,
				worktreePath,
				worktreeBranch,
				loopFilteredData.comments.length > 1
					? summarizeComments(loopFilteredData.comments)
					: undefined,
			);

			getDebugLogger().info("handler", `Dispatching agent ${agentName}`, {
				model: agent.config.model,
				timeoutMs,
				taskLen: task.length,
				cwdOverride: isWorktreeAgent(agentName) ? worktreePath : undefined,
			});

			// Execute agent
			const { result, usedRetry } = await executeAgent(
				agent,
				task,
				ctx,
				pi,
				timeoutMs,
				isWorktreeAgent(agentName) ? worktreePath : undefined,
				config.maxToolCalls,
				config.agentTokenBudget,
			);

			getDebugLogger().info("handler", `Agent ${agentName} completed`, {
				success: result.success,
				usedRetry,
				durationMs: result.durationMs,
				toolCount: result.toolCount,
				tokenCount: result.tokenCount,
				budgetExceeded: result.budgetExceeded,
				summary: result.summaryLine?.slice(0, 200),
			});

			agentResults.push(buildAgentResultEntry(result, usedRetry, agent.config.model));

			// Track audit score
			const auditInfo = trackAuditScore(result.textOnly, stageState);
			if (auditInfo) {
				ctx.ui.notify(
					`Audit #${auditInfo.cycleCount} score: ${auditInfo.score.passing}/${auditInfo.score.total}${auditInfo.trend ? ` (${auditInfo.trend})` : ""}`,
					"info",
				);
				getDebugLogger().info("handler", "Audit score tracked", {
					cycleCount: auditInfo.cycleCount,
					score: auditInfo.score,
					trend: auditInfo.trend,
				});
			}

			// Send result to UI
			sendAgentResultMessage(
				pi,
				{
					agentName: result.agentName,
					success: result.success,
					statusLabel: !result.success ? "FAILED" : usedRetry ? "SUCCESS (after retry)" : "SUCCESS",
					toolCount: result.toolCount,
					tokenCount: result.tokenCount,
					durationMs: result.durationMs,
					textOutput: result.textOutput,
					textOnly: result.textOnly,
					output: result.output,
					summaryLine: result.summaryLine,
					thinkingOutput: result.thinkingOutput,
				},
				auditInfo ? `${auditInfo.score.passing}/${auditInfo.score.total}` : undefined,
			);

			// Post-processing
			if (result.success) {
				const continuePipeline = await handlePostAgentSuccess(
					pi,
					ctx,
					result,
					agentName,
					issueNum,
					config,
					loopFilteredData,
					worktreePath,
					worktreeBranch,
					issueTitle,
				);
				if (!continuePipeline) {
					stopReason = `commitAndPush failed for ${agentName}`;
					getDebugLogger().error("handler", "commitAndPush failed", { agentName });
					break;
				}
			}

			// Determine next status
			const { status: nextStatus, stopReason: nsStop } = calculateNextStatus(
				agentName,
				result.textOutput,
				result.textOnly,
			);

			getDebugLogger().info("handler", "Next status determined", {
				nextStatus,
				stopReason: nsStop,
			});

			// PR creation on audit approval
			if (agentName === "auditor" && result.success && nextStatus === "Done") {
				getDebugLogger().info("handler", "Creating PR on approval");
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
				getDebugLogger().warn("handler", "Budget exceeded", {
					agentName: result.agentName,
					toolCount: result.toolCount,
					tokenCount: result.tokenCount,
				});
				break;
			}

			if (!result.success && nextStatus !== "Audit") {
				stopReason = `Agent ${agent.config.name} failed`;
				ctx.ui.notify(
					`Agent ${agent.config.name} failed. Pipeline stops before ${nextStatus || "next stage"}.`,
					"warning",
				);
				getDebugLogger().error("handler", "Agent failed, pipeline stopping", {
					agentName: agent.config.name,
					nextStatus,
				});
				break;
			}

			if (!nextStatus) {
				stopReason = nsStop || `Agent ${agent.config.name} output unclear`;
				ctx.ui.notify(stopReason, "warning");
				getDebugLogger().warn("handler", "No next status from agent output", {
					agentName: agent.config.name,
					stopReason,
				});
				break;
			}

			if (step.canLoopBackTo?.includes(nextStatus)) {
				ctx.ui.notify(`Feedback loop: ${loopStatus} → ${nextStatus}`, "info");
				getDebugLogger().info("handler", "Feedback loop", { from: loopStatus, to: nextStatus });
			}

			// Pre-transition hooks
			let effectiveNextStatus = nextStatus;
			if (step.hooks?.some((h) => ["ci", "tsc", "lsp"].includes(h))) {
				try {
					getDebugLogger().info("handler", "Running pre-transition hooks", {
						hooks: step.hooks,
					});
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
					getDebugLogger().info("handler", "Pre-transition hook result", {
						effectiveNextStatus,
						note: auditResult.note,
					});
				} catch (auditErr: unknown) {
					ctx.ui.notify(
						`Pre-audit error: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
						"warning",
					);
					getDebugLogger().error("handler", "Pre-transition hook error", {
						error: auditErr instanceof Error ? auditErr.message : String(auditErr),
					});
				}
			}

			// Status transition
			try {
				const prev = loopStatus;
				loopStatus = await applyStatusTransition(
					pi,
					loopItem.id,
					projectId,
					fields,
					statusField.id,
					effectiveNextStatus,
				);
				ctx.ui.notify(`Issue #${issueNum} moved: ${prev} → ${loopStatus}`, "info");
				getDebugLogger().info("handler", "Status transition applied", {
					from: prev,
					to: loopStatus,
				});
			} catch (err: unknown) {
				stopReason = `Failed to update status: ${err instanceof Error ? err.message : String(err)}`;
				ctx.ui.notify(stopReason, "error");
				getDebugLogger().error("handler", "Status transition failed", {
					error: err instanceof Error ? err.message : String(err),
				});
				break;
			}
		}

		// Post-pipeline operations with correct ordering:
		// 1. Merge resolution (needs worktree to exist)
		// 2. Worktree cleanup (after merge is complete)
		await handlePostPipeline(
			issueNum,
			issueTitle,
			loopStatus,
			agentResults,
			config,
			pi,
			ctx,
			worktreePath,
			worktreeBranch,
		);

		// Completion notification
		if (agentResults.length > 0 || stopReason !== undefined) {
			const overallStatus: "success" | "failed" | "stopped" = isDoneStatus(loopStatus)
				? "success"
				: agentResults.some((a) => a.status === "FAILED")
					? "failed"
					: "stopped";
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
			getDebugLogger().info("handler", "Pipeline finished", {
				overallStatus,
				agentCount: agentResults.length,
				stopReason,
				totalDurationMs: agentResults.reduce((s, a) => s + a.durationMs, 0),
			});
		} else {
			ctx.ui.setStatus("supervisor", undefined);
		}
	} catch (err: unknown) {
		const errMsg = err instanceof Error ? err.message : String(err);
		getDebugLogger().error("handler", "Pipeline threw unhandled error", { error: errMsg });
		// Also cleanup on error
		if (worktreePath && worktreeBranch) {
			await cleanupWorktree(pi, ctx.cwd, worktreePath, worktreeBranch);
		}
		sendPipelineError(pi, ctx, agentResults, issueNum, issueTitle, config, errMsg);
	} finally {
		if (isDebug) {
			const logPath = getDebugLogger().getLogPath();
			ctx.ui.notify(`Debug log: ${logPath}`, "info");
			resetDebugLogger();
		}
	}
}

// ─── Post-Pipeline Operations ──────────────────────────────────────
// Extracted for testability — runs merge before cleanup.
// Order: merge (needs worktree) → cleanup (deletes worktree).
// In try/finally so cleanup always runs even if merge throws.

export async function handlePostPipeline(
	issueNum: number,
	issueTitle: string,
	loopStatus: string,
	agentResults: PipelineAgentResult[],
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
): Promise<void> {
	try {
		// Step 1: Post-pipeline merge resolution — needs worktree to exist
		if (isDoneStatus(loopStatus) && agentResults.length > 0) {
			await handlePostPipelineMerge(issueNum, issueTitle, loopStatus, config, pi, ctx);
		}
	} finally {
		// Step 2: Worktree cleanup — always runs, even if merge throws
		if (worktreePath && worktreeBranch) {
			await cleanupWorktree(pi, ctx.cwd, worktreePath, worktreeBranch);
		}
	}
}

// ─── Execute Agent (kept local — tightly coupled to runAgent) ────

async function executeAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	timeoutMs: number,
	agentCwd: string | undefined,
	maxToolCalls?: number,
	agentTokenBudget?: number,
): Promise<{ result: AgentRunResult; usedRetry: boolean }> {
	let result = await runAgent(
		agent,
		task,
		ctx,
		pi,
		timeoutMs,
		agentCwd,
		maxToolCalls,
		agentTokenBudget,
	);
	validateAgentResult(result);
	let usedRetry = false;

	if (result.budgetExceeded) {
		ctx.ui.notify(`Agent ${agent.config.name} exceeded budget — not retrying`, "warning");
	} else if (!result.success) {
		ctx.ui.notify(`Agent ${agent.config.name} failed. Retrying once...`, "warning");
		// Skip in-process path on retry — already failed. Go straight to subprocess.
		result = await runAgentSubprocess(
			agent,
			task,
			ctx,
			timeoutMs,
			agentCwd,
			maxToolCalls,
			agentTokenBudget,
		);
		usedRetry = true;
		validateAgentResult(result);
	}

	return { result, usedRetry };
}
