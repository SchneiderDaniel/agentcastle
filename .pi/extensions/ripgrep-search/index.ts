/**
 * ripgrep-search entry point: registrations, events, execute, render.
 * Business logic extracted to submodules (config, args, parse, validate, temp).
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
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { RgResult, SearchConfig } from "./types.ts";
import { loadSearchConfig, resolveBackend, ripgrepAvailable } from "./config.ts";
import { buildRgArgs, buildGrepArgs } from "./args.ts";
import { parseVimgrepOutput, parseGrepOutput } from "./parse.ts";
import { validateQuery } from "./validate.ts";
import { registerTempDir, cleanupTrackedTempDirs } from "./temp.ts";

const MAX_TOTAL_RESULTS = 500;

function errResponse(text: string, extra: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text" as const, text }],
		details: { success: false, error: text, ...extra } as Record<string, unknown>,
		isError: true,
	};
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

async function buildResultResponse(
	searchResult: RgResult,
	searcherName: string,
	query: string,
	directory: string,
	rawStdout: string | undefined,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
	const totalReturned = searchResult.total_returned;
	const resultsTruncated = searchResult.truncated ?? false;
	const json = JSON.stringify(searchResult, null, 2);
	const truncation = truncateHead(json, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	let fullOutputPath: string | undefined;
	if (resultsTruncated || truncation.truncated) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-ripgrep-"));
		registerTempDir(tempDir);
		const fop = join(tempDir, "full-output.txt");
		fullOutputPath = fop;
		await withFileMutationQueue(fop, async () => {
			await writeFile(fop, rawStdout ?? "", "utf8");
		});
	}

	let text = `${searcherName} search results for query: ${query}\nDirectory: ${directory}\nMatches returned: ${totalReturned}\n\n`;
	if (truncation.truncated) {
		text += truncation.content;
		const tl = truncation.totalLines,
			ol = truncation.outputLines;
		const tb = truncation.totalBytes,
			ob = truncation.outputBytes;
		text += `\n\n[Output truncated: showing ${ol} of ${tl} lines (${formatSize(ob)} of ${formatSize(tb)}).`;
		text += ` ${tl - ol} lines (${formatSize(tb - ob)}) omitted.`;
		text += fullOutputPath ? ` Full output saved to: ${fullOutputPath}]` : "]";
	} else if (resultsTruncated) {
		text += json;
		text += `\n\n[Showing first ${MAX_TOTAL_RESULTS} of ${totalReturned} results. Full output saved to: ${fullOutputPath}]`;
	} else {
		text += "```json\n" + json + "\n```";
	}
	const details: Record<string, unknown> = {
		success: true,
		searcher: searcherName,
		total_returned: totalReturned,
	};
	if (resultsTruncated || truncation.truncated) {
		details.truncated = true;
		if (fullOutputPath) details.fullOutputPath = fullOutputPath;
	}
	return { content: [{ type: "text" as const, text }], details };
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
			"Output: { total_returned, results: [{ file, line, column, text }] }. " +
			"Respects .gitignore natively. Requires ripgrep installed.",
		promptSnippet: "Search codebase for literal text or regex using ripgrep",
		promptGuidelines: [
			"Use ripgrep_search for literal text searches — magic numbers, hardcoded strings, error messages, TODOs, configuration values.",
			"Do NOT use ripgrep_search for class/def/function definitions or structural patterns. Use ranked_map or structural_search instead.",
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
				const isPathError = [/No such file or directory/i, /ENOENT/i, /not found/i].some((p) =>
					p.test(stderr),
				);
				const isMissingTool =
					[/command not found/i, /not recognized/i, /internal error/i].some((p) =>
						p.test(stderr),
					) || !stderr.trim();
				let errorText: string;
				if (isPathError)
					errorText = `${searcherName} failed (exit ${result.code}): ${stderr}\nDirectory "${directory}" not found or inaccessible.`;
				else if (isMissingTool)
					errorText = `${searcherName} failed (exit ${result.code}): ${stderr || "unknown error"}\n\nEnsure ${engineStr} installed.`;
				else errorText = `${searcherName} failed (exit ${result.code}): ${stderr}`;
				return errResponse(errorText, {
					exitCode: result.code,
					stderr: result.stderr,
					searcher: searcherName,
				});
			}

			const searchResult = useRipgrep
				? parseVimgrepOutput(result.stdout, MAX_TOTAL_RESULTS)
				: parseGrepOutput(result.stdout, MAX_TOTAL_RESULTS);
			return buildResultResponse(searchResult, searcherName, query, directory, result.stdout);
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
