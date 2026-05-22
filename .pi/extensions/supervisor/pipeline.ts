// ─── Pipeline ──────────────────────────────────────────────────────
// The /supervisor command handler: status loop, transitions, LSP hook wiring,
// post-pipeline merge conflict resolution.
//
// Loop is config-driven — reads WORKFLOW config to determine transitions,
// hooks, and rejection limits. No hardcoded agent-specific branching.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	ProjectField,
	ProjectItem,
	SupervisorMessageDetails,
	PipelineAgentResult,
} from "./types";
import { existsSync } from "node:fs";
import { loadConfig, resolveTimeoutMs } from "./config";
import {
	ghJson,
	getProjectFields,
	getProjectItems,
	getProjectId,
	findIssueItem,
	getItemStatusName,
	findStatusOption,
	setItemStatus,
	checkBlockedByDependencies,
	filterIssueData,
} from "./github";
import { parseAgentFile } from "./agent-loader";
import { buildAgentTask } from "./agent-task";
import { runAgent } from "./agent-runner";
import { resolveNextStatus, extractAuditScore, type AuditScore, WORKFLOW } from "./workflow";
import { countRejections, formatDuration, formatTokens } from "./formatting";
import { runTscAndLspAudit } from "./pipeline-audit";
import { handlePostPipelineMerge } from "./pipeline-merge";

// ─── Pipeline summary builder ───────────────────────────────────────

function buildPipelineSummary(
	agentResults: PipelineAgentResult[],
	overallStatus: "success" | "failed" | "stopped",
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	stopReason?: string,
): string {
	const lines: string[] = [];

	// Header
	const headerEmoji = overallStatus === "success" ? "✅" : overallStatus === "failed" ? "❌" : "⏹";
	const headerText =
		overallStatus === "success"
			? "Pipeline Complete"
			: overallStatus === "failed"
				? "Pipeline Failed"
				: "Pipeline Stopped";
	lines.push(`## ${headerEmoji} ${headerText} — Issue #${issueNum}`);
	lines.push("");

	// Helper to extract short model name (after slash)
	const shortModel = (m?: string) => (m ? m.split("/").pop() || m : "—");

	// Agent table
	lines.push("| Agent | Status | Duration | Tokens | Tools | Model |");
	lines.push("|-------|--------|----------|--------|-------|-------|");
	if (agentResults.length > 0) {
		for (const ar of agentResults) {
			const statusIcon = ar.status === "FAILED" ? "✗" : "✓";
			lines.push(
				`| ${ar.agentName} | ${statusIcon} ${ar.status} | ${formatDuration(ar.durationMs)} | ${formatTokens(ar.tokenCount)} | ${ar.toolCount} | ${shortModel(ar.model)} |`,
			);
		}
	} else {
		lines.push("| (none) | — | — | — | — | — |");
	}
	lines.push("");

	// Total stats
	const totalTokens = agentResults.reduce((sum, a) => sum + a.tokenCount, 0);
	const totalDurationMs = agentResults.reduce((sum, a) => sum + a.durationMs, 0);
	const totalToolCalls = agentResults.reduce((sum, a) => sum + a.toolCount, 0);
	lines.push(
		`**Total:** ${agentResults.length} agents · ${formatDuration(totalDurationMs)} · ${formatTokens(totalTokens)} tokens · ${totalToolCalls} tool calls`,
	);

	// Issue link
	lines.push(`**Issue:** https://github.com/${config.repo}/issues/${issueNum}`);

	// Stop reason for stopped pipelines
	if (overallStatus === "stopped" && stopReason) {
		lines.push("");
		lines.push(`**Stopped at:** ${stopReason}`);
	}

	// Failure info
	if (overallStatus === "failed") {
		const failedAgent = [...agentResults].reverse().find((a) => a.status === "FAILED");
		if (failedAgent) {
			lines.push("");
			lines.push(`**Stopped at:** ${failedAgent.agentName} — agent failed`);
		}
		lines.push("**Manual intervention required.**");
	}

	return lines.join("\n");
}

export function registerSupervisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("supervisor", {
		description: "Process a GitHub issue through the full Kanban pipeline",
		handler: async (args, ctx) => {
			const issueNum = parseInt(args?.trim() || "", 10);
			if (!issueNum || issueNum < 1) {
				ctx.ui.notify("Usage: /supervisor <issue-number>", "error");
				return;
			}

			const agentResults: PipelineAgentResult[] = [];
			let stopReason: string | undefined;
			let config!: SupervisorConfig;
			let issueTitle = "";

			try {
				config = loadConfig();

				// Initial fetch
				ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
				let issueData: any;
				try {
					issueData = await ghJson(pi, [
						"issue",
						"view",
						String(issueNum),
						"--repo",
						config.repo,
						"--json",
						"number,title,body,author,comments",
					]);
				} catch {
					ctx.ui.notify(`Issue #${issueNum} not found in ${config.repo}`, "error");
					return;
				}

				issueTitle = issueData?.title || `Issue #${issueNum}`;

				// Print issue header
				pi.sendMessage({
					customType: "supervisor",
					content: `## GitHub Issue: [#${issueNum}] ${issueTitle}\n\n**Repository:** \`${config.repo}\``,
					display: true,
				});

				// Code-level security: filter issue body + comments to trusted codeowners only
				const filteredData = filterIssueData(issueData, config.codeowners);

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
					ctx.ui.notify(
						`Issue #${issueNum} not on project board #${config.projectNumber}.`,
						"error",
					);
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

					// Look up workflow step for current status
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

					// Resolve agent name: prefer step.agentName, fallback to config.statusMapping
					const agentName = step.agentName || config.statusMapping[loopStatus];
					if (!agentName) {
						const mapped = Object.keys(config.statusMapping).join(", ");
						ctx.ui.notify(`No agent for status '${loopStatus}'. Mapped: ${mapped}`, "error");
						stopReason = `No agent for status '${loopStatus}'`;
						break;
					}

					// Re-read issue for fresh comments
					let freshData: any;
					try {
						freshData = await ghJson(pi, [
							"issue",
							"view",
							String(issueNum),
							"--repo",
							config.repo,
							"--json",
							"number,title,body,author,comments",
						]);
					} catch {
						freshData = issueData;
					}

					// Code-level security: filter issue body + comments to trusted codeowners only
					const loopFilteredData = filterIssueData(freshData, config.codeowners);

					// Rejection limit check (if step defines maxRejections)
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

					// Load agent
					const agentPath = `.pi/agents/${agentName}.md`;
					if (!existsSync(agentPath)) {
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

					// Build task and run
					const submodules = config.submodules || [];
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
					);
					ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");

					const timeoutMs = resolveTimeoutMs(agentName, config.agentTimeoutsMin);

					let result = await runAgent(agent, task, ctx, pi, timeoutMs);
					let usedRetry = false;

					if (!result.success) {
						ctx.ui.notify(`Agent ${agent.config.name} failed. Retrying once...`, "warning");
						result = await runAgent(agent, task, ctx, pi, timeoutMs);
						usedRetry = true;
					}

					const statusLabel = !result.success
						? "FAILED"
						: usedRetry
							? "SUCCESS (after retry)"
							: "SUCCESS";

					// Extract audit score for confidence tracking
					const currentAuditScore = extractAuditScore(result.textOnly);
					if (currentAuditScore) {
						auditCycleCount++;
					}

					pi.sendMessage({
						customType: "supervisor",
						content: `## Agent: ${result.agentName} — ${statusLabel}\n\n${result.summaryLine}`,
						// Full output stored in details — excluded from LLM context, rendered by message-renderer
						display: true,
						details: {
							agentName: result.agentName,
							success: result.success,
							statusLabel,
							toolCount: result.toolCount,
							tokenCount: result.tokenCount,
							durationMs: result.durationMs,
							textOutput: result.textOutput,
							summaryLine: result.summaryLine,
							thinkingOutput: result.thinkingOutput,
							hasThinking: !!result.thinkingOutput,
							rawOutput: result.output,
							hasRawOutput: true,
							auditScore: currentAuditScore
								? `${currentAuditScore.passing}/${currentAuditScore.total}`
								: undefined,
						} satisfies SupervisorMessageDetails,
					});

					agentResults.push({
						agentName: result.agentName,
						status: statusLabel as PipelineAgentResult["status"],
						durationMs: result.durationMs,
						tokenCount: result.tokenCount,
						toolCount: result.toolCount,
						model: agent?.config?.model,
					});

					// Resolve next status from agent output markers (config-driven)
					// Check all output sources: textOnly may miss marker if it was consumed
					// from liveText by newline splitting in text_delta and not picked up
					// by text_end (empty liveText) or message_end (missing msg.content).
					// Fall back to textOutput (fullLog) and output (raw messages).
					const nextStatus =
						resolveNextStatus(step, result.textOnly) ??
						resolveNextStatus(step, result.textOutput) ??
						resolveNextStatus(step, result.output);

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

					// Feedback loop notification
					if (step.canLoopBackTo?.includes(nextStatus)) {
						ctx.ui.notify(`Feedback loop: ${loopStatus} → ${nextStatus}`, "info");
					}

					// ── Audit score trend notification ──
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

					// ── Hooks (CI/TSC/LSP) — triggered when step defines hooks ──
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
						ctx.ui.notify(
							`Issue #${issueNum} moved: ${loopStatus} → ${effectiveNextStatus}`,
							"info",
						);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to update status: ${msg}`, "error");
						stopReason = `Failed to update status: ${msg}`;
						break;
					}

					loopStatus = effectiveNextStatus;
				}

				// ── Post-pipeline: check for PR merge conflicts ──
				if (loopStatus.toLowerCase() === "done" && agentResults.length > 0) {
					await handlePostPipelineMerge(issueNum, issueTitle, loopStatus, config, pi, ctx);
				}

				// ── Pipeline completion signal ──
				if (agentResults.length > 0 || stopReason !== undefined) {
					let overallStatus: "success" | "failed" | "stopped";
					if (loopStatus.toLowerCase() === "done") {
						overallStatus = "success";
					} else if (agentResults.some((a) => a.status === "FAILED")) {
						overallStatus = "failed";
					} else {
						overallStatus = "stopped";
					}

					const summaryMarkdown = buildPipelineSummary(
						agentResults,
						overallStatus,
						issueNum,
						issueTitle,
						config,
						overallStatus === "stopped" ? stopReason : undefined,
					);

					pi.sendMessage({
						customType: "supervisor-summary",
						content: summaryMarkdown,
						display: true,
					});

					ctx.ui.notify("Pipeline complete.", "info");

					// Status bar with result
					if (overallStatus === "success") {
						const totalDurationMs = agentResults.reduce((sum, a) => sum + a.durationMs, 0);
						ctx.ui.setStatus(
							"supervisor",
							ctx.ui.theme.fg(
								"success",
								`✅ Done · ${agentResults.length} agents · ${formatDuration(totalDurationMs)}`,
							),
						);
					} else if (overallStatus === "failed") {
						const lastFailed = [...agentResults].reverse().find((a) => a.status === "FAILED");
						ctx.ui.setStatus(
							"supervisor",
							ctx.ui.theme.fg(
								"error",
								`❌ Failed at ${lastFailed?.agentName || "unknown"} · ${agentResults.length} agents`,
							),
						);
					} else {
						ctx.ui.setStatus(
							"supervisor",
							ctx.ui.theme.fg("warning", `⏹ Stopped: ${stopReason || "unknown reason"}`),
						);
					}

					// Optional terminal bell
					if (config.bellOnComplete) {
						process.stdout.write("\x07");
					}
				} else {
					ctx.ui.setStatus("supervisor", "");
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Supervisor error: ${msg}`, "error");

				// Build summary from partial results if available
				if (agentResults.length > 0) {
					const overallStatus: "failed" = "failed";
					const summaryMarkdown = buildPipelineSummary(
						agentResults,
						overallStatus,
						issueNum,
						issueTitle,
						config,
					);

					pi.sendMessage({
						customType: "supervisor-summary",
						content: summaryMarkdown,
						display: true,
					});

					const lastFailed = [...agentResults].reverse().find((a) => a.status === "FAILED");
					ctx.ui.setStatus(
						"supervisor",
						ctx.ui.theme.fg(
							"error",
							`❌ Failed at ${lastFailed?.agentName || "unknown"} · ${agentResults.length} agents`,
						),
					);

					if (config?.bellOnComplete) {
						process.stdout.write("\x07");
					}
				} else {
					ctx.ui.setStatus("supervisor", "");
				}
			}
		},
	});
}
