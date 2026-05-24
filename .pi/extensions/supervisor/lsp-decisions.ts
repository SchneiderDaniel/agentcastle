// ─── LSP Pre-Audit Hook ────────────────────────────────────────────
// Decide next transition status based on LSP pre-audit result.

import type { LspPreAuditDecision } from "./types";

/**
 * Decide the next transition status based on LSP pre-audit result.
 * Pure function — does not call Pi API or spawn processes.
 */
export function determineLspPreAuditDecision(
	intendedNext: string,
	preAuditResult: { proceed: boolean; note: string } | null,
	retryCount: number,
	hasModifiedFiles: boolean,
): LspPreAuditDecision {
	if (intendedNext !== "Audit") {
		return { nextStatus: intendedNext, note: "", auditTriggered: false };
	}
	if (!hasModifiedFiles) {
		return {
			nextStatus: "Audit",
			note: "LSP audit skipped: no modified files",
			auditTriggered: false,
		};
	}
	if (!preAuditResult) {
		return { nextStatus: "Audit", note: "", auditTriggered: false };
	}
	if (preAuditResult.proceed) {
		return { nextStatus: "Audit", note: preAuditResult.note, auditTriggered: true };
	}
	const n =
		typeof retryCount !== "number" || Number.isNaN(retryCount) || retryCount < 0 ? 0 : retryCount;
	if (n >= 3) {
		return { nextStatus: "Audit", note: preAuditResult.note, auditTriggered: true };
	}
	return { nextStatus: "Implementation", note: preAuditResult.note, auditTriggered: true };
}

// Dynamically import runPreAudit (lazy to avoid issues at load time)
let _runPreAudit: any = null;

export async function getRunPreAudit(): Promise<any> {
	if (_runPreAudit) return _runPreAudit;
	try {
		const mod = await import("../lsp-auditor");
		_runPreAudit = mod.runPreAudit;
		return _runPreAudit;
	} catch {
		return null;
	}
}
