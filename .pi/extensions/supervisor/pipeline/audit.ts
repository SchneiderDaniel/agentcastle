// ─── Pipeline Audit ──────────────────────────────────────────────
// TSC checkpoint + LSP pre-audit + duplicate code check orchestration
// during Implementation→Audit transition. Extracted from pipeline.ts
// to keep that file under 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, DebugLogger } from "../config/types.ts";
import { resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../config/debug.ts";
import { generateBranchName } from "../agent/task.ts";
import { determineTscCheckpointDecision, getRunTscCheckpoint } from "../checks/tsc-decisions.ts";
import { determineLspPreAuditDecision, getRunPreAudit } from "../checks/lsp-decisions.ts";
import { pollCiChecks } from "../checks/ci-gating.ts";
import { runDuplicateCheck } from "../checks/duplicate-code.ts";

/**
 * Run TSC checkpoint, LSP pre-audit, and duplicate code check during
 * Implementation → Audit transition. Returns the effective next status
 * ("Audit" or "Implementation") and any note.
 */
export async function runTscAndLspAudit(
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentName: string,
	filteredData: { comments: Array<{ body: string }> },
	worktreePath: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<{ nextStatus: string; note: string }> {
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);

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
				pi.sendUserMessage?.(`CI failed: ${ciResult.message}. Fix and re-trigger.`, {
					deliverAs: "followUp",
				});
				return { nextStatus: "Implementation", note: `CI_FAILED: ${ciResult.message}` };
			}

			if (ciResult.status === "pending") {
				ctx.ui.notify(
					`CI checks still pending after ${config.ciGatingTimeoutSec}s. Proceeding to audit.`,
					"warning",
				);
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
		const execFn = (cmd: string, args: string[], opts?: Record<string, unknown>) =>
			pi.exec(cmd, args, opts);
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

		// Step 2: TSC checkpoint (Tier 2)
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
				// TSC has errors — stay in Implementation, send followUp, skip LSP
				if (tscDecision.note) {
					ctx.ui.notify(tscDecision.note, "warning");
					pi.sendUserMessage?.(tscDecision.note, { deliverAs: "followUp" });
				}
				return { nextStatus: tscDecision.nextStatus, note: tscDecision.note };
			}

			// TSC clean — proceed to LSP pre-audit
			if (tscDecision.note) {
				ctx.ui.notify(tscDecision.note, "info");
			}
		}

		// Step 3: LSP pre-audit (Tier 3)
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
