// ─── Pipeline Audit ──────────────────────────────────────────────
// TSC checkpoint + LSP pre-audit + duplicate code check orchestration
// during Implementation→Audit transition. Extracted from pipeline.ts
// to keep that file under 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, DebugLogger } from "../config/types.ts";
import { resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../config/debug.ts";
import { generateBranchName } from "../agent/task.ts";
import type { ErrorCollector } from "./error-collector.ts";
import { determineTscCheckpointDecision, getRunTscCheckpoint } from "../checks/tsc-decisions.ts";
import { determineLspPreAuditDecision, getRunPreAudit } from "../checks/lsp-decisions.ts";
import { pollCiChecks } from "../checks/ci-gating.ts";
import { runDuplicateCheck } from "../checks/duplicate-code.ts";
import { runPackageSafetyAudit } from "../checks/package-safety.ts";
import { postIssueComment } from "../github/index.ts";
import { runTddGate } from "../checks/tdd-gate.ts";
import { runRequirementsTraceability } from "../checks/requirements-traceability.ts";

/**
 * Run pre-transition checks during Implementation → Audit transition.
 * Includes CI gating, duplicate code check, package safety, TDD gate,
 * requirements traceability, TSC checkpoint, and LSP pre-audit.
 * Returns the effective next status ("Audit" or "Implementation") and any note.
 */
export async function runTscAndLspAudit(
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentName: string,
	filteredData: { body?: string; comments: Array<{ body: string }> },
	worktreePath: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	collector?: ErrorCollector,
): Promise<{ nextStatus: string; note: string }> {
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	// Shared exec function for running shell commands via pi.exec
	const execFn = (cmd: string, args: string[], opts?: Record<string, unknown>) =>
		pi.exec(cmd, args, opts);

	try {
		// Step 0: CI gating — poll check runs before running local hooks
		if (config.ciGatingTimeoutSec && config.ciGatingTimeoutSec > 0) {
			ctx.ui.setStatus("supervisor", "Polling CI checks...");
			getDebugLogger().info("pipeline-audit", "Polling CI checks", {
				branch,
				timeoutSec: config.ciGatingTimeoutSec,
			});
			const ciResult = await pollCiChecks(
				pi,
				branch,
				config.repo,
				config.ciGatingTimeoutSec,
				worktreePath,
			);

			if (ciResult.status === "failing") {
				const failedNames = ciResult.checks
					.filter(
						(c) =>
							c.conclusion === "failure" ||
							c.conclusion === "cancelled" ||
							c.conclusion === "action_required" ||
							c.conclusion === "timed_out" ||
							c.conclusion === "stale",
					)
					.map((c) => c.name)
					.join(", ");
				ctx.ui.notify(
					`CI checks failing: ${failedNames}. Skipping audit — returning to Implementation.`,
					"warning",
				);
				return { nextStatus: "Implementation", note: `CI_FAILED: ${ciResult.message}` };
			}

			if (ciResult.status === "pending") {
				ctx.ui.notify(
					`CI checks still pending after ${config.ciGatingTimeoutSec}s. Proceeding to audit.`,
					"warning",
				);
			}

			if (ciResult.status === "unconfigured") {
				// No CI configured — proceed silently
				getDebugLogger().info("pipeline-audit", ciResult.message);
			}

			if (ciResult.status === "error") {
				ctx.ui.notify(
					`CI check polling issue: ${ciResult.message}. Proceeding to audit.`,
					"warning",
				);
			}
		}

		// Step 1: Duplicate code detection gate
		// Runs on full worktree and filters clones to changed files.
		// Non-blocking — duplicates found are surfaced as warning and
		// verified by the auditor agent.
		ctx.ui.setStatus("supervisor", "Checking for duplicate code...");
		getDebugLogger().info("pipeline-audit", "Running duplicate code check", { worktreePath });
		const dupResult = await runDuplicateCheck(execFn, worktreePath, config.defaultBranch || "main");

		if (dupResult.status === "duplicates_found") {
			ctx.ui.notify(
				`Duplicate code detected: ${dupResult.clones.length} clone(s) found (${dupResult.totalDuplicateLines} lines). Auditor will verify.`,
				"warning",
			);
			getDebugLogger().info("pipeline-audit", "Duplicates found", {
				cloneCount: dupResult.clones.length,
				totalLines: dupResult.totalDuplicateLines,
			});
		} else if (dupResult.status === "no_jscpd") {
			getDebugLogger().info("pipeline-audit", "jscpd not available, skipping duplicate check");
		} else if (dupResult.status === "error") {
			getDebugLogger().warn("pipeline-audit", "Duplicate check error", {
				message: dupResult.message,
			});
		}

		// Step 2: Package safety audit (non-blocking — informational)
		// Runs after duplicate code check. Checks all npm dependencies
		// in the worktree's package.json for package age safety.
		ctx.ui.setStatus("supervisor", "Checking package safety...");
		getDebugLogger().info("pipeline-audit", "Running package safety audit", { worktreePath });
		try {
			const safetyResult = await runPackageSafetyAudit(execFn, worktreePath);
			if (safetyResult.status === "blocked") {
				const blockedPkgs = safetyResult.results
					.filter((r) => r.blocked)
					.map((r) => r.packageName)
					.join(", ");
				ctx.ui.notify(
					`Package safety: ${safetyResult.results.filter((r) => r.blocked).length} blocked package(s): ${blockedPkgs}. Auditor may flag this.`,
					"warning",
				);
				getDebugLogger().info("pipeline-audit", "Package safety check found blocked packages", {
					blockedCount: safetyResult.results.filter((r) => r.blocked).length,
					results: safetyResult.results,
				});
			} else if (safetyResult.status === "error") {
				getDebugLogger().warn("pipeline-audit", "Package safety check error", {
					message: safetyResult.message,
				});
			} else {
				getDebugLogger().info("pipeline-audit", "Package safety check passed", {
					checkedCount: safetyResult.results.length,
				});
			}
		} catch (safetyErr: unknown) {
			getDebugLogger().warn("pipeline-audit", "Package safety check threw", {
				error: safetyErr instanceof Error ? safetyErr.message : String(safetyErr),
			});
		}

		// Step 3: TDD gate — deterministic test-first verification
		// Blocks transition if tests weren't written first or test-fail-first fails.
		// Runs after package safety check, before TSC/LSP.
		ctx.ui.setStatus("supervisor", "Running TDD gate...");
		getDebugLogger().info("pipeline-audit", "Running TDD gate", { worktreePath });
		try {
			const tddResult = await runTddGate(
				execFn,
				worktreePath,
				config.defaultBranch || "main",
				config.assertFunctionNames,
			);

			if (tddResult.status === "failed") {
				const failedCheckNames = tddResult.checks
					.filter((c) => !c.passed)
					.map((c) => c.name)
					.join(", ");
				const msg = `TDD gate failed: ${failedCheckNames}. ${tddResult.rejectionReason || ""}`;
				ctx.ui.notify(`TDD gate: ${msg} — returning to Implementation.`, "warning");
				getDebugLogger().info("pipeline-audit", "TDD gate failed", {
					failedChecks: failedCheckNames,
					rejectionReason: tddResult.rejectionReason,
				});
				// Post issue comment with TDD failure details for developer feedback
				try {
					const commentLines = [
						"## 🔴 TDD Gate — Implementation Rejected",
						"",
						"The deterministic TDD gate verified the changes and found issues:",
						"",
					];
					for (const check of tddResult.checks) {
						const icon = check.passed ? "✅" : "❌";
						commentLines.push(
							`${icon} **${check.name}**${check.detail ? ": " + check.detail : ""}`,
						);
					}
					commentLines.push(
						"",
						"Please write tests following the **Test First** approach: write the test, watch it fail, then write the code.",
					);
					await postIssueComment(pi, issueNum, config.repo, commentLines.join("\n"));
				} catch {
					// Comment posting is best-effort
				}
				return { nextStatus: "Implementation", note: msg };
			}

			if (tddResult.status === "error") {
				ctx.ui.notify(
					`TDD gate error: ${tddResult.rejectionReason || "unknown error"}. Proceeding to audit.`,
					"info",
				);
				getDebugLogger().warn("pipeline-audit", "TDD gate error", {
					rejectionReason: tddResult.rejectionReason,
				});
				// Non-blocking on error — proceed to audit
			} else {
				ctx.ui.notify("TDD gate passed — TDD cycle confirmed.", "info");
				getDebugLogger().info("pipeline-audit", "TDD gate passed");
			}
		} catch (tddErr: unknown) {
			const tddMsg = tddErr instanceof Error ? tddErr.message : String(tddErr);
			ctx.ui.notify(`TDD gate threw: ${tddMsg}. Proceeding to audit.`, "warning");
			getDebugLogger().warn("pipeline-audit", "TDD gate threw", { error: tddMsg });
		}

		// Step 4: Requirements traceability check (non-blocking — informational)
		// Runs deterministic checks cross-referencing issue requirements against the diff.
		// Produces structured gap list surfaced to the auditor agent.
		ctx.ui.setStatus("supervisor", "Running requirements traceability checks...");
		getDebugLogger().info("pipeline-audit", "Running requirements traceability", { worktreePath });
		try {
			const traceGaps = await runRequirementsTraceability(
				execFn,
				worktreePath,
				config.defaultBranch || "main",
				{
					body: filteredData?.body || "",
					comments: (filteredData?.comments || []).map((c: { body: string }) => ({
						author: "unknown",
						body: c.body,
					})),
				},
				issueTitle,
			);
			if (traceGaps.length > 0) {
				const gapSummary = traceGaps
					.map((g) => `[${g.severity}] ${g.check}: ${g.detail}`)
					.join("; ");
				ctx.ui.notify(
					`Requirements traceability: ${traceGaps.length} gap(s) found. Auditor will review.`,
					"info",
				);
				getDebugLogger().info("pipeline-audit", "Traceability gaps found", {
					gapCount: traceGaps.length,
					summary: gapSummary,
				});
			} else {
				getDebugLogger().info("pipeline-audit", "No traceability gaps found");
			}
		} catch (traceErr: unknown) {
			const traceMsg = traceErr instanceof Error ? traceErr.message : String(traceErr);
			ctx.ui.notify(`Requirements traceability check threw: ${traceMsg}`, "info");
			getDebugLogger().warn("pipeline-audit", "Requirements traceability threw", {
				error: traceMsg,
			});
		}

		// Step 5: TSC checkpoint (Tier 2)
		const runTscCheckpointFn = await getRunTscCheckpoint();

		if (runTscCheckpointFn) {
			ctx.ui.setStatus("supervisor", "Running TSC checkpoint...");
			getDebugLogger().info("pipeline-audit", "Running TSC checkpoint", { worktreePath });
			const tscResult = await runTscCheckpointFn(worktreePath);
			const tscDecision = determineTscCheckpointDecision(tscResult, "Audit");

			getDebugLogger().info("pipeline-audit", "TSC result", {
				nextStatus: tscDecision.nextStatus,
				note: tscDecision.note,
			});

			if (tscDecision.nextStatus !== "Audit") {
				// TSC has errors — stay in Implementation, skip LSP
				if (tscDecision.note) {
					ctx.ui.notify(tscDecision.note, "warning");
				}
				return { nextStatus: tscDecision.nextStatus, note: tscDecision.note };
			}

			// TSC clean — proceed to LSP pre-audit
			if (tscDecision.note) {
				ctx.ui.notify(tscDecision.note, "info");
			}
		}

		// Step 5: LSP pre-audit (Tier 3)
		const result = await runLspPreAudit(issueNum, issueTitle, config, pi, ctx, worktreePath);
		getDebugLogger().info("pipeline-audit", "LSP pre-audit result", {
			nextStatus: result.nextStatus,
			note: result.note,
		});
		return result;
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
	}
}

/**
 * Run LSP pre-audit diagnostics.
 * Used as fallback when TSC checkpoint is unavailable.
 */
async function runLspPreAudit(
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	worktreePath: string,
	collector?: ErrorCollector,
): Promise<{ nextStatus: string; note: string }> {
	const runPreAuditFn = await getRunPreAudit();
	let preAuditResult: any = null;

	try {
		let hasModifiedFiles = true;
		let retryCount = 0;

		if (runPreAuditFn) {
			try {
				const diffResult = await pi.exec("git", ["diff", config.defaultBranch!, "--name-only"], {
					cwd: resolvePath(worktreePath),
					timeout: 10_000,
				});
				hasModifiedFiles = (diffResult.stdout || "").trim().length > 0;
			} catch {
				collector?.push(
					"audit",
					"warn",
					`git diff failed against ${config.defaultBranch} for LSP pre-audit, assuming no modified files`,
				);
				hasModifiedFiles = false;
			}

			const entries = ctx.sessionManager.getEntries();
			retryCount = 0;
			for (const e of entries) {
				if (
					e.type === "custom" &&
					e.customType === "lsp-audit-retry" &&
					e.data &&
					typeof e.data === "object" &&
					"issueNum" in e.data &&
					(e.data as Record<string, unknown>).issueNum === issueNum
				) {
					retryCount++;
				}
			}

			if (hasModifiedFiles) {
				ctx.ui.setStatus("supervisor", "Running LSP pre-audit diagnostics...");
				preAuditResult = await runPreAuditFn(
					{
						issueNum,
						worktreePath: worktreePath,
						defaultBranch: config.defaultBranch!,
						repo: config.repo,
					},
					pi,
					ctx,
				);
			}
		}

		const decision = determineLspPreAuditDecision(
			"Audit",
			preAuditResult,
			retryCount,
			hasModifiedFiles,
		);

		if (decision.note) {
			ctx.ui.notify(decision.note, "info");
		}

		return { nextStatus: decision.nextStatus, note: decision.note };
	} finally {
		ctx.ui.setStatus("supervisor", undefined);
	}
}
