// ─── Pipeline Hooks ──────────────────────────────────────────────
// CI/TSC/LSP pre-transition checks. Wraps pipeline-audit.ts.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig } from "../types";
import { runTscAndLspAudit } from "../pipeline-audit";

/**
 * Run hook checks (CI, TSC, LSP) before a status transition.
 * Returns the effective next status and any note.
 */
export async function runPreTransitionHooks(
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentName: string,
	filteredData: { comments: Array<{ body: string }> },
	worktreePath: string,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<{ nextStatus: string; note: string }> {
	return await runTscAndLspAudit(
		issueNum,
		issueTitle,
		config,
		agentName,
		filteredData,
		worktreePath,
		pi,
		ctx,
	);
}
