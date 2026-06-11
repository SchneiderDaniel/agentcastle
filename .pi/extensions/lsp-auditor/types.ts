/**
 * LSP Auditor Type Definitions
 *
 * Pure data types and port interfaces. No imports from Node, Pi, or vscode-jsonrpc.
 * Dependency Rule inward — this module is imported by all other lsp-auditor modules.
 */

// ─── LSP Diagnostic Types ────────────────────────────────────────────

export interface LspDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning" | "Information" | "Hint";
	message: string;
}

export interface ServerMapping {
	extensions: string[];
	command: string;
	args: string[];
	severityThreshold: "error" | "warning" | "info";
}

export interface AuditResult {
	diagnostics: LspDiagnostic[];
	errors: string[];
	note: string;
}

// ─── Pre-Audit Types ─────────────────────────────────────────────────

export interface PreAuditOptions {
	issueNum: number;
	worktreePath: string;
	defaultBranch: string;
	repo: string;
}

export interface PreAuditResult {
	proceed: boolean;
	note: string;
}

// ─── Output Adaptation Types ──────────────────────────────────────────

/**
 * Structured diagnostic data for RPC/JSON mode output.
 * Provides a machine-parseable shape with files grouped by path.
 */
export interface StructuredDiagnostics {
	files: Array<{
		path: string;
		issues: Array<{
			line: number;
			col: number;
			severity: string;
			message: string;
		}>;
	}>;
}
