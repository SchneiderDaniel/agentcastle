/**
 * LSP Auditor — Extension entry point.
 *
 * Registers the lsp-auditor command and exports the default hook.
 * Under 50 lines.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runPreAudit } from "./run-pre-audit.ts";
import { readSettings } from "./settings.ts";

/**
 * LSP Auditor extension entry point.
 *
 * The extension is passive — it's called by supervisor directly via runPreAudit().
 * No lifecycle hooks needed at this time.
 * Registers a command for manual triggering if desired.
 */
export default function lspAuditor(pi: ExtensionAPI): void {
	pi.registerCommand?.("lsp-auditor", {
		description: "Run LSP diagnostics on modified files (manual trigger)",
		handler: async (_args, ctx) => {
			const sm = ctx.sessionManager;
			const cwd = sm.getCwd();
			// Read defaultBranch from supervisor config if available
			let defaultBranch = "main";
			try {
				const settings = readSettings(cwd);
				if (settings?.supervisor && typeof settings.supervisor === "object") {
					const supCfg = settings.supervisor as Record<string, unknown>;
					if (typeof supCfg.defaultBranch === "string") {
						defaultBranch = supCfg.defaultBranch;
					}
				}
			} catch {
				/* use default */
			}
			const result = await runPreAudit(
				{ issueNum: 0, worktreePath: cwd, defaultBranch, repo: "" },
				pi,
				ctx,
			);
			pi.sendMessage?.({ content: `LSP Audit result: ${result.note}`, display: true });
		},
	});
}

// Re-export for direct integration/supervisor usage
export { runPreAudit } from "./run-pre-audit.ts";
export { auditFileGroup } from "./lsp-client.ts";
export { formatDiagnostics, filterBySeverity, mergeResults } from "./formatting.ts";
export { buildServerMappings } from "./server-mappings.ts";
export { extractModifiedFiles, groupFilesByServer } from "./file-discovery.ts";
export { countRetryAttempts, shouldRetry, MAX_RETRIES } from "./retry.ts";
export type {
	LspDiagnostic,
	ServerMapping,
	AuditResult,
	PreAuditOptions,
	PreAuditResult,
} from "./types.ts";
