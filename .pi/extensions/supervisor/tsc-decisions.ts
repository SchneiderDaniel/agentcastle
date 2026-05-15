// ─── TSC Checkpoint Decision ────────────────────────────────────────
// Decide next transition status based on tsc checkpoint result.
// Pure function — no Pi API, no process spawning.

/**
 * Result from a tsc checkpoint run.
 */
export interface TscCheckpointResult {
	diagnostics: Array<{
		file: string;
		line: number;
		column: number;
		severity: "Error";
		message: string;
		code?: string;
	}>;
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

// Reuse formatTscDiagnostics inline for pure-function isolation
function formatTscDiagnostics(
	diagnostics: Array<{
		file: string;
		line: number;
		column: number;
		severity: "Error";
		message: string;
		code?: string;
	}>,
): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, typeof diagnostics>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		diags.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const codePart = d.code ? ` (${d.code})` : "";
			lines.push(`${file}, Line ${d.line}: [${d.severity}] ${msg}${codePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
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
 * Lazy import for runTscCheckpoint to avoid circular dependencies at load time.
 */
let _runTscCheckpoint: ((worktreePath: string) => TscCheckpointResult) | null = null;

export async function getRunTscCheckpoint(): Promise<
	((worktreePath: string) => TscCheckpointResult) | null
> {
	if (_runTscCheckpoint) return _runTscCheckpoint;
	try {
		const mod = await import("../tsc-checkpoint");
		_runTscCheckpoint = mod.runTscCheckpoint;
		return _runTscCheckpoint;
	} catch {
		return null;
	}
}
