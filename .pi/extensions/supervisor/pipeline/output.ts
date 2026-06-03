// ─── Pipeline Output Helpers ─────────────────────────────────────
// Summary building, agent result validation, PR creation helpers.
// Extracted from pipeline.ts to keep that file under 300 lines.

import type { AgentRunResult, PipelineAgentResult, SupervisorConfig } from "../config/types.ts";
import { formatDuration, formatTokens } from "../config/formatting.ts";

// ─── validateAgentResult ────────────────────────────────────────────

/**
 * Sanity-check agent result: if success=true with 0 tokens and >5 tool calls,
 * the agent likely timed out or aborted before completion. Derate to failed.
 */
export function validateAgentResult(result: AgentRunResult): void {
	if (result.success && result.tokenCount === 0 && result.toolCount > 5) {
		result.success = false;
		const existingError = result.errorOutput ? result.errorOutput + "\n" : "";
		result.errorOutput = `${existingError}Sanity check failed: success=true with tokenCount=0 and toolCount=${result.toolCount}. This indicates a timeout or abort before completion.`;
	}
}

// ─── Pipeline summary builder ───────────────────────────────────────

/**
 * Build markdown summary of pipeline results.
 */
export function buildPipelineSummary(
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
