// ─── Pipeline Handler ────────────────────────────────────────────
// Main /supervisor command handler: status loop, transitions, hook wiring.
// Orchestrates the full pipeline by importing from submodules.
// Stage transition logic is extracted to stages.ts.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunResult,
	SupervisorConfig,
	ProjectField,
	ProjectItem,
	PipelineAgentResult,
	FilteredIssueData,
	ParsedAgent,
} from "../types.ts";
import { loadConfig, resolveTimeoutMs } from "../config.ts";
import {
	getProjectFields,
	getProjectItems,
	getProjectId,
	findIssueItem,
	getItemStatusName,
	checkBlockedByDependencies,
	filterIssueData,
} from "../github/index.ts";
import { parseAgentFile } from "../agent-loader.ts";
import { buildAgentTask, generateBranchName, summarizeComments } from "../agent-task.ts";
import { runAgent } from "../agent-runner.ts";
import { WORKFLOW } from "../workflow.ts";
import { formatDuration } from "../formatting.ts";
import { runTscAndLspAudit } from "../pipeline-audit.ts";
import { buildPipelineSummary, validateAgentResult } from "../pipeline-output.ts";
import { handlePostPipelineMerge } from "../pipeline-merge.ts";
import { createWorktree, installWorktreeDeps, cleanupWorktree } from "./worktree.ts";
import { createPrOnApproval } from "./pr-creation.ts";
import { sendPipelineSummary, sendAgentResultMessage, sendPipelineError } from "./notifications.ts";
import {
	MAX_PIPELINE_LOOPS,
	createStageState,
	type StageState,
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
} from "./stages.ts";

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

		// Fetch issue
		ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
		const issueData = await fetchIssue(pi, ctx, config, issueNum);
		if (!issueData) return;
		issueTitle = (issueData?.title as string) || `Issue #${issueNum}`;

		pi.sendMessage({
			customType: "supervisor",
			content: `## GitHub Issue: [#${issueNum}] ${issueTitle}\n\n**Repository:** \`${config.repo}\``,
			display: true,
		});

		const filteredData = filterIssueData(issueData, config.codeowners);

		// Read project board
		const { fields, items, projectId, statusField } = await readProjectBoard(
			pi,
			ctx,
			config,
			issueNum,
		);
		if (!fields || !statusField) return;
		const loopItem = findIssueItem(items, issueNum);
		if (!loopItem) {
			ctx.ui.notify(`Issue #${issueNum} not on project board #${config.projectNumber}.`, "error");
			ctx.ui.setStatus("supervisor", "");
			return;
		}

		// Dependency gate
		ctx.ui.setStatus("supervisor", "Checking dependencies...");
		if (!(await checkDependencies(pi, ctx, config, issueNum))) return;

		// Pipeline main loop
		const stageState = createStageState(getItemStatusName(loopItem));
		let { loopStatus } = stageState;

		for (let i = 0; i < MAX_PIPELINE_LOOPS; i++) {
			ctx.ui.notify(`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`, "info");

			const step = WORKFLOW.find((s) => s.status.toLowerCase() === loopStatus.toLowerCase());
			if (!step) {
				stopReason = `No workflow step for status '${loopStatus}'`;
				ctx.ui.notify(
					`No workflow step for status '${loopStatus}'. Available: ${WORKFLOW.map((s) => s.status).join(", ")}`,
					"error",
				);
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
				continue;
			}

			// Built-in: Done
			if (step.builtIn === "done") {
				ctx.ui.notify(`Issue #${issueNum} is Done. Pipeline complete.`, "info");
				break;
			}

			// Resolve agent for this status
			const agentName = resolveAgentName(loopStatus, config);
			if (!agentName) {
				stopReason = `No agent for status '${loopStatus}'`;
				ctx.ui.notify(`No agent for status '${loopStatus}'`, "error");
				break;
			}

			// Fetch fresh issue data for this iteration
			const loopFilteredData = await fetchFreshIssueData(pi, config, issueNum, issueData);

			// Rejection limit check
			if (isRejectionLimitReached(loopFilteredData.comments, step.maxRejections)) {
				stopReason = `Rejection limit reached (${step.maxRejections})`;
				ctx.ui.notify(
					`Issue #${issueNum} rejected ${step.maxRejections} times. Human intervention required.`,
					"error",
				);
				break;
			}

			// Load agent
			const agent = await loadAgentFile(pi, ctx, agentName);
			if (!agent) {
				stopReason = `Agent file not found: ${agentName}`;
				break;
			}

			ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");
			const timeoutMs = resolveTimeoutMs(agentName, config.agentTimeoutsMin!);

			// Worktree creation (once per pipeline run)
			if (isWorktreeAgent(agentName) && !worktreePath) {
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

			// Execute agent
			const { result, usedRetry } = await executeAgent(
				agent,
				task,
				ctx,
				pi,
				timeoutMs,
				isWorktreeAgent(agentName) ? worktreePath : undefined,
			);

			agentResults.push(buildAgentResultEntry(result, usedRetry));

			// Track audit score
			const auditInfo = trackAuditScore(result.textOnly, stageState);
			if (auditInfo) {
				ctx.ui.notify(
					`Audit #${auditInfo.cycleCount} score: ${auditInfo.score.passing}/${auditInfo.score.total}${auditInfo.trend ? ` (${auditInfo.trend})` : ""}`,
					"info",
				);
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
				await handlePostAgentSuccess(
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
			}

			// Determine next status
			const { status: nextStatus, stopReason: nsStop } = calculateNextStatus(
				agentName,
				result.textOutput,
				result.textOnly,
			);

			// PR creation on audit approval
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
				stopReason = `Agent ${agent.config.name} failed`;
				ctx.ui.notify(
					`Agent ${agent.config.name} failed. Pipeline stops before ${nextStatus || "next stage"}.`,
					"warning",
				);
				break;
			}

			if (!nextStatus) {
				stopReason = nsStop || `Agent ${agent.config.name} output unclear`;
				ctx.ui.notify(stopReason, "warning");
				break;
			}

			if (step.canLoopBackTo?.includes(nextStatus)) {
				ctx.ui.notify(`Feedback loop: ${loopStatus} → ${nextStatus}`, "info");
			}

			// Pre-transition hooks
			let effectiveNextStatus = nextStatus;
			if (step.hooks?.some((h) => ["ci", "tsc", "lsp"].includes(h))) {
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
					ctx.ui.notify(
						`Pre-audit error: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`,
						"warning",
					);
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
			} catch (err: unknown) {
				stopReason = `Failed to update status: ${err instanceof Error ? err.message : String(err)}`;
				ctx.ui.notify(stopReason, "error");
				break;
			}
		}

		// Post-pipeline
		if (isDoneStatus(loopStatus) && agentResults.length > 0) {
			await handlePostPipelineMerge(issueNum, issueTitle, loopStatus, config, pi, ctx);
		}

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
		} else {
			ctx.ui.setStatus("supervisor", "");
		}
	} catch (err: unknown) {
		sendPipelineError(
			pi,
			ctx,
			agentResults,
			issueNum,
			issueTitle,
			config,
			err instanceof Error ? err.message : String(err),
		);
	}

	// Worktree cleanup
	if (worktreePath && worktreeBranch) {
		await cleanupWorktree(pi, ctx.cwd, worktreePath, worktreeBranch);
	}
}

// ─── Extracted Helpers ───────────────────────────────────────────

async function fetchIssue(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: SupervisorConfig,
	issueNum: number,
): Promise<Record<string, unknown> | null> {
	try {
		return await pi
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
		return null;
	}
}

async function readProjectBoard(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: SupervisorConfig,
	issueNum: number,
): Promise<{
	fields: ProjectField[] | null;
	items: ProjectItem[];
	projectId: string;
	statusField: ProjectField | null;
}> {
	ctx.ui.setStatus("supervisor", "Reading project board...");
	try {
		const fields = await getProjectFields(pi, config.projectNumber);
		const items = await getProjectItems(pi, config.projectNumber);
		const projectId = await getProjectId(pi, config.projectNumber);

		const statusField =
			fields.find((f) => f.name.toLowerCase() === config.statusField?.toLowerCase()) || null;
		if (!statusField) {
			ctx.ui.notify(
				`Status field '${config.statusField}' not found. Fields: ${fields.map((f) => f.name).join(", ")}`,
				"error",
			);
			ctx.ui.setStatus("supervisor", "");
			return { fields: null, items: [], projectId: "", statusField: null };
		}
		return { fields, items, projectId, statusField };
	} catch (err: unknown) {
		ctx.ui.setStatus("supervisor", "");
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("missing required scopes")) {
			ctx.ui.notify(
				"GitHub token missing 'project' scope. Run: gh auth refresh -s project",
				"error",
			);
		} else {
			ctx.ui.notify(`Failed to read project board: ${msg}`, "error");
		}
		return { fields: null, items: [], projectId: "", statusField: null };
	}
}

async function checkDependencies(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: SupervisorConfig,
	issueNum: number,
): Promise<boolean> {
	try {
		const depsResult = await checkBlockedByDependencies(pi, issueNum, config.repo);
		if (depsResult.blocked) {
			const lines = depsResult.blockers.map(
				(b) => `${b.type === "pullrequest" ? "!" : "#"}${b.number}: ${b.title} (open)`,
			);
			ctx.ui.notify(
				`Issue #${issueNum} is blocked by unresolved dependencies:\n${lines.join("\n")}`,
				"error",
			);
			ctx.ui.setStatus("supervisor", "");
			return false;
		}
		return true;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`Dependency check failed: ${msg}`, "error");
		ctx.ui.setStatus("supervisor", "");
		return false;
	}
}

async function fetchFreshIssueData(
	pi: ExtensionAPI,
	config: SupervisorConfig,
	issueNum: number,
	fallbackData: Record<string, unknown>,
): Promise<FilteredIssueData> {
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
		return filterIssueData(JSON.parse(raw.stdout || "{}"), config.codeowners);
	} catch {
		return filterIssueData(fallbackData, config.codeowners);
	}
}

async function loadAgentFile(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	agentName: string,
): Promise<ParsedAgent | null> {
	const agentPath = `.pi/extensions/supervisor/agents/${agentName}.md`;
	try {
		await pi.exec("test", ["-f", agentPath], { cwd: ctx.cwd });
	} catch {
		ctx.ui.notify(`Agent file not found: ${agentPath}`, "error");
		return null;
	}
	try {
		return parseAgentFile(agentPath);
	} catch (err: unknown) {
		ctx.ui.notify(
			`Failed to parse agent: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return null;
	}
}

async function executeAgent(
	agent: ReturnType<typeof parseAgentFile>,
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	timeoutMs: number,
	agentCwd: string | undefined,
): Promise<{ result: AgentRunResult; usedRetry: boolean }> {
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

	return { result, usedRetry };
}
