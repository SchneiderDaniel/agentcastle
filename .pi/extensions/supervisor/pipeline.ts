// ─── Pipeline ──────────────────────────────────────────────────────
// The /supervisor command handler: status loop, transitions, LSP hook wiring,
// post-pipeline merge conflict resolution.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	SupervisorConfig,
	ProjectField,
	ProjectItem,
	SupervisorMessageDetails,
} from "./types";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
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
	checkPrConflicts,
	filterIssueData,
} from "./github";
import { parseAgentFile } from "./agent-loader";
import { buildAgentTask, generateBranchName } from "./agent-task";
import { runAgent } from "./agent-runner";
import { determineNextStatus } from "./status-transitions";
import { tryAutoMerge } from "./merge";
import { determineLspPreAuditDecision, getRunPreAudit } from "./lsp-decisions";
import { countRejections } from "./formatting";

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
				} catch (err: any) {
					const msg = err.message || String(err);
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
				} catch (err: any) {
					ctx.ui.notify(`Dependency check failed: ${err.message}`, "error");
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				// ── Pipeline loop ──
				let loopStatus = getItemStatusName(loopItem);
				const MAX_LOOPS = 20;

				for (let i = 0; i < MAX_LOOPS; i++) {
					ctx.ui.notify(`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`, "info");

					// BACKLOG → advance to Architecture
					if (loopStatus.toLowerCase() === "backlog") {
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

					// DONE → complete
					if (loopStatus.toLowerCase() === "done") {
						ctx.ui.notify(`Issue #${issueNum} is Done. Pipeline complete.`, "info");
						break;
					}

					// Map status to agent
					const agentName = config.statusMapping[loopStatus];
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

					// Rejection limit check
					if (agentName === "auditor") {
						const rejectionCount = countRejections(
							loopFilteredData.comments.map((c) => ({ body: c.body })),
						);
						if (rejectionCount >= (config.maxRejections || 3)) {
							ctx.ui.notify(
								`Issue #${issueNum} rejected ${config.maxRejections} times. Human intervention required.`,
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
					} catch (err: any) {
						ctx.ui.notify(`Failed to parse agent: ${err.message}`, "error");
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

					let result = await runAgent(agent, task, ctx, timeoutMs);
					let usedRetry = false;

					if (!result.success) {
						ctx.ui.notify(`Agent ${agent.config.name} failed. Retrying once...`, "warning");
						result = await runAgent(agent, task, ctx, timeoutMs);
						usedRetry = true;
					}

					const statusLabel = !result.success
						? "FAILED"
						: usedRetry
							? "SUCCESS (after retry)"
							: "SUCCESS";

					pi.sendMessage({
						customType: "supervisor",
						content: `## Agent: ${result.agentName} — ${statusLabel}\n\n${result.textOutput || result.summaryLine}`,
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
						} satisfies SupervisorMessageDetails,
					});

					const nextStatus = determineNextStatus(agentName, result.textOnly);

					if (!result.success && nextStatus !== "Audit") {
						ctx.ui.notify(
							`Agent ${agent.config.name} failed. Pipeline stops before ${nextStatus || "next stage"}.`,
							"warning",
						);
						break;
					}
					if (!nextStatus) {
						const unclearNote = result.errorOutput
							? `Agent ${agent.config.name} output unclear (stderr: ${result.errorOutput.slice(0, 200)}). Pipeline stopped.`
							: `Agent ${agent.config.name} output unclear. Pipeline stopped.`;
						ctx.ui.notify(unclearNote, "warning");
						break;
					}

					// ── LSP Pre-Audit Hook (Implementation → Audit only) ──
					let effectiveNextStatus = nextStatus;
					if (nextStatus === "Audit") {
						try {
							const runPreAuditFn = await getRunPreAudit();
							let preAuditResult: any = null;
							let hasModifiedFiles = true;
							let retryCount = 0;

							if (runPreAuditFn) {
								const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);
								const wt = `${config.worktreeBase!}${branch}`;
								try {
									const diffOut = execFileSync(
										"git",
										["diff", config.defaultBranch!, "--name-only"],
										{
											cwd: resolvePath(wt),
											encoding: "utf-8",
											timeout: 10_000,
										},
									).trim();
									hasModifiedFiles = diffOut.length > 0;
								} catch {
									hasModifiedFiles = false;
								}

								const entries = ctx.sessionManager.getEntries();
								retryCount = 0;
								for (const e of entries) {
									if (
										e.type === "custom" &&
										e.customType === "lsp-audit-retry" &&
										(e.data as any)?.issueNum === issueNum
									) {
										retryCount++;
									}
								}

								if (hasModifiedFiles) {
									ctx.ui.setStatus("supervisor", "Running LSP pre-audit diagnostics...");
									preAuditResult = await runPreAuditFn(
										{
											issueNum,
											worktreePath: wt,
											defaultBranch: config.defaultBranch!,
											repo: config.repo,
										},
										pi,
										ctx,
									);
								}
							}

							const decision = determineLspPreAuditDecision(
								nextStatus,
								preAuditResult,
								retryCount,
								hasModifiedFiles,
							);

							effectiveNextStatus = decision.nextStatus;
							if (decision.note) {
								ctx.ui.notify(decision.note, "info");
							}
						} catch (auditErr: any) {
							ctx.ui.notify(`LSP pre-audit error: ${auditErr.message}`, "warning");
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
					} catch (err: any) {
						ctx.ui.notify(`Failed to update status: ${err.message}`, "error");
						break;
					}

					loopStatus = effectiveNextStatus;
				}

				// ── Post-pipeline: check for PR merge conflicts ──
				if (loopStatus.toLowerCase() === "done") {
					const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

					ctx.ui.setStatus("supervisor", "Checking PR for merge conflicts...");
					const conflictInfo = await checkPrConflicts(branch, config.repo);

					if (conflictInfo && conflictInfo.hasConflict) {
						ctx.ui.notify(
							`PR #${conflictInfo.number} has merge conflicts! (mergeable: ${conflictInfo.mergeable}, state: ${conflictInfo.mergeStateStatus})`,
							"warning",
						);

						const shouldFix = await ctx.ui.confirm(
							"Merge Conflict Detected",
							`PR #${conflictInfo.number} (${branch}) has merge conflicts with ${conflictInfo.baseRefName}. Should I fix them?`,
						);

						if (shouldFix) {
							const wt = `${config.worktreeBase}${branch}`;

							ctx.ui.setStatus("supervisor", "Attempting auto-merge...");
							const mergeResult = tryAutoMerge(wt, branch, config.defaultBranch!, config.remote!);

							if (mergeResult.success) {
								try {
									execFileSync("git", ["push", config.remote!, branch], {
										cwd: wt,
										encoding: "utf-8",
										timeout: 30_000,
									});
									ctx.ui.notify("Merge conflicts resolved and pushed!", "info");
									pi.sendMessage({
										customType: "supervisor",
										content: `## ✅ Merge Conflicts Resolved\n\nPR #${conflictInfo.number} conflicts were resolved automatically and pushed.`,
										display: true,
									});
								} catch (pushErr: any) {
									ctx.ui.notify(`Merge succeeded but push failed: ${pushErr.message}`, "error");
								}
							} else {
								ctx.ui.notify(
									`Auto-merge failed: ${mergeResult.message}. Dispatching developer to resolve...`,
									"warning",
								);

								const devAgentPath = `.pi/agents/developer.md`;
								if (existsSync(devAgentPath)) {
									try {
										const devAgent = parseAgentFile(devAgentPath);
										const devTask = [
											`## Task: Resolve Merge Conflicts`,
											``,
											`**Branch:** ${branch}`,
											`**Worktree:** ${wt}`,
											`**Base branch:** ${config.defaultBranch}`,
											`**Conflicted files:** ${mergeResult.conflictFiles.join(", ") || "(unknown)"}`,
											``,
											`### Steps`,
											`1. Enter worktree: \`cd ${wt}\``,
											`2. Fetch base: \`git fetch ${config.remote} ${config.defaultBranch}\``,
											`3. Merge base: \`git merge ${config.remote}/${config.defaultBranch}\``,
											`4. Resolve conflicts in the conflicted files`,
											`5. Stage resolved files: \`git add -A\``,
											`6. Commit merge: \`git commit -m "fix: resolve merge conflicts for PR #${conflictInfo.number}"\``,
											`7. Push: \`git push ${config.remote} ${branch}\``,
											``,
											`When done, output CONFLICTS_RESOLVED on its own line.`,
										].join("\n");

										const devTimeoutMs = resolveTimeoutMs("developer", config.agentTimeoutsMin);
										const devResult = await runAgent(devAgent, devTask, ctx, devTimeoutMs);

										pi.sendMessage({
											customType: "supervisor",
											content: `## Conflict Resolution: ${devResult.agentName} — ${devResult.success ? "SUCCESS" : "FAILED"}\n\n${devResult.textOutput || devResult.summaryLine}`,
											display: true,
											details: {
												agentName: devResult.agentName,
												success: devResult.success,
												statusLabel: devResult.success ? "SUCCESS" : "FAILED",
												toolCount: devResult.toolCount,
												tokenCount: devResult.tokenCount,
												durationMs: devResult.durationMs,
												textOutput: devResult.textOutput,
												summaryLine: devResult.summaryLine,
												thinkingOutput: devResult.thinkingOutput,
												hasThinking: !!devResult.thinkingOutput,
											},
										});

										if (devResult.success) {
											ctx.ui.notify("Developer resolved merge conflicts successfully!", "info");
										} else {
											ctx.ui.notify(
												"Developer failed to resolve conflicts. Manual intervention required.",
												"error",
											);
										}
									} catch (devErr: any) {
										ctx.ui.notify(`Failed to dispatch developer: ${devErr.message}`, "error");
									}
								} else {
									ctx.ui.notify(
										"Developer agent not found. Cannot resolve conflicts automatically.",
										"error",
									);
								}
							}
						}
					} else if (conflictInfo) {
						ctx.ui.notify(
							`PR #${conflictInfo.number} has no merge conflicts (mergeable: ${conflictInfo.mergeable}).`,
							"info",
						);
					} else {
						ctx.ui.notify("No PR found for this branch — skipping conflict check.", "info");
					}
				}

				ctx.ui.setStatus("supervisor", "");
			} catch (err: any) {
				ctx.ui.notify(`Supervisor error: ${err.message}`, "error");
				ctx.ui.setStatus("supervisor", "");
			}
		},
	});
}
