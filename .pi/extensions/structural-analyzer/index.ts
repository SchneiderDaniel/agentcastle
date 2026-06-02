/**
 * structural-search — AST-aware code search for function calls, classes, and patterns
 *
 * Provides the structural_search tool. Uses ast-grep with Tree-sitter parsing
 * to find semantic code relationships. Answers questions like "Where is
 * verify_token called and what is passed to it?".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

/**
 * Response shape from interpretSgExecResult.
 * Matches the AgentToolResult contract used by pi.exec tool execution.
 */
export interface ExecResultResponse {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
	isError?: boolean;
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
 * Interpret the result of an ast-grep exec call and return the appropriate
 * response shape based on exit code, stdout, and stderr.
 *
 * Replaces the fragile keyword-heuristic error detection with exit-code-based logic.
 * ast-grep convention:
 *   - code 0 = success (stdout may contain JSONL matches or be empty)
 *   - code 1 = no matches found (empty stdout, empty stderr)
 *   - all other non-zero codes = real errors
 *
 * When stderr is non-empty with any exit code, it's treated as an error
 * (exit code 1 with non-empty stderr means ast-grep encountered an issue).
 */
export function interpretSgExecResult(
	code: number,
	stdout: string,
	stderr: string,
	pattern: string,
	language: string,
): ExecResultResponse {
	const trimmedStdout = (stdout || "").trim();
	const trimmedStderr = (stderr || "").trim();

	// If there's actual stdout content, parse it regardless of exit code
	// (ast-grep may produce partial results even on non-zero exit)
	if (trimmedStdout.length > 0) {
		const sgResult = parseSgOutput(stdout);
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
	}

	// No stdout content
	if (code === 0) {
		// ast-grep succeeded but produced no output
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

	// Exit code 1 with empty stderr = legitimate no-match (ast-grep convention)
	if (code === 1 && trimmedStderr.length === 0) {
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

	// Everything else is a real error
	const stderrMsg = trimmedStderr || "(no stderr)";
	return {
		content: [
			{
				type: "text" as const,
				text: `ast-grep failed (exit code ${code}): ${stderrMsg}`,
			},
		],
		details: {
			success: false,
			exitCode: code,
			stderr: stderr,
		} as Record<string, unknown>,
		isError: true,
	};
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
	// Lazy async binary detection — cached after first call
	let sgBinary: string | null = null;

	async function getSgBinary(): Promise<string> {
		if (sgBinary) return sgBinary;
		const result = await pi.exec("ast-grep", ["--version"], { timeout: 5_000 });
		sgBinary = result.code === 0 ? "ast-grep" : "sg";
		return sgBinary;
	}

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
		promptSnippet: "Search codebase for structural code patterns using ast-grep AST matching",
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

			// Get binary (lazy init, cached for subsequent calls)
			const binary = await getSgBinary();
			const args = ["scan", "--pattern", pattern, "--json=stream", "--lang", language];

			const result = await pi.exec(binary, args, {
				cwd: ctx.cwd,
				timeout: 30_000,
			});

			// Use the extracted pure function to interpret the exec result
			return interpretSgExecResult(
				result.code,
				result.stdout || "",
				result.stderr || "",
				pattern,
				language,
			);
		},
	});
}
