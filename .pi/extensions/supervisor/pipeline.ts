// ─── Pipeline ──────────────────────────────────────────────────────
// The /supervisor command handler: status loop, transitions, LSP hook wiring,
// post-pipeline merge conflict resolution.
//
// Loop is config-driven — reads WORKFLOW config to determine transitions,
// hooks, and rejection limits. No hardcoded agent-specific branching.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type {
	AgentRunResult,
	SupervisorConfig,
	ProjectField,
	ProjectItem,
	SupervisorMessageDetails,
	PipelineAgentResult,
} from "./types";
import { existsSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
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
	postIssueComment,
	commitAndPush,
	createPullRequest,
	extractAgentCommentBody,
	extractStructuredAuditOutput,
} from "./github";
import { parseAgentFile } from "./agent-loader";
import { buildAgentTask, generateBranchName } from "./agent-task";
import { runAgent } from "./agent-runner";
import { resolveNextStatus, extractAuditScore, type AuditScore, WORKFLOW } from "./workflow";
import { countRejections, formatDuration, formatTokens } from "./formatting";
import { runTscAndLspAudit } from "./pipeline-audit";
import { buildPipelineSummary, validateAgentResult } from "./pipeline-output";
import { handlePostPipelineMerge } from "./pipeline-merge";

// ─── Async exec with AbortSignal (Bug 1 fix) ─────────────────────

const execAsync = promisify(exec);

async function execWithSignal(
	command: string,
	options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
	const controller = new AbortController();
	const timer =
		options.timeout && options.timeout > 0
			? setTimeout(
					() =>
						controller.abort(
							new Error(`Command timed out after ${options.timeout}ms: ${command.slice(0, 120)}`),
						),
					options.timeout,
				)
			: undefined;
	try {
		const result = await execAsync(command, {
			cwd: options.cwd,
			signal: controller.signal,
			env: process.env as Record<string, string>,
		});
		return { stdout: result.stdout || "", stderr: result.stderr || "" };
	} finally {
		if (timer) clearTimeout(timer);
	}
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
			let worktreePath: string | undefined;
			let worktreeBranch: string | undefined;

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
					const agentPath = `.pi/extensions/supervisor/agents/${agentName}.md`;
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

					// Load agent config for name display (needed before task build)
					ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");

					const timeoutMs = resolveTimeoutMs(agentName, config.agentTimeoutsMin);

					// ── Supervisor-owned worktree lifecycle ──
					// Create worktree BEFORE building agent task so task text can embed
					// the worktree path and branch name. Agent cwd is set to worktree path
					// so tools (write/edit/read/bash) naturally target the isolated worktree,
					// not the main checkout.
					if ((agentName === "developer" || agentName === "auditor") && !worktreePath) {
						worktreeBranch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);
						const wt = resolvePath(ctx.cwd, config.worktreeBase!, worktreeBranch);
						try {
							await execWithSignal(
								`git worktree add -b "${worktreeBranch}" "${wt}" "${config.defaultBranch!}"`,
								{ cwd: ctx.cwd, timeout: 15000 },
							);
						} catch {
							// Branch or worktree may already exist — try add without -b
							try {
								await execWithSignal(`git worktree add "${wt}" "${worktreeBranch}"`, {
									cwd: ctx.cwd,
									timeout: 15000,
								});
							} catch {
								// Worktree already exists — idempotent, just use it
							}
						}
						worktreePath = wt;
						// Install deps in worktree so TSC can resolve imports
						try {
							await execWithSignal(`npm ci`, {
								cwd: worktreePath,
								timeout: 120_000,
							});
						} catch {
							// npm ci failure is non-fatal — worktree still usable,
							// TSC will skip if tsconfig.json not found or deps missing
						}
					}

					// Build task AFTER worktree creation so worktreePath + branch info
					// can be embedded in the task text (fixes auditor checking main checkout).
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
						// Pass worktree path + branch name for auditor/developer task embedding
						worktreePath,
						worktreeBranch,
					);

					// Pass worktree path as cwd so agent tools resolve against isolated worktree
					const agentCwd =
						agentName === "developer" || agentName === "auditor" ? worktreePath : undefined;

					let result = await runAgent(agent, task, ctx, pi, timeoutMs, agentCwd);
					// Validate agent result — derate if success=true with 0 tokens and >5 tools (Bug C)
					validateAgentResult(result);
					let usedRetry = false;

					if (!result.success) {
						ctx.ui.notify(`Agent ${agent.config.name} failed. Retrying once...`, "warning");
						result = await runAgent(agent, task, ctx, pi, timeoutMs, agentCwd);
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

					// ── Phase 2: Post issue comments deterministically ──
					// Pipeline posts the comment instead of the agent running gh CLI.
					// Note: gates on result.success only, NOT !usedRetry — retry-success
					// should still post output (fixes #299).
					if (result.success) {
						const agentOutput = result.textOutput || result.output || "";

						// Phase 2: Post COMMENT_BODY for architect/test-designer/researcher
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
									const cmtMsg =
										commentErr instanceof Error ? commentErr.message : String(commentErr);
									console.warn(`[supervisor] Failed to post ${agentName} comment: ${cmtMsg}`);
								}
							}
						}

						// Phase 4: Commit and push after developer agent succeeds
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

						// Phase 3: Process structured auditor output
						if (agentName === "auditor") {
							const auditOutput = extractStructuredAuditOutput(agentOutput);
							if (auditOutput) {
								if (auditOutput.decision === "APPROVED") {
									// Post approval comment (PR creation handled after nextStatus resolution)
									if (auditOutput.commentBody) {
										try {
											await postIssueComment(pi, issueNum, config.repo, auditOutput.commentBody);
											ctx.ui.notify("Audit approval comment posted", "info");
										} catch (acErr: unknown) {
											const acMsg = acErr instanceof Error ? acErr.message : String(acErr);
											console.warn(`[supervisor] Failed to post audit comment: ${acMsg}`);
										}
									}
								} else if (auditOutput.decision === "REJECTED") {
									// Post rejection comment
									if (auditOutput.commentBody) {
										try {
											await postIssueComment(pi, issueNum, config.repo, auditOutput.commentBody);
											ctx.ui.notify("Audit rejection comment posted", "info");
										} catch (rcErr: unknown) {
											const rcMsg = rcErr instanceof Error ? rcErr.message : String(rcErr);
											console.warn(`[supervisor] Failed to post rejection comment: ${rcMsg}`);
										}
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

					// Resolve next status from agent output markers (config-driven).
					// Check both textOnly and textOutput in case marker straddles
					// a text_delta boundary. Do NOT fall back to result.output (raw
					// message history) — that includes the task template text which
					// contains both AUDIT_APPROVED and AUDIT_REJECTED, causing
					// lastIndexOf to pick the wrong marker (Issue #281).
					const nextStatus =
						resolveNextStatus(step, result.textOnly) ?? resolveNextStatus(step, result.textOutput);

					// ── PR creation: when auditor approves and transitions to Done ──
					// Decoupled from auditOutput marker parsing — triggers reliably on workflow transition.
					if (agentName === "auditor" && result.success && nextStatus === "Done") {
						const headBranch =
							worktreeBranch ?? generateBranchName(issueNum, issueTitle, config.branchPrefix!);

						// Check branch has commits ahead of base before creating PR
						let aheadCommits = 0;
						try {
							const aheadResult = await execWithSignal(
								`git rev-list --count "${config.defaultBranch!}..${headBranch}"`,
								{ cwd: ctx.cwd, timeout: 5000 },
							);
							const ahead = aheadResult.stdout.trim();
							aheadCommits = parseInt(ahead, 10) || 0;
						} catch {
							// Branch may not exist locally — can't create PR
						}

						if (aheadCommits === 0) {
							ctx.ui.notify(
								`No new commits on ${headBranch} — skipping PR creation (already up to date with ${config.defaultBranch!})`,
								"info",
							);
						} else {
							// Generate PR body from pipeline summary — always works, no marker dependency
							const prBody = buildPipelineSummary(
								agentResults,
								"success",
								issueNum,
								issueTitle,
								config,
							);
							const tempFile = joinPath(tmpdir(), `pr-body-${issueNum}.md`);
							try {
								writeFileSync(tempFile, prBody, "utf-8");
								const prTitle = `feat(#${issueNum}): ${issueTitle}`;

								// Push branch before creating PR so remote ref exists
								if (worktreePath) {
									try {
										await execWithSignal(`git push "${config.remote!}" "${headBranch}"`, {
											cwd: worktreePath,
											timeout: 15000,
										});
									} catch {
										// Branch may already be pushed — non-fatal
									}
								}

								const prResult = await createPullRequest(
									pi,
									config.repo,
									config.defaultBranch!,
									headBranch,
									prTitle,
									tempFile,
								);
								ctx.ui.notify(`PR #${prResult.number} created`, "info");
							} catch (prErr: unknown) {
								const prMsg = prErr instanceof Error ? prErr.message : String(prErr);
								ctx.ui.notify(`Failed to create PR: ${prMsg}`, "warning");
								console.warn(`[supervisor] createPullRequest failed: ${prMsg}`);
							}
						}
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

			// ── Supervisor-owned worktree cleanup ──
			// Remove worktree after pipeline completes (success, failure, or stop).
			// Uses --force in case agent left uncommitted changes.
			if (worktreePath) {
				try {
					await execWithSignal(
						`git worktree remove --force "${worktreePath}" 2>/dev/null; ` +
							`git worktree prune 2>/dev/null`,
						{ cwd: ctx.cwd, timeout: 15000 },
					);
				} catch {
					console.warn(`[supervisor] Failed to remove worktree at ${worktreePath}`);
				}
				if (worktreeBranch) {
					try {
						await execWithSignal(`git branch -D "${worktreeBranch}"`, {
							cwd: ctx.cwd,
							timeout: 10000,
						});
					} catch {
						console.warn(`[supervisor] Failed to delete branch ${worktreeBranch}`);
					}
				}
			}
		},
	});
}
