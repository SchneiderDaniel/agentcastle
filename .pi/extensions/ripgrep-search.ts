/**
 * ripgrep-search — Fast literal text search across the codebase
 *
 * Provides the ripgrep_search tool. Uses ripgrep to find exact strings,
 * magic numbers, error messages, and configuration values. Respects .gitignore.
 * Rejects structural patterns (class/def/function) — use structural_search for those.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
	truncated?: boolean;
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

const MAX_TOTAL_RESULTS = 500;
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
		if (
			search.searchBackend === "ripgrep" ||
			search.searchBackend === "grep" ||
			search.searchBackend === "auto"
		) {
			searchBackend = search.searchBackend;
		}

		let maxLineLength = MAX_LINE_LENGTH_DEFAULT;
		if (
			typeof search.maxLineLength === "number" &&
			Number.isInteger(search.maxLineLength) &&
			search.maxLineLength > 0
		) {
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
export function resolveBackend(
	config: SearchConfig,
	rgAvailable: boolean,
): { backend: "ripgrep" | "grep"; error?: string } {
	if (config.searchBackend === "ripgrep") {
		if (!rgAvailable) {
			return {
				backend: "ripgrep",
				error:
					"ripgrep not found on PATH. Install rg or set searchBackend to 'auto' or 'grep' in .pi/settings.json.",
			};
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
		const result = await exec("rg", ["--version"], { timeout: 3_000 });
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
export function parseGrepOutput(
	raw: string | null | undefined,
	maxResults: number = Infinity,
): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];
	let totalMatches = 0;

	// grep -rnH: file:line:text
	// Text may contain colons, so match greedily from start
	const grepRegex = /^(.+?):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(grepRegex);
		if (!match) continue;

		const lineNum = parseInt(match[2]!, 10);
		if (isNaN(lineNum)) continue;

		totalMatches++;

		if (results.length < maxResults) {
			const file = match[1]!;
			const text = match[3]!;
			results.push({
				file,
				line: lineNum,
				column: 1,
				text,
			});
		}
	}

	return {
		total_returned: totalMatches,
		results,
		truncated: totalMatches > maxResults,
	};
}

/**
 * Validate that a query is suitable for ripgrep (literal/regex text search)
 * rather than structural/syntax-aware search.
 *
 * Collision rule:
 * - Empty or whitespace-only strings are rejected
 * - Patterns starting with `class `, `def `, `function ` are rejected —
 *   agent should use ranked_map (ctags) for class/def searches
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
		return `Query "${trimmed}" looks like a class definition search. Use ranked_map (ctags) to find class definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("def ")) {
		return `Query "${trimmed}" looks like a function definition search. Use ranked_map (ctags) to find function definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("function ")) {
		return `Query "${trimmed}" looks like a function definition search. Use ranked_map (ctags) to find function definitions, not ripgrep_search.`;
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
export function parseVimgrepOutput(
	raw: string | null | undefined,
	maxResults: number = Infinity,
): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];
	let totalMatches = 0;

	const vimgrepRegex = /^(.+?):(\d+):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(vimgrepRegex);
		if (!match) continue;

		const lineNum = parseInt(match[2]!, 10);
		const column = parseInt(match[3]!, 10);
		if (isNaN(lineNum) || isNaN(column)) continue;

		totalMatches++;

		if (results.length < maxResults) {
			const file = match[1]!;
			const text = match[4]!;
			results.push({
				file,
				line: lineNum,
				column,
				text,
			});
		}
	}

	return {
		total_returned: totalMatches,
		results,
		truncated: totalMatches > maxResults,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Temp directory tracking (session-scoped cleanup)
// ═══════════════════════════════════════════════════════════════════════

const trackedTempDirs = new Set<string>();

/** Register a temp directory for deferred cleanup at session end. */
export function registerTempDir(dir: string): void {
	trackedTempDirs.add(dir);
}

/**
 * Clean up all tracked temp directories.
 * Accepts rm function for testability (mock injection).
 */
export async function cleanupTrackedTempDirs(
	rmFn: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>,
): Promise<void> {
	for (const dir of trackedTempDirs) {
		await rmFn(dir, { recursive: true, force: true });
	}
	trackedTempDirs.clear();
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

	// Clean up tracked temp directories at session end
	pi.on("session_shutdown", async () => {
		await cleanupTrackedTempDirs(rm);
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
			"Do NOT use ripgrep_search to find function definitions, class declarations, or structural code patterns. For those, use ranked_map (ctags) for symbol lookup or structural_search (ast-grep) for AST-aware pattern matching.",
			"ripgrep_search respects .gitignore natively — no extra config needed to skip ignored files.",
			"Default max_count is 10 (limited per file). Override for targeted searches with fewer results needed.",
			"Default directory is current working directory ('.'). Pass an explicit path to scope the search.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"The literal text or regex to find. Supports regex patterns (e.g., 'TODO|FIXME'). " +
					"Collision rule: patterns starting with 'class ', 'def ', 'function ', or containing " +
					"'$' or '{' are rejected — use structural_search or ranked_map instead.",
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
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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

			// ── Pre-flight: verify directory exists before spawning subprocess ──
			const resolvedDir = resolve(ctx.cwd, directory);
			try {
				const dirStat = await stat(resolvedDir);
				if (!dirStat.isDirectory()) {
					return {
						content: [
							{
								type: "text" as const,
								text: `"${directory}" is a file, not a directory.`,
							},
						],
						details: {
							success: false,
							error: `"${directory}" is a file, not a directory.`,
						} as Record<string, unknown>,
						isError: true,
					};
				}
			} catch (err: unknown) {
				const nodeErr = err as { code?: string };
				if (nodeErr.code === "ENOENT") {
					// Directory not found — list valid directories
					let validDirs: string[] = [];
					try {
						const entries = await readdir(ctx.cwd, { withFileTypes: true });
						validDirs = entries
							.filter((e) => e.isDirectory())
							.map((e) => e.name + "/")
							.sort();
					} catch {
						// ignore readdir errors
					}
					const dirList = validDirs.length > 0 ? ` Valid directories: ${validDirs.join(", ")}` : "";
					return {
						content: [
							{
								type: "text" as const,
								text: `Directory "${directory}" not found in project root.${dirList}`,
							},
						],
						details: {
							success: false,
							error: `Directory "${directory}" not found.${dirList}`,
						} as Record<string, unknown>,
						isError: true,
					};
				}
				if (nodeErr.code === "ENOTDIR") {
					return {
						content: [
							{
								type: "text" as const,
								text: `"${directory}" is a file, not a directory.`,
							},
						],
						details: {
							success: false,
							error: `"${directory}" is a file, not a directory.`,
						} as Record<string, unknown>,
						isError: true,
					};
				}
				// Other stat errors (permission, etc.) — let the subprocess handle it
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
				signal,
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
							searcher: searcherName,
						} as Record<string, unknown>,
					};
				}

				// Error (exit code 2+)
				const stderr = result.stderr || "";
				const engineStr = useRipgrep ? "ripgrep (`rg --version`)" : "grep";

				// Check for path-related errors in stderr
				const pathErrorPatterns = [/No such file or directory/i, /ENOENT/i, /not found/i];
				const isPathError = pathErrorPatterns.some((p) => p.test(stderr));

				// Check for tool-missing errors
				const missingToolPatterns = [/command not found/i, /not recognized/i, /internal error/i];
				const isMissingTool = missingToolPatterns.some((p) => p.test(stderr)) || !stderr.trim();

				let errorText: string;
				if (isPathError) {
					errorText =
						`${searcherName} failed (exit code ${result.code}): ${stderr}` +
						`\nDirectory "${directory}" not found or inaccessible.`;
				} else if (isMissingTool) {
					errorText =
						`${searcherName} failed (exit code ${result.code}): ${stderr || "unknown error"}` +
						`\n\nEnsure ${engineStr} installed.`;
				} else {
					errorText = `${searcherName} failed (exit code ${result.code}): ${stderr}`;
				}

				return {
					content: [
						{
							type: "text" as const,
							text: errorText,
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

			// Parse output (vimgrep for rg, grep format for grep), capping at MAX_TOTAL_RESULTS
			const searchResult = useRipgrep
				? parseVimgrepOutput(result.stdout, MAX_TOTAL_RESULTS)
				: parseGrepOutput(result.stdout, MAX_TOTAL_RESULTS);

			const totalReturned = searchResult.total_returned;
			const resultsTruncated = searchResult.truncated ?? false;

			let json = JSON.stringify(searchResult, null, 2);
			let fullOutputPath: string | undefined;

			// Apply byte-level truncation as safety net
			const truncation = truncateHead(json, {
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
			});

			// If either results cap or byte truncation kicked in, save full output (raw stdout)
			if (resultsTruncated || truncation.truncated) {
				const tempDir = await mkdtemp(join(tmpdir(), "pi-ripgrep-"));
				registerTempDir(tempDir); // Track for cleanup on session shutdown
				fullOutputPath = join(tempDir, "full-output.txt");
				// Write raw stdout (vimgrep/grep format) — compact, avoids JSON re-serialization
				await withFileMutationQueue(fullOutputPath ?? "", async () => {
					await writeFile(fullOutputPath ?? "", result.stdout ?? "", "utf8");
				});
			}

			// Build text content with truncation awareness
			let contentText =
				`${searcherName} search results for query: ${query}\n` +
				`Directory: ${directory}\n` +
				`Matches returned: ${totalReturned}\n\n`;

			if (truncation.truncated) {
				contentText += truncation.content;
				const truncatedLines = truncation.totalLines - truncation.outputLines;
				const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
				contentText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				contentText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				contentText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
				if (fullOutputPath) {
					contentText += ` Full output saved to: ${fullOutputPath}]`;
				} else {
					contentText += "]";
				}
			} else if (resultsTruncated) {
				contentText += json;
				contentText += `\n\n[Showing first ${MAX_TOTAL_RESULTS} of ${totalReturned} results. Full output saved to: ${fullOutputPath}]`;
			} else {
				contentText += "```json\n" + json + "\n```";
			}

			const details: Record<string, unknown> = {
				success: true,
				searcher: searcherName,
				total_returned: totalReturned,
			};

			if (resultsTruncated || truncation.truncated) {
				details.truncated = true;
				if (fullOutputPath) {
					details.fullOutputPath = fullOutputPath;
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: contentText,
					},
				],
				details,
			};
		},

		// Custom rendering of the tool call (shown before/during execution)
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("rg "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.directory && args.directory !== ".") {
				text += theme.fg("muted", ` in ${args.directory}`);
			}
			return new Text(text, 0, 0);
		},

		// Custom rendering of the tool result (Bug 4 fix)
		renderResult(
			result,
			{ expanded, isPartial }: { expanded?: boolean; isPartial?: boolean },
			theme,
			_context,
		) {
			const details = result.details as
				| {
						total_returned?: number;
						searcher?: string;
						truncated?: boolean;
						fullOutputPath?: string;
						success?: boolean;
				  }
				| undefined;

			// Handle streaming/partial results
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
			}

			// Error results
			if (!details || details.success === false) {
				const content = result.content[0];
				if (content?.type === "text") {
					return new Text(theme.fg("error", content.text), 0, 0);
				}
				return new Text(theme.fg("error", "Search failed"), 0, 0);
			}

			// No matches
			if (!details.total_returned || details.total_returned === 0) {
				return new Text(theme.fg("dim", "No matches found"), 0, 0);
			}

			// Build result display
			let text = theme.fg("success", `${details.total_returned} matches`);
			text += theme.fg("muted", ` (${details.searcher ?? "?"})`);

			// Show truncation warning if applicable
			if (details.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			// In expanded view, show up to 20 lines of the JSON output
			if (expanded && details.total_returned > 0) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 20);
					for (const line of lines) {
						text += "\n" + theme.fg("dim", line);
					}
					if (content.text.split("\n").length > 20) {
						text += "\n" + theme.fg("muted", "... (use read tool to see full output)");
					}
				}

				// Show temp file path if truncated
				if (details.fullOutputPath) {
					text += "\n" + theme.fg("dim", `Full output: ${details.fullOutputPath}`);
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
