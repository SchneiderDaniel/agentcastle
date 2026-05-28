/**
 * tsc-checkpoint — TypeScript type-checking gate for commits and pipeline stages
 *
 * Runs npx tsc --noEmit to catch type errors before code moves forward.
 * Trigger manually with /check or automatically during Implementation→Audit
 * pipeline transitions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface TscDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error";
	message: string;
	code?: string;
}

export interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Functions (exported for unit testing)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse raw tsc --noEmit stderr output into TscDiagnostic[].
 *
 * tsc error format: file.ts(line,column): error TS<code>: message
 *
 * Handles:
 * - Multiple errors from multiple files
 * - Errors with and without TS error code
 * - Non-error lines are filtered out (info, file counts, etc.)
 * - ANSI color codes (--pretty is default) — stripped via regex
 */
export function parseTscOutput(raw: string): TscDiagnostic[] {
	if (!raw || typeof raw !== "string") return [];

	const lines = raw.split("\n");
	const diagnostics: TscDiagnostic[] = [];

	// Strip ANSI color codes first
	const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

	// Match: file(line,col): error TS<code>: message
	const errorRegex = /^([^:(]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
	// Match: file(line,col): error message (no TS code)
	const errorRegexNoCode = /^([^:(]+)\((\d+),(\d+)\):\s+error\s+(.+)$/;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Strip ANSI before matching
		const clean = stripAnsi(trimmed);

		// Try with TS code first
		let match = clean.match(errorRegex);
		if (match) {
			diagnostics.push({
				file: match[1]!,
				line: parseInt(match[2]!, 10),
				column: parseInt(match[3]!, 10),
				severity: "Error",
				message: match[5]!,
				code: match[4]!,
			});
			continue;
		}

		// Try without TS code
		match = clean.match(errorRegexNoCode);
		if (match) {
			diagnostics.push({
				file: match[1]!,
				line: parseInt(match[2]!, 10),
				column: parseInt(match[3]!, 10),
				severity: "Error",
				message: match[4]!,
			});
		}
	}

	return diagnostics;
}

/**
 * Format TSC diagnostics into developer-readable message.
 * Same format as LSP auditor: file, Line N: [Error] message (code).
 */
export function formatTscDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Group by file
	const byFile = new Map<string, TscDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		// Sort by line, then column
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

// ═══════════════════════════════════════════════════════════════════════
// Adapter: Run tsc --noEmit
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run `npx tsc --noEmit` in the worktree directory via pi.exec.
 *
 * Returns structured result with parsed diagnostics and whether any
 * errors were found.
 *
 * If tsconfig.json doesn't exist, returns { hasErrors: false } silently.
 * If tsc binary not found, returns { hasErrors: false } silently.
 */
export async function runTscCheckpoint(
	pi: ExtensionAPI,
	worktreePath: string,
): Promise<TscCheckpointResult> {
	// Check for tsconfig.json first
	const tsconfigPath = resolve(worktreePath, "tsconfig.json");
	if (!existsSync(tsconfigPath)) {
		return { diagnostics: [], hasErrors: false };
	}

	const result = await pi.exec("npx", ["tsc", "--noEmit"], {
		cwd: worktreePath,
		timeout: 60_000, // 60s for cold start
	});

	// tsc --noEmit exits 0 = success (no errors)
	if (result.code === 0) {
		return { diagnostics: [], hasErrors: false };
	}

	// Non-zero exit = type errors found. tsc outputs errors to stderr.
	const output = result.stderr || result.stdout || "";
	const diagnostics = parseTscOutput(output);
	return {
		diagnostics,
		hasErrors: diagnostics.length > 0,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register /check command for manual tsc type-check.
 */
export default function tscCheckpoint(pi: ExtensionAPI): void {
	pi.registerCommand?.("check", {
		description: "Run tsc --noEmit type-check on the current worktree (Tier 2 diagnostics)",
		handler: async (_args, ctx) => {
			const worktreePath = ctx.cwd;

			// Check if tsconfig.json exists
			if (!existsSync(resolve(worktreePath, "tsconfig.json"))) {
				pi.sendUserMessage?.(
					"## TSC Checkpoint\n\nNo `tsconfig.json` found in worktree root. Skipping type-check.",
					{ deliverAs: "followUp" },
				);
				return;
			}

			pi.sendUserMessage?.("## TSC Checkpoint\n\nRunning `tsc --noEmit`...", {
				deliverAs: "followUp",
			});

			const result = await runTscCheckpoint(pi, worktreePath);

			if (result.hasErrors) {
				const formatted = formatTscDiagnostics(result.diagnostics);
				const errorCount = result.diagnostics.length;
				pi.sendUserMessage?.(
					[
						`## TSC Checkpoint — ${errorCount} Type Error(s) Found`,
						``,
						`Please fix these errors before proceeding:`,
						``,
						formatted,
					].join("\n"),
					{ deliverAs: "followUp" },
				);
			} else {
				pi.sendUserMessage?.("## TSC Checkpoint — ✓ No type errors detected", {
					deliverAs: "followUp",
				});
			}
		},
	});
}
