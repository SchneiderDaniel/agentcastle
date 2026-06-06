/**
 * ripgrep-search entry point: registrations, events, execute, render.
 * Business logic extracted to submodules (config, args, parse) and internal.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { RgResult, SearchConfig } from "./types.ts";
import { loadSearchConfig, resolveBackend, ripgrepAvailable } from "./config.ts";
import { buildRgArgs, buildGrepArgs } from "./args.ts";
import { parseVimgrepOutput, parseGrepOutput } from "./parse.ts";
import {
	validateQuery,
	registerTempDir,
	cleanupTrackedTempDirs,
	getCachedResult,
	setCachedResult,
	clearCache,
} from "./internal.ts";

const MAX_TOTAL_RESULTS = 500;
const DEFAULT_DISPLAY_RESULTS = 10;
const MAX_LINE_LENGTH = 500; // truncate individual match lines to prevent context-window blowup

function errResponse(text: string, extra: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details: { success: false, error: text, ...extra } as Record<string, unknown>,
		isError: true,
	};
}

export function buildSearchErrorText(
	searcherName: string,
	exitCode: number | null,
	killed: boolean | undefined,
	stderr: string,
	engineStr: string,
	directory: string,
): string {
	const isMissingTool = [/command not found/i, /not recognized/i, /internal error/i].some((p) =>
		p.test(stderr),
	);
	const isPathError = [/No such file or directory/i, /ENOENT/i, /not found/i].some((p) =>
		p.test(stderr),
	);
	let errorText: string;
	if (killed) {
		errorText = `${searcherName} process killed (exit ${exitCode}).`;
	} else if (!stderr.trim()) {
		errorText = `${searcherName} failed (exit ${exitCode}) with no error output.`;
	} else if (isMissingTool) {
		errorText = `${searcherName} failed (exit ${exitCode}): ${stderr}\n\nEnsure ${engineStr} installed.`;
	} else if (isPathError) {
		errorText = `${searcherName} failed (exit ${exitCode}): ${stderr}\nDirectory "${directory}" not found or inaccessible.`;
	} else {
		errorText = `${searcherName} failed (exit ${exitCode}): ${stderr}`;
	}
	return errorText;
}

async function verifyDirectory(
	cwd: string,
	directory: string,
): Promise<
	{ ok: true; resolvedDir: string } | { ok: false; response: ReturnType<typeof errResponse> }
> {
	const resolvedDir = resolve(cwd, directory);
	try {
		const dirStat = await stat(resolvedDir);
		if (!dirStat.isDirectory())
			return { ok: false, response: errResponse(`"${directory}" is a file, not a directory.`) };
		return { ok: true, resolvedDir };
	} catch (err: unknown) {
		const nodeErr = err as { code?: string };
		if (nodeErr.code === "ENOENT") {
			let validDirs: string[] = [];
			try {
				const entries = await readdir(cwd, { withFileTypes: true });
				validDirs = entries
					.filter((e) => e.isDirectory())
					.map((e) => e.name + "/")
					.sort();
			} catch {
				/* ignore */
			}
			const dirList = validDirs.length > 0 ? ` Valid directories: ${validDirs.join(", ")}` : "";
			return {
				ok: false,
				response: errResponse(`Directory "${directory}" not found in project root.${dirList}`),
			};
		}
		if (nodeErr.code === "ENOTDIR")
			return { ok: false, response: errResponse(`"${directory}" is a file, not a directory.`) };
		return { ok: true, resolvedDir };
	}
}

/**
 * Build a structured human-readable summary of search results.
 * Replaces the old JSON output format with a concise summary
 * showing top-N results, truncated indicator, and file counts.
 */
export function buildStructuredSummary(
	searchResult: RgResult,
	searcherName: string,
	query: string,
	directory: string,
	maxDisplay: number = DEFAULT_DISPLAY_RESULTS,
): { text: string; details: Record<string, unknown> } {
	const totalReturned = searchResult.total_returned;

	if (totalReturned === 0) {
		return {
			text: `No matches found for query "${query}" in "${directory}" (${searcherName}).`,
			details: { success: true, total_returned: 0, searcher: searcherName },
		};
	}

	// Count unique files
	const uniqueFiles = new Set(searchResult.results.map((r) => r.file));

	let text = `${searcherName} search results for query: ${query}\n`;
	text += `Directory: ${directory}\n`;
	text += `Matches returned: ${totalReturned}`;
	text += ` across ${uniqueFiles.size} file${uniqueFiles.size !== 1 ? "s" : ""}\n\n`;

	// Show top-N results (each line truncated to MAX_LINE_LENGTH for safety)
	const displayResults = searchResult.results.slice(0, maxDisplay);
	for (let i = 0; i < displayResults.length; i++) {
		const r = displayResults[i]!;
		const truncatedText =
			r.text.length > MAX_LINE_LENGTH
				? r.text.slice(0, MAX_LINE_LENGTH) + "... [truncated]"
				: r.text;
		text += `${i + 1}. ${r.file}:${r.line}:${r.column}:${truncatedText}\n`;
	}

	const resultsTruncated = totalReturned > maxDisplay;
	let truncatedIndicator = "";
	if (resultsTruncated) {
		truncatedIndicator = `\n[Showing first ${maxDisplay} of ${totalReturned} results across ${uniqueFiles.size} file${uniqueFiles.size !== 1 ? "s" : ""}.`;
		text += truncatedIndicator;
	}

	const details: Record<string, unknown> = {
		success: true,
		searcher: searcherName,
		total_returned: totalReturned,
		unique_files: uniqueFiles.size,
		truncated: resultsTruncated,
	};

	return { text, details };
}

/**
 * Save oversized raw output to a temp file and return the path.
 */
async function saveOversizedOutput(rawStdout: string | undefined): Promise<string | undefined> {
	if (!rawStdout) return undefined;
	const tempDir = await mkdtemp(join(tmpdir(), "pi-ripgrep-"));
	registerTempDir(tempDir);
	const fop = join(tempDir, "full-output.txt");
	await writeFile(fop, rawStdout, "utf8");
	return fop;
}

export default function ripgrepSearch(pi: ExtensionAPI): void {
	let rgAvailable: boolean | null = null;
	let searchConfig: SearchConfig | null = null;
	let backendNoteInjected = false;

	pi.on("session_start", async (_event, ctx) => {
		searchConfig = loadSearchConfig(ctx.cwd);
		rgAvailable = searchConfig.searchBackend !== "grep" ? await ripgrepAvailable(pi.exec) : false;
		backendNoteInjected = false;
	});

	pi.on("session_shutdown", async () => {
		await cleanupTrackedTempDirs(rm);
		clearCache();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!event.systemPromptOptions?.selectedTools?.includes("ripgrep_search")) return;
		if (backendNoteInjected) return;
		const config = searchConfig ?? { searchBackend: "auto" as const, maxLineLength: 200 };
		const resolved = resolveBackend(config, rgAvailable ?? false);
		const suffix =
			resolved.backend === "ripgrep"
				? `ripgrep${config.searchBackend === "ripgrep" ? " (user-configured)" : ""} — .gitignore respected, column offsets available`
				: `grep${config.searchBackend === "grep" ? " (user-configured)" : " (fallback)"} — .gitignore NOT respected, column always 1, excluded dirs: .git,node_modules,venv,__pycache__,.mypy_cache,.pytest_cache,dist,build`;
		backendNoteInjected = true;
		return { systemPrompt: event.systemPrompt + `\n[Search backend: ${suffix}]` };
	});

	pi.registerTool({
		name: "ripgrep_search",
		label: "Ripgrep Search",
		description:
			"Search codebase for literal text or regex using ripgrep. " +
			"Output: structured summary with top-N results, file counts, and truncation. " +
			"Respects .gitignore natively.",
		promptSnippet: "Search codebase for literal text or regex using ripgrep",
		promptGuidelines: [
			"Use ripgrep_search for literal text searches — magic numbers, hardcoded strings, error messages, TODOs, configuration values.",
			"ripgrep_search respects .gitignore natively. Default max_count=10 (per file). Default directory='.'.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Literal text/regex. Rejects class/def/function/$/{ patterns — use structural_search/ranked_map instead.",
			}),
			directory: Type.Optional(Type.String({ default: "." })),
			max_count: Type.Optional(Type.Number({ default: 10 })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query;
			const directory = params.directory ?? ".";
			const maxCount = params.max_count ?? 10;

			const validationError = validateQuery(query);
			if (validationError) return errResponse(validationError);

			const dirCheck = await verifyDirectory(ctx.cwd, directory);
			if (!dirCheck.ok) return dirCheck.response;

			const config = searchConfig ?? loadSearchConfig(ctx.cwd);
			searchConfig = config;
			if (rgAvailable === null) rgAvailable = await ripgrepAvailable(pi.exec);

			const resolved = resolveBackend(config, rgAvailable);
			if (resolved.error) return errResponse(resolved.error);

			const useRipgrep = resolved.backend === "ripgrep";
			const searcherName = useRipgrep ? "ripgrep" : "grep";

			// Check cache first
			const cached = getCachedResult(query, directory);
			if (cached) {
				const summary = buildStructuredSummary(
					cached.result,
					searcherName,
					query,
					directory,
					maxCount,
				);
				return {
					content: [{ type: "text" as const, text: summary.text }],
					details: summary.details as Record<string, unknown>,
				};
			}

			const { command, args } = useRipgrep
				? buildRgArgs(query, directory, maxCount, config.maxLineLength)
				: buildGrepArgs(query, directory, maxCount);

			const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 30_000, signal });

			if (result.code !== 0) {
				if (result.code === 1) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No matches found for query "${query}" in "${directory}" (${searcherName}).`,
							},
						],
						details: { success: true, total_returned: 0, searcher: searcherName } as Record<
							string,
							unknown
						>,
					};
				}
				const stderr = result.stderr || "";
				const engineStr = useRipgrep ? "ripgrep (`rg --version`)" : "grep";

				const errorText = buildSearchErrorText(
					searcherName,
					result.code,
					result.killed,
					stderr,
					engineStr,
					directory,
				);
				return errResponse(errorText, {
					exitCode: result.code,
					stderr: result.stderr,
					searcher: searcherName,
				});
			}

			const searchResult = useRipgrep
				? parseVimgrepOutput(result.stdout, MAX_TOTAL_RESULTS)
				: parseGrepOutput(result.stdout, MAX_TOTAL_RESULTS);

			// Cache the result
			setCachedResult(query, directory, {
				result: searchResult,
				rawStdout: result.stdout ?? "",
			});

			const summary = buildStructuredSummary(
				searchResult,
				searcherName,
				query,
				directory,
				maxCount,
			);

			// Save oversized output to temp file if truncated
			let fullOutputPath: string | undefined;
			if (searchResult.truncated) {
				fullOutputPath = await saveOversizedOutput(result.stdout);
			}

			let text = summary.text;
			const details: Record<string, unknown> = {
				...summary.details,
			};
			if (fullOutputPath) {
				text += ` Full output saved to: ${fullOutputPath}]`;
				details.truncated = true;
				details.fullOutputPath = fullOutputPath;
			} else if (searchResult.truncated) {
				text += " Full output not available]";
			}

			return {
				content: [{ type: "text" as const, text }],
				details,
			};
		},
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("rg "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.directory && args.directory !== ".")
				text += theme.fg("muted", ` in ${args.directory}`);
			return new Text(text, 0, 0);
		},
		renderResult(
			result,
			{ expanded, isPartial }: { expanded?: boolean; isPartial?: boolean },
			theme,
			_context,
		) {
			const d = result.details as
				| {
						total_returned?: number;
						searcher?: string;
						truncated?: boolean;
						fullOutputPath?: string;
						success?: boolean;
				  }
				| undefined;
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			if (!d || d.success === false)
				return new Text(
					theme.fg("error", (result.content[0] as { text?: string })?.text ?? "Search failed"),
					0,
					0,
				);
			if (!d.total_returned) return new Text(theme.fg("dim", "No matches found"), 0, 0);
			let text = theme.fg("success", `${d.total_returned} matches`);
			text += theme.fg("muted", ` (${d.searcher ?? "?"})`);
			if (d.truncated) text += theme.fg("warning", " [truncated]");
			if (expanded) {
				const c = result.content[0] as { text?: string } | undefined;
				if (c?.text) {
					const lines = c.text.split("\n").slice(0, 20);
					for (const line of lines) text += "\n" + theme.fg("dim", line);
					if (c.text.split("\n").length > 20)
						text += "\n" + theme.fg("muted", "... (use read tool to see full output)");
				}
				if (d.fullOutputPath) text += "\n" + theme.fg("dim", `Full output: ${d.fullOutputPath}`);
			}
			return new Text(text, 0, 0);
		},
	});
}
