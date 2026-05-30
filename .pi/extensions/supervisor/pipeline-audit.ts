// ─── Pipeline Audit ──────────────────────────────────────────────
// TSC checkpoint + LSP pre-audit orchestration during Implementation→Audit
// transition. Extracted from pipeline.ts to keep that file under 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "./types";
import { resolve as resolvePath } from "node:path";
import { generateBranchName } from "./agent-task";
import { determineTscCheckpointDecision, getRunTscCheckpoint } from "./tsc-decisions";
import { determineLspPreAuditDecision, getRunPreAudit } from "./lsp-decisions";
import { pollCiChecks } from "./ci-gating";

/**
 * Run TSC checkpoint and LSP pre-audit during Implementation → Audit transition.
 * Returns the effective next status ("Audit" or "Implementation") and any note.
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

	// Step 0: CI gating — poll check runs before running local hooks
	if (config.ciGatingTimeoutSec && config.ciGatingTimeoutSec > 0) {
		ctx.ui.setStatus("supervisor", "Polling CI checks...");
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
			ctx.ui.notify(`CI check polling issue: ${ciResult.message}. Proceeding to audit.`, "warning");
		}
	}

	// Step 1: TSC checkpoint (Tier 2)
	// Run against worktree path so type-checking covers feature branch code,
	// not main branch. worktreePath is resolved and passed from pipeline.ts.
	// npm ci is run on worktree creation so node_modules are available.
	const runTscCheckpointFn = await getRunTscCheckpoint();

	if (runTscCheckpointFn) {
		ctx.ui.setStatus("supervisor", "Running TSC checkpoint...");
		const tscResult = await runTscCheckpointFn(pi, worktreePath);
		const tscDecision = determineTscCheckpointDecision(tscResult, "Audit");

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

	// Step 2: LSP pre-audit (Tier 3)
	return runLspPreAudit(issueNum, issueTitle, config, pi, ctx, worktreePath);
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
}
