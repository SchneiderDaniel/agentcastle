/**
 * Ripgrep Search — literal text search via ripgrep
 *
 * Registers a `ripgrep_search` tool that runs `rg --vimgrep --max-columns=200
 * --max-count=<max_count> --no-heading "<query>" <directory>` via pi.exec(),
 * parses the vimgrep output format (file:line:column:text), and returns a
 * structured JSON result.
 *
 * This is the Extraction Layer — the agent uses this to answer "Where did
 * someone write the exact string '5000'?".
 *
 * Design:
 * - Single flat file with clear sequential phases: validate → buildArgs → exec → parse → return
 * - Pure validate/parse/buildArgs functions are exported for unit testing
 * - rg invoked via pi.exec() with args array — no shell injection possible
 * - Collision rule: structural patterns (class/def/function prefixes or ${ syntax)
 *   are rejected, forcing agent to use structural_search or map_codebase
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/** Single parsed vimgrep result entry. */
export interface RgMatch {
	file: string;
	line: number;
	column: number;
	text: string;
}

/** Shaped output for tool result. */
export interface RgResult {
	total_returned: number;
	results: RgMatch[];
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Functions (exported for unit testing)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate that a query is suitable for ripgrep (literal/regex text search)
 * rather than structural/syntax-aware search.
 *
 * Collision rule:
 * - Empty or whitespace-only strings are rejected
 * - Patterns starting with `class `, `def `, `function ` are rejected —
 *   agent should use map_codebase (ctags) for class/def searches
 * - Patterns containing `$` or `{` (structural AST syntax) are rejected —
 *   agent should use structural_search (ast-grep) for structural searches
 *
 * Returns null if valid, or an error string if invalid.
 */
export function validateQuery(query: string): string | null {
	if (!query || typeof query !== "string") {
		return "Query must be a non-empty string";
	}

	const trimmed = query.trim();
	if (!trimmed) {
		return "Query must be a non-empty string";
	}

	// Reject patterns that look like structural/symbol searches
	if (trimmed.startsWith("class ")) {
		return `Query "${trimmed}" looks like a class definition search. Use map_codebase (ctags) to find class definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("def ")) {
		return `Query "${trimmed}" looks like a function definition search. Use map_codebase (ctags) to find function definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("function ")) {
		return `Query "${trimmed}" looks like a function definition search. Use map_codebase (ctags) to find function definitions, not ripgrep_search.`;
	}

	// Reject patterns with structural AST syntax ($ or {)
	if (trimmed.includes("$") || trimmed.includes("{")) {
		return `Query "${trimmed}" contains structural syntax ($ or {). Use structural_search (ast-grep) for structural code pattern matching, not ripgrep_search.`;
	}

	return null;
}

/**
 * Build ripgrep command arguments for a text search.
 *
 * Uses --vimgrep for machine-parseable output (file:line:column:text).
 * Uses --max-columns=200 to cap line length (prevents context-window blowup).
 * Uses --max-count to cap matches per file.
 * Uses --no-heading (implied by --vimgrep, explicit for safety).
 * Uses -j1 (single thread) to avoid per-thread output buffering memory blowup
 *   with --vimgrep (research finding: --vimgrep + parallelism can consume 18+ GB).
 *
 * Query and directory are passed as separate array elements — never
 * concatenated into the arg string — to prevent shell injection.
 */
export function buildRgArgs(
	query: string,
	directory: string,
	maxCount: number,
): { command: string; args: string[] } {
	const args = [
		"--vimgrep",
		"--max-columns=200",
		`--max-count=${maxCount}`,
		"--no-heading",
		"-j1",
		query,
		directory,
	];
	return { command: "rg", args };
}

/**
 * Parse raw ripgrep --vimgrep output into RgResult.
 *
 * --vimgrep output format: file:line:column:text
 * Parsed with regex: ^(.+?):(\d+):(\d+):(.*)$
 *
 * Empty input, null, undefined → empty result.
 * Malformed lines (missing colons, non-numeric line/column) → skipped.
 * Lines with colons in the text portion → text is everything after third colon.
 */
export function parseVimgrepOutput(raw: string | null | undefined): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];

	const vimgrepRegex = /^(.+?):(\d+):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(vimgrepRegex);
		if (!match) continue;

		const file = match[1]!;
		const lineNum = parseInt(match[2]!, 10);
		const column = parseInt(match[3]!, 10);
		const text = match[4]!;

		if (isNaN(lineNum) || isNaN(column)) continue;

		results.push({
			file,
			line: lineNum,
			column,
			text,
		});
	}

	return {
		total_returned: results.length,
		results,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════

export default function ripgrepSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ripgrep_search",
		label: "Ripgrep Search",
		description:
			"Search codebase for literal text or regex patterns using ripgrep. " +
			"Executes rg --vimgrep --max-columns=200 --max-count=<limit> \"<query>\" via subprocess. " +
			"Output: JSON object with total_returned count and array of results containing " +
			'{ file: string, line: number, column: number, text: string }. ' +
			"Use this to answer 'Where did someone write the exact string \"5000\"?' or " +
			"'Find all occurrences of \"TIMEOUT_MS\" in the codebase.' " +
			"Respects .gitignore natively. " +
			"Requires ripgrep installed (`rg --version`).",
		promptSnippet:
			"Search codebase for literal text or regex using ripgrep",
		promptGuidelines: [
			"Use ripgrep_search for literal text searches — magic numbers, hardcoded strings, error messages, TODOs, configuration values.",
			"Do NOT use ripgrep_search to find function definitions, class declarations, or structural code patterns. For those, use map_codebase (ctags) for symbol lookup or structural_search (ast-grep) for AST-aware pattern matching.",
			"ripgrep_search respects .gitignore natively — no extra config needed to skip ignored files.",
			"Default max_count is 10 (limited per file). Override for targeted searches with fewer results needed.",
			"Default directory is current working directory ('.'). Pass an explicit path to scope the search.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"The literal text or regex to find. Supports regex patterns (e.g., 'TODO|FIXME'). " +
					"Collision rule: patterns starting with 'class ', 'def ', 'function ', or containing " +
					"'$' or '{' are rejected — use structural_search or map_codebase instead.",
			}),
			directory: Type.Optional(
				Type.String({
					default: ".",
					description:
						"Directory scope for the search (default: current working directory)",
				}),
			),
			max_count: Type.Optional(
				Type.Number({
					default: 10,
					description:
						"Maximum matches per file (default: 10). Use this to limit output " +
						"from high-frequency patterns that could blow the context window.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const query = params.query;
			const directory = params.directory ?? ".";
			const maxCount = params.max_count ?? 10;

			// Validate query first (collision rule)
			const validationError = validateQuery(query);
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

			// Build and run rg command
			const { command, args } = buildRgArgs(query, directory, maxCount);

			const result = await pi.exec(command, args, {
				cwd: ctx.cwd,
				timeout: 30_000,
			});

			if (result.code !== 0) {
				// ripgrep exits with code 0 when matches found, code 1 when no matches,
				// code 2 when error occurred (e.g., directory not found)
				if (result.code === 1) {
					// No matches found — not an error, just empty result
					return {
						content: [
							{
								type: "text" as const,
								text: `No matches found for query "${query}" in "${directory}".`,
							},
						],
						details: { success: true, total_returned: 0, results: [] } as Record<string, unknown>,
					};
				}

				// Error (exit code 2+)
				return {
					content: [
						{
							type: "text" as const,
							text:
								`ripgrep failed (exit code ${result.code}): ` +
								(result.stderr || "unknown error") +
								"\n\nEnsure ripgrep is installed (`rg --version`).",
						},
					],
					details: { success: false, exitCode: result.code, stderr: result.stderr } as Record<string, unknown>,
					isError: true,
				};
			}

			// Parse vimgrep output
			const rgResult = parseVimgrepOutput(result.stdout);

			// Format as pretty JSON for LLM consumption
			const json = JSON.stringify(rgResult, null, 2);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Ripgrep search results for query: ${query}\n` +
							`Directory: ${directory}\n` +
							`Matches returned: ${rgResult.total_returned}\n\n` +
							"```json\n" +
							json +
							"\n```",
					},
				],
				details: { success: true, ...rgResult } as Record<string, unknown>,
			};
		},
	});
}
