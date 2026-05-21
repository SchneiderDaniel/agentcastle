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
import { resolveNextStatus, WORKFLOW } from "./workflow";
import { countRejections } from "./formatting";
import { runTscAndLspAudit } from "./pipeline-audit";
import { handlePostPipelineMerge } from "./pipeline-merge";

export function registerSupervisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("supervisor", {
		description: "Process a GitHub issue through the full Kanban pipeline",
		handler: async (args, ctx) => {
			const issueNum = parseInt(args?.trim() || "", 10);
			if (!issueNum || issueNum < 1) {
				ctx.ui.notify("Usage: /supervisor <issue-number>", "error");
				return;
			}

			try {
				const config = loadConfig();

				// Initial fetch
				ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
				let issueData: any;
				try {
					issueData = ghJson([
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

				const issueTitle: string = issueData?.title || `Issue #${issueNum}`;

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
					fields = getProjectFields(config.projectNumber);
					items = getProjectItems(config.projectNumber);
					projectId = getProjectId(config.projectNumber);
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
					const depsResult = await checkBlockedByDependencies(issueNum, config.repo);
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
						break;
					}

					// ── Built-in: Backlog ──
					if (step.builtIn === "backlog") {
						const optId = findStatusOption(fields, statusField.id, "Architecture");
						if (!optId) {
							ctx.ui.notify("Cannot find 'Architecture' status option", "error");
							break;
						}
						setItemStatus(loopItem.id, projectId, statusField.id, optId);
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
						break;
					}

					// Re-read issue for fresh comments
					let freshData: any;
					try {
						freshData = ghJson([
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
							break;
						}
					}

					// Load agent
					const agentPath = `.pi/agents/${agentName}.md`;
					if (!existsSync(agentPath)) {
						ctx.ui.notify(`Agent file not found: ${agentPath}`, "error");
						break;
					}

					let agent;
					try {
						agent = parseAgentFile(agentPath);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to parse agent: ${msg}`, "error");
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
						} satisfies SupervisorMessageDetails,
					});

					// Resolve next status from agent output markers (config-driven)
					const nextStatus = resolveNextStatus(step, result.textOnly);

					if (!result.success && nextStatus !== "Audit") {
						ctx.ui.notify(
							`Agent ${agent.config.name} failed. Pipeline stops before ${nextStatus || "next stage"}.`,
							"warning",
						);
						break;
					}
					if (!nextStatus) {
						const unclearNote = result.errorOutput
							? `Agent ${agent.config.name} output unclear. Stderr: ${result.errorOutput.slice(0, 200)}. Pipeline stopped.`
							: `Agent ${agent.config.name} output unclear. Pipeline stopped.`;
						ctx.ui.notify(unclearNote, "warning");
						break;
					}

					// Feedback loop notification
					if (step.canLoopBackTo?.includes(nextStatus)) {
						ctx.ui.notify(`Feedback loop: ${loopStatus} → ${nextStatus}`, "info");
					}

					// ── Hooks (TSC/LSP) — triggered when step defines hooks ──
					let effectiveNextStatus = nextStatus;
					if (step.hooks?.includes("tsc") || step.hooks?.includes("lsp")) {
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
							ctx.ui.notify(`TSC/LSP pre-audit error: ${msg}`, "warning");
						}
					}

					const nextOptId = findStatusOption(fields, statusField.id, effectiveNextStatus);
					if (!nextOptId) {
						ctx.ui.notify(`Cannot find '${effectiveNextStatus}' option on board.`, "warning");
						break;
					}

					try {
						setItemStatus(loopItem.id, projectId, statusField.id, nextOptId);
						ctx.ui.notify(
							`Issue #${issueNum} moved: ${loopStatus} → ${effectiveNextStatus}`,
							"info",
						);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to update status: ${msg}`, "error");
						break;
					}

					loopStatus = effectiveNextStatus;
				}

				// ── Post-pipeline: check for PR merge conflicts ──
				if (loopStatus.toLowerCase() === "done") {
					await handlePostPipelineMerge(issueNum, issueTitle, loopStatus, config, pi, ctx);
				}

				ctx.ui.setStatus("supervisor", "");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Supervisor error: ${msg}`, "error");
				ctx.ui.setStatus("supervisor", "");
			}
		},
	});
}
