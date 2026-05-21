/**
 * ripgrep-search — Fast literal text search across the codebase
 *
 * Provides the ripgrep_search tool. Uses ripgrep to find exact strings,
 * magic numbers, error messages, and configuration values. Respects .gitignore.
 * Rejects structural patterns (class/def/function) — use structural_search for those.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
// Configuration
// ═══════════════════════════════════════════════════════════════════════

export interface SearchConfig {
	searchBackend: "auto" | "ripgrep" | "grep";
	maxLineLength: number;
}

const DEFAULT_CONFIG: SearchConfig = {
	searchBackend: "auto",
	maxLineLength: 200,
};

const MAX_LINE_LENGTH_MAX = 2000;
const MAX_LINE_LENGTH_DEFAULT = 200;

/**
 * Load search configuration from .pi/settings.json.
 * Falls back to defaults on missing file, parse errors, or missing keys.
 */
export function loadSearchConfig(cwd: string): SearchConfig {
	try {
		const settingsPath = join(cwd, ".pi", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw);
		const search = settings?.search;

		if (!search) return { ...DEFAULT_CONFIG };

		let searchBackend: SearchConfig["searchBackend"] = DEFAULT_CONFIG.searchBackend;
		if (search.searchBackend === "ripgrep" || search.searchBackend === "grep" || search.searchBackend === "auto") {
			searchBackend = search.searchBackend;
		}

		let maxLineLength = MAX_LINE_LENGTH_DEFAULT;
		if (typeof search.maxLineLength === "number" && Number.isInteger(search.maxLineLength) && search.maxLineLength > 0) {
			maxLineLength = Math.min(search.maxLineLength, MAX_LINE_LENGTH_MAX);
		}

		return { searchBackend, maxLineLength };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Resolve the active search backend based on user config and rg availability.
 * - "ripgrep": forces ripgrep (returns error string if rg not available)
 * - "grep": forces grep (skips rg detection)
 * - "auto": uses ripgrep if available, grep otherwise
 */
export function resolveBackend(config: SearchConfig, rgAvailable: boolean): { backend: "ripgrep" | "grep"; error?: string } {
	if (config.searchBackend === "ripgrep") {
		if (!rgAvailable) {
			return { backend: "ripgrep", error: "ripgrep not found on PATH. Install rg or set searchBackend to 'auto' or 'grep' in .pi/settings.json." };
		}
		return { backend: "ripgrep" };
	}
	if (config.searchBackend === "grep") {
		return { backend: "grep" };
	}
	// auto
	return { backend: rgAvailable ? "ripgrep" : "grep" };
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Functions (exported for unit testing)
// ═══════════════════════════════════════════════════════════════════════

/** Detect if ripgrep is available on PATH. */
export async function ripgrepAvailable(exec: ExtensionAPI["exec"]): Promise<boolean> {
	try {
		const result = await exec("which", ["rg"], { timeout: 3_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * Build grep command arguments as fallback when ripgrep unavailable.
 * Emulates --vimgrep output (file:line:column:text) as closely as possible.
 * Column is set to 1 since standard grep doesn't output column.
 */
export function buildGrepArgs(
	query: string,
	directory: string,
	maxCount: number,
): { command: string; args: string[] } {
	const excludedDirs = [
		"--exclude-dir=.git",
		"--exclude-dir=node_modules",
		"--exclude-dir=venv",
		"--exclude-dir=__pycache__",
		"--exclude-dir=.mypy_cache",
		"--exclude-dir=.pytest_cache",
		"--exclude-dir=dist",
		"--exclude-dir=build",
	];
	const args = [
		"-rnH", // recursive, line-number, with-filename
		"-m",
		`${maxCount}`, // max matches per file
		"--color=never",
		...excludedDirs,
		"-e",
		query, // pattern (safe: separate arg, no injection)
		directory,
	];
	return { command: "grep", args };
}

/**
 * Parse generic grep -rnH output into RgResult.
 * grep -rnH produces: file:line:text
 * Since grep lacks column info,
 * column defaults to 1.
 */
export function parseGrepOutput(raw: string | null | undefined): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];

	// grep -rnH: file:line:text
	// Text may contain colons, so match greedily from start
	const grepRegex = /^(.+?):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(grepRegex);
		if (!match) continue;

		const file = match[1]!;
		const lineNum = parseInt(match[2]!, 10);
		const text = match[3]!;

		if (isNaN(lineNum)) continue;

		results.push({
			file,
			line: lineNum,
			column: 1,
			text,
		});
	}

	return {
		total_returned: results.length,
		results,
	};
}

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
	maxLineLength: number = 200,
): { command: string; args: string[] } {
	const args = [
		"--vimgrep",
		`--max-columns=${maxLineLength}`,
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
	// Module-level state
	let rgAvailable: boolean | null = null;
	let searchConfig: SearchConfig | null = null;
	let backendNoteInjected = false;

	// Eager detection on session start
	pi.on("session_start", async (_event, ctx) => {
		searchConfig = loadSearchConfig(ctx.cwd);
		// Only detect rg if backend selection might need it
		if (searchConfig.searchBackend !== "grep") {
			rgAvailable = await ripgrepAvailable(pi.exec);
		} else {
			rgAvailable = false;
		}
		backendNoteInjected = false;
	});

	// Inject backend-status note into system prompt
	pi.on("before_agent_start", async (event, _ctx) => {
		// Only inject if ripgrep_search tool is active in this agent
		if (!event.systemPromptOptions?.selectedTools?.includes("ripgrep_search")) return;
		if (backendNoteInjected) return;

		const config = searchConfig ?? DEFAULT_CONFIG;
		const resolved = resolveBackend(config, rgAvailable ?? false);

		let note: string;
		if (resolved.backend === "ripgrep") {
			const configured = config.searchBackend === "ripgrep" ? " (user-configured)" : "";
			note = `\n[Search backend: ripgrep${configured} — .gitignore respected, column offsets available]`;
		} else {
			const configured = config.searchBackend === "grep" ? " (user-configured)" : " (fallback)";
			note = `\n[Search backend: grep${configured} — .gitignore NOT respected, column always 1, excluded dirs: .git,node_modules,venv,__pycache__,.mypy_cache,.pytest_cache,dist,build]`;
		}

		backendNoteInjected = true;
		return { systemPrompt: event.systemPrompt + note };
	});

	pi.registerTool({
		name: "ripgrep_search",
		label: "Ripgrep Search",
		description:
			"Search codebase for literal text or regex patterns using ripgrep. " +
			'Executes rg --vimgrep --max-columns=200 --max-count=<limit> "<query>" via subprocess. ' +
			"Output: JSON object with total_returned count and array of results containing " +
			"{ file: string, line: number, column: number, text: string }. " +
			"Use this to answer 'Where did someone write the exact string \"5000\"?' or " +
			"'Find all occurrences of \"TIMEOUT_MS\" in the codebase.' " +
			"Respects .gitignore natively. " +
			"Requires ripgrep installed (`rg --version`).",
		promptSnippet: "Search codebase for literal text or regex using ripgrep",
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
					description: "Directory scope for the search (default: current working directory)",
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

			// Ensure config loaded (defensive — session_start should have set it)
			const config = searchConfig ?? loadSearchConfig(ctx.cwd);
			searchConfig = config;

			// Ensure rgAvailable detected (defensive)
			if (rgAvailable === null) {
				rgAvailable = await ripgrepAvailable(pi.exec);
			}

			// Resolve backend from config + detection
			const resolved = resolveBackend(config, rgAvailable);
			if (resolved.error) {
				return {
					content: [
						{
							type: "text" as const,
							text: resolved.error,
						},
					],
					details: { success: false, error: resolved.error } as Record<string, unknown>,
					isError: true,
				};
			}

			const useRipgrep = resolved.backend === "ripgrep";
			const searcherName = useRipgrep ? "ripgrep" : "grep";

			const { command, args } = useRipgrep
				? buildRgArgs(query, directory, maxCount, config.maxLineLength)
				: buildGrepArgs(query, directory, maxCount);

			const result = await pi.exec(command, args, {
				cwd: ctx.cwd,
				timeout: 30_000,
			});

			if (result.code !== 0) {
				// rg/grep exit code 0 = matches found, 1 = no matches, 2+ = error
				if (result.code === 1) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No matches found for query "${query}" in "${directory}" (${searcherName}).`,
							},
						],
						details: {
							success: true,
							total_returned: 0,
							results: [],
							searcher: searcherName,
						} as Record<string, unknown>,
					};
				}

				// Error (exit code 2+)
				const engineStr = useRipgrep ? "ripgrep (`rg --version`)" : "grep";
				return {
					content: [
						{
							type: "text" as const,
							text:
								`${searcherName} failed (exit code ${result.code}): ` +
								(result.stderr || "unknown error") +
								`\n\nEnsure ${engineStr} installed.`,
						},
					],
					details: {
						success: false,
						exitCode: result.code,
						stderr: result.stderr,
						searcher: searcherName,
					} as Record<string, unknown>,
					isError: true,
				};
			}

			// Parse output (vimgrep for rg, grep format for grep)
			const searchResult = useRipgrep
				? parseVimgrepOutput(result.stdout)
				: parseGrepOutput(result.stdout);

			const json = JSON.stringify(searchResult, null, 2);

			return {
				content: [
					{
						type: "text" as const,
						text:
							`${searcherName} search results for query: ${query}\n` +
							`Directory: ${directory}\n` +
							`Matches returned: ${searchResult.total_returned}\n\n` +
							"```json\n" +
							json +
							"\n```",
					},
				],
				details: {
					success: true,
					searcher: searcherName,
					...searchResult,
				} as Record<string, unknown>,
			};
		},
	});
}
