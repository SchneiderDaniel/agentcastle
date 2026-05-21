// ─── Pipeline Audit ──────────────────────────────────────────────
// TSC checkpoint + LSP pre-audit orchestration during Implementation→Audit
// transition. Extracted from pipeline.ts to keep that file under 300 lines.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "./types";
import { resolve as resolvePath } from "node:path";
import { generateBranchName } from "./agent-task";
import { determineTscCheckpointDecision, getRunTscCheckpoint } from "./tsc-decisions";
import { determineLspPreAuditDecision, getRunPreAudit } from "./lsp-decisions";

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
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<{ nextStatus: string; note: string }> {
	const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);
	const wt = `${config.worktreeBase!}${branch}`;

	// Step 1: TSC checkpoint (Tier 2)
	const runTscCheckpointFn = await getRunTscCheckpoint();

	if (runTscCheckpointFn) {
		ctx.ui.setStatus("supervisor", "Running TSC checkpoint...");
		const tscResult = await runTscCheckpointFn(pi, wt);
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
	return runLspPreAudit(issueNum, issueTitle, config, pi, ctx, branch, wt);
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
	branch: string,
	wt: string,
): Promise<{ nextStatus: string; note: string }> {
	const runPreAuditFn = await getRunPreAudit();
	let preAuditResult: any = null;
	let hasModifiedFiles = true;
	let retryCount = 0;

	if (runPreAuditFn) {
		try {
			const diffResult = await pi.exec("git", ["diff", config.defaultBranch!, "--name-only"], {
				cwd: resolvePath(wt),
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
