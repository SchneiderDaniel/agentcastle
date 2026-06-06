// ─── TSC Checkpoint Decision ────────────────────────────────────────
// Decide next transition status based on tsc checkpoint result.
// Pure function — no Pi API, no process spawning.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TscDiagnostic } from "../../tsc-checkpoint/index.ts";
import { formatTscDiagnostics } from "../../tsc-checkpoint/index.ts";

/**
 * Result from a tsc checkpoint run.
 */
export interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
}

/**
 * Decision output for the pipeline.
 */
export interface TscCheckpointDecision {
	nextStatus: string;
	note: string;
	tscTriggered: boolean;
}

/**
 * Decide the next pipeline status based on tsc checkpoint result.
 *
 * - If intendedNext !== "Audit" → pass through (no-op)
 * - If result is null (not triggered) → proceed to Audit with skip note
 * - If hasErrors → stay in Implementation with diagnostic details
 * - If clean → proceed to Audit with success note
 */
export function determineTscCheckpointDecision(
	result: TscCheckpointResult | null,
	intendedNext: string,
): TscCheckpointDecision {
	if (intendedNext !== "Audit") {
		return { nextStatus: intendedNext, note: "", tscTriggered: false };
	}

	if (!result) {
		return {
			nextStatus: "Audit",
			note: "TSC checkpoint skipped",
			tscTriggered: false,
		};
	}

	if (result.hasErrors) {
		const formatted = formatTscDiagnostics(result.diagnostics);
		return {
			nextStatus: "Implementation",
			note: `TSC checkpoint: ${result.diagnostics.length} type error(s) found — fix before proceeding.\n${formatted}`,
			tscTriggered: true,
		};
	}

	return {
		nextStatus: "Audit",
		note: "TSC checkpoint: ✓ no type errors detected",
		tscTriggered: true,
	};
}

/**
 * Direct import for runTscCheckpoint (hard dependency).
 * Throws if the tsc-checkpoint module is not available.
 */
export async function getRunTscCheckpoint(): Promise<
	(worktreePath: string) => Promise<TscCheckpointResult>
> {
	const mod = await import("../../tsc-checkpoint");
	return mod.runTscCheckpoint;
}
