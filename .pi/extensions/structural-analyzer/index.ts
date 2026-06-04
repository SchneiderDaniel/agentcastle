/**
 * structural-search — AST-aware code search for function calls, classes, and patterns
 *
 * Provides the structural_search tool. Uses ast-grep with Tree-sitter parsing
 * to find semantic code relationships. Answers questions like "Where is
 * verify_token called and what is passed to it?".
 *
 * Features:
 * - Result cache keyed by (pattern, language, cwd)
 * - Language auto-detect from project files when language param omitted
 * - Streaming support: truncates large result sets (>100 matches)
 * - Binary auto-detection (ast-grep -> sg fallback)
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
// Constants
// ═══════════════════════════════════════════════════════════════════════

/** Maximum results to return inline before truncating for streaming. */
const STREAM_THRESHOLD = 100;

/** Project config files for language auto-detection, in priority order. */
const CONFIG_PRIORITY: Array<{ file: string; language: string }> = [
	{ file: "sgconfig.yml", language: "" }, // special: parse languageGlobs from YAML
	{ file: "tsconfig.json", language: "typescript" },
	{ file: "pyproject.toml", language: "python" },
	{ file: "go.mod", language: "go" },
	{ file: "Cargo.toml", language: "rust" },
];

/** Default language when auto-detect fails and no caller-supplied language. */
const DEFAULT_LANGUAGE = "ts";

/** Module-level result cache keyed by `${pattern}::${language}::${cwd}`. */
const RESULT_CACHE = new Map<string, ExecResultResponse>();

/**
 * Clear the result cache. Useful for testing and when the underlying
 * filesystem/codebase may have changed between searches.
 */
export function clearResultCache(): void {
	RESULT_CACHE.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// Cache key helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Build a deterministic cache key from search parameters.
 * Uses '::' as separator — unlikely to appear in pattern/language/cwd values.
 */
export function makeCacheKey(pattern: string, language: string, cwd: string): string {
	return `${pattern}::${language}::${cwd}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Language auto-detect
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check if a file exists in a given directory using `test -f`.
 */
export async function fileExists(
	exec: (command: string, args: string[], options?: { cwd?: string }) => Promise<{ code: number }>,
	file: string,
	cwd: string,
): Promise<boolean> {
	const result = await exec("test", ["-f", file], { cwd });
	return result.code === 0;
}

/**
 * Auto-detect the programming language from project configuration files
 * in the given cwd. Checks files in priority order:
 * sgconfig.yml > tsconfig.json > pyproject.toml > go.mod > Cargo.toml
 *
 * For sgconfig.yml, attempts to extract the first key from `languageGlobs`.
 * Returns null if no config file found.
 */
export async function detectLanguage(
	exec: (
		command: string,
		args: string[],
		options?: { cwd?: string },
	) => Promise<{ code: number; stdout: string }>,
	cwd: string,
): Promise<string | null> {
	for (const { file, language } of CONFIG_PRIORITY) {
		const exists = await fileExists(exec, file, cwd);
		if (!exists) continue;

		if (file === "sgconfig.yml") {
			// Read sgconfig.yml and extract first key from languageGlobs
			try {
				const readResult = await exec("cat", [file], { cwd });
				if (readResult.code === 0 && readResult.stdout) {
					const detected = parseLanguageGlobsFromYaml(readResult.stdout);
					if (detected) return detected;
				}
			} catch {
				// If reading fails, fall through to next config
			}
			continue;
		}

		// For all other config files, return the mapped language
		return language;
	}

	return null;
}

/**
 * Naive YAML parser that extracts the first key from a `languageGlobs:` section.
 * Only used for sgconfig.yml auto-detection — not a general YAML parser.
 *
 * Handles:
 *   languageGlobs:
 *     ts: "**\/*.ts"
 *     js: "**\/*.js"
 *   → returns "ts"
 *
 * Returns null if languageGlobs section not found or empty.
 */
export function parseLanguageGlobsFromYaml(yamlContent: string): string | null {
	const lines = yamlContent.split("\n");
	let inLanguageGlobs = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed === "languageGlobs:") {
			inLanguageGlobs = true;
			continue;
		}

		if (inLanguageGlobs) {
			// If we hit another top-level key (no indent), stop
			if (trimmed.length > 0 && !trimmed.startsWith("-") && line[0] !== " " && line[0] !== "\t") {
				return null;
			}

			// Match "  lang: ..." pattern
			const match = trimmed.match(/^(\S+):/);
			if (match) {
				return match[1];
			}
		}
	}

	return null;
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

		// Check streaming threshold — truncate if too many matches
		if (sgResult.matches > STREAM_THRESHOLD) {
			const truncatedResults = sgResult.results.slice(0, STREAM_THRESHOLD);
			const summary: SgResult = {
				matches: sgResult.matches,
				results: truncatedResults,
			};
			const json = JSON.stringify(summary, null, 2);
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Structural search results for pattern: ${pattern}\n` +
							`Language: ${language}\n` +
							`Matches: ${sgResult.matches} (showing first ${STREAM_THRESHOLD})\n\n` +
							"```json\n" +
							json +
							"\n```\n\n" +
							`Results truncated to ${STREAM_THRESHOLD}. Total matches: ${sgResult.matches}. ` +
							`Refine the search pattern to narrow results.`,
					},
				],
				details: {
					success: true,
					matches: sgResult.matches,
					results: truncatedResults,
					truncated: true,
					totalMatches: sgResult.matches,
				} as Record<string, unknown>,
			};
		}

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
			language: Type.Optional(
				Type.String({
					description:
						"Target programming language for Tree-sitter grammar. " +
						"Auto-detected from project files when omitted. " +
						"Supported: ts, typescript, js, jsx, py, python, go, golang, rs, rust, and more. " +
						"See ast-grep docs for full list.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { pattern } = params;
			const language =
				params.language ?? (await detectLanguage(pi.exec.bind(pi), ctx.cwd)) ?? DEFAULT_LANGUAGE;

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

			// Check cache before executing
			const cacheKey = makeCacheKey(pattern, language, ctx.cwd);
			const cached = RESULT_CACHE.get(cacheKey);
			if (cached) {
				return cached;
			}

			// Get binary (lazy init, cached for subsequent calls)
			const binary = await getSgBinary();
			const args = ["scan", "--pattern", pattern, "--json=stream", "--lang", language];

			const result = await pi.exec(binary, args, {
				cwd: ctx.cwd,
				timeout: 30_000,
			});

			// Use the extracted pure function to interpret the exec result
			const response = interpretSgExecResult(
				result.code,
				result.stdout || "",
				result.stderr || "",
				pattern,
				language,
			);

			// Cache the result (only cache successful, non-error responses)
			if (!response.isError) {
				RESULT_CACHE.set(cacheKey, response);
			}

			return response;
		},
	});
}
