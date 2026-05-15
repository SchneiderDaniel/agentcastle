/**
 * Structural Analyzer — ast-grep integration for syntax-aware code search
 *
 * Registers a `structural_search` tool that runs ast-grep (`sg` or `ast-grep`)
 * with a structural pattern, parses NDJSON output, and returns a structured
 * list of file paths, line ranges, and truncated snippets.
 *
 * This is the Relational Layer — if Ctags provides the nodes in your graph,
 * ast-grep provides the edges. The agent uses this to answer "Where is
 * `verify_token` called, and what is passed to it?"
 *
 * Design:
 * - Single flat file with clear sequential phases: validate → exec → parse → return
 * - Pure validate/parse/truncate functions are exported for unit testing
 * - ast-grep invoked via pi.exec() — no Python wrapper needed
 * - Collision rule: generic single-word patterns are rejected, forcing agent
 *   to use ripgrep for text search
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/** Raw sg JSONL output line (only fields we care about). */
export interface SgTag {
	file: string;
	lines: string;
	column?: number;
	text: string;
	language?: string;
}

/** Processed match entry in output. */
export interface SgMatch {
	file: string;
	lines: string;
	snippet: string;
}

/** Shaped output for tool result. */
export interface SgResult {
	matches: number;
	results: SgMatch[];
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Determine the correct ast-grep binary name.
 * On Linux, `sg` conflicts with setgroups — prefer `ast-grep`.
 */
export function getSgBinary(): string {
	try {
		execSync("ast-grep --version", { encoding: "utf-8", stdio: "pipe" });
		return "ast-grep";
	} catch {
		return "sg";
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Functions (exported for unit testing)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate that a pattern is suitable for ast-grep (structural/syntax-aware
 * search) rather than plain text search.
 *
 * Collision rule:
 * - Empty or whitespace-only strings are rejected
 * - Single words without structural syntax (no `{`, `$`, `(`, `[`) are
 *   rejected — the agent should use ripgrep for text patterns like "TODO"
 *
 * Returns null if valid, or an error string if invalid.
 */
export function validatePattern(pattern: string): string | null {
	if (!pattern || typeof pattern !== "string") {
		return "Pattern must be a non-empty string";
	}

	const trimmed = pattern.trim();
	if (!trimmed) {
		return "Pattern must be a non-empty string";
	}

	// Structural syntax characters that indicate AST-aware search intent
	const structuralSyntax = /[{$(\\[\]]/;

	// If the pattern is a single word (no whitespace, no structural syntax), reject it
	const isSingleWord = /^\S+$/.test(trimmed);

	if (isSingleWord && !structuralSyntax.test(trimmed)) {
		return `Pattern "${trimmed}" is a single-word text pattern without structural syntax. Use ripgrep (ripgrep_search) for text-based search instead of ast-grep.`;
	}

	return null;
}

/**
 * Truncate a snippet to 120 characters.
 * If the string exceeds 120 chars, truncate to 119 chars and append '…' (120 total).
 */
export function truncateSnippet(text: string): string {
	if (!text) return "";
	if (text.length <= 120) return text;
	return text.slice(0, 119) + "…";
}

/**
 * Build ast-grep command arguments for a pattern search.
 *
 * Uses --json=stream for NDJSON output (one JSON object per line).
 * Pattern is passed as a separate array element to prevent shell injection.
 */
export function buildSgArgs(pattern: string, language: string): { command: string; args: string[] } {
	const command = getSgBinary();
	const args = ["scan", "--pattern", pattern, "--json=stream", "--lang", language];
	return { command, args };
}

/**
 * Parse raw ast-grep JSONL output into SgResult.
 *
 * ast-grep --json=stream outputs one JSON object per line (NDJSON).
 * Empty lines, malformed JSON lines, or lines missing required fields are skipped.
 */
export function parseSgOutput(raw: string): SgResult {
	if (!raw || typeof raw !== "string") {
		return { matches: 0, results: [] };
	}

	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const results: SgMatch[] = [];

	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // skip malformed lines
		}

		if (typeof parsed !== "object" || parsed === null) continue;

		const tag = parsed as Record<string, unknown>;

		// Must have file, text, and lines fields
		if (typeof tag.file !== "string" || !tag.file) continue;
		if (typeof tag.text !== "string") continue;
		if (typeof tag.lines !== "string" && typeof tag.lines !== "number") continue;

		const linesStr = typeof tag.lines === "number" ? String(tag.lines) : (tag.lines as string);

		results.push({
			file: tag.file,
			lines: linesStr,
			snippet: truncateSnippet(tag.text),
		});
	}

	return {
		matches: results.length,
		results,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════

export default function structuralAnalyzer(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "structural_search",
		label: "Structural Search",
		description:
			"Search codebase for structural/grammatical patterns using ast-grep. " +
			"Uses Tree-sitter AST parsing to find semantic code relationships like " +
			"function calls, try/catch blocks, class definitions, and method invocations. " +
			"Output: JSON object with match count and array of results containing " +
			'{ file: string, lines: string (e.g. "22-28"), snippet: string (≤120 chars) }. ' +
			"Use this to answer 'Where is this function called?' or 'Find all try/catch blocks' " +
			"without noise from text matches in comments or strings. " +
			"Requires ast-grep installed (`npm i -g @ast-grep/cli`).",
		promptSnippet:
			"Search codebase for structural code patterns using ast-grep AST matching",
		promptGuidelines: [
			"Use structural_search for syntax-aware code searches where you need to find function calls, class definitions, try/catch blocks, or method invocations without text-match noise from comments or strings.",
			"Pattern syntax uses $META_VAR for single AST node matching (e.g., console.log($A)) and $$$MULTI for zero-or-more nodes (e.g., try { $$$BODY } catch (e) { $A }).",
			"Single-word text patterns like 'TODO' are rejected — use ripgrep_search for plain text searches instead of ast-grep.",
			"Combine structural_search results with read to inspect specific matches by file path and line range.",
		],
		parameters: Type.Object({
			pattern: Type.String({
				description:
					"S-expression or code pattern for AST matching. " +
					"Uses $META_VAR for single nodes, $$$MULTI for zero-or-more nodes. " +
					"Examples: console.log($A), try { $$$BODY } catch (e) { $A }, function($A, $B). " +
					"Must contain structural syntax ($, {, (, [) — single-word text patterns are rejected.",
			}),
			language: Type.String({
				description:
					"Target programming language for Tree-sitter grammar. " +
					"Supported: ts, typescript, js, jsx, py, python, go, golang, rs, rust, and more. " +
					"See ast-grep docs for full list.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { pattern, language } = params;

			// Validate pattern first (collision rule)
			const validationError = validatePattern(pattern);
			if (validationError) {
				return {
					content: [
						{
							type: "text" as const,
							text: validationError,
						},
					],
					details: { success: false, error: validationError } as Record<string, unknown>,
					isError: true,
				};
			}

			// Build and run ast-grep command
			const { command, args } = buildSgArgs(pattern, language);

			const result = await pi.exec(command, args, {
				cwd: ctx.cwd,
				timeout: 30_000,
			});

			if (result.code !== 0) {
				// ast-grep exits with code 0 on success, code 1 when no matches found
				// — in that case stdout is empty, stderr may have a message
				if (!result.stdout || result.stdout.trim().length === 0) {
					const stderrMsg = result.stderr?.trim() || "";
					// If stderr mentions "unknown language" or similar, return error
					if (
						stderrMsg &&
						(stderrMsg.toLowerCase().includes("unknown") ||
							stderrMsg.toLowerCase().includes("error") ||
							stderrMsg.toLowerCase().includes("not found"))
					) {
						return {
							content: [
								{
									type: "text" as const,
									text:
										`ast-grep failed (exit code ${result.code}): ${stderrMsg}`,
								},
							],
							details: { success: false, exitCode: result.code, stderr: result.stderr } as Record<string, unknown>,
							isError: true,
						};
					}

					// No matches found (exit code 1, empty stdout)
					return {
						content: [
							{
								type: "text" as const,
								text: `No matches found for pattern "${pattern}" in language "${language}".`,
							},
						],
						details: { success: true, matches: 0, results: [] } as Record<string, unknown>,
					};
				}
			}

			// Parse JSONL output
			const sgResult = parseSgOutput(result.stdout);

			// Format as pretty JSON for LLM consumption
			const json = JSON.stringify(sgResult, null, 2);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Structural search results for pattern: ${pattern}\n` +
							`Language: ${language}\n` +
							`Matches: ${sgResult.matches}\n\n` +
							"```json\n" +
							json +
							"\n```",
					},
				],
				details: { success: true, ...sgResult } as Record<string, unknown>,
			};
		},
	});
}
