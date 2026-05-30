import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { CachedIndex, RankedFileScore } from "./types.ts";
import { loadRankedMapConfig } from "./config.ts";
import { buildCtagsArgs, buildSymbolIndex } from "./ctags.ts";
import { loadCachedIndex } from "./cache.ts";
import { selectMode, dumpAllFiles, formatOutput } from "./format.ts";
import { computeKeywordScores, computeRecencyScores, rankFiles } from "./scoring.ts";
import { runKeywordSearch } from "./search.ts";
import { runGitRecency, getGitHead } from "./git.ts";

export default function rankedMap(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ranked_map",
		label: "Ranked Repo Map",
		description:
			"Codebase symbol index with auto-mode detection. " +
			"With a query: ranks files by keyword overlap (ripgrep) + git recency scoring. " +
			"Without query on repos ≤ autoThreshold (default 20K symbols): returns all symbols sorted by path (full dump). " +
			"Without query on larger repos: ranks by recency only. " +
			"Output: JSON with files array (path, score, symbols, preview), total_tokens, budget, truncated, mode. " +
			"Replaces the old map_codebase tool — call ranked_map with or without a query for all use cases.",
		promptSnippet:
			"Codebase symbol map with auto-mode: query → ranked, no query + small repo → full dump, no query + large repo → recency-ranked",
		promptGuidelines: [
			"ranked_map replaces map_codebase — use it for all codebase browsing. Auto-mode: pass `query` for ranked results, omit for full dump (small repos) or recency-ranked (large repos).",
			"Pass a `query` describing what you're looking for (e.g. 'login auth token') to rank by keyword relevance. Without query, the tool auto-selects full dump or recency-ranked based on repo size.",
			"Set `tokenBudget` to control output size (default 2048 tokens). Smaller budget = fewer files = faster response.",
			"Configure autoThreshold in .pi/settings.json rankedMap.autoThreshold (default 20000). Set to 0 for always-ranked.",
			"The tool is on-demand (not auto-injected). Call it when you need codebase context, not every turn.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					default: "",
					description:
						"Space-separated query terms for keyword scoring. Uses rg --files-with-matches (case-insensitive, literal search).",
				}),
			),
			tokenBudget: Type.Optional(
				Type.Number({
					default: 2048,
					description:
						"Maximum token budget for output. Greedy fill from highest-ranked file until budget exhausted. Overrides settings.json rankedMap.tokenBudget if provided.",
				}),
			),
			directory: Type.Optional(
				Type.String({
					default: ".",
					description:
						"Target directory for ctags index and rg keyword search. Default: project root. Set to a subdirectory for focused results.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const targetDir = params.directory || ".";
			const query = (params.query || "").trim();
			const config = loadRankedMapConfig(cwd);
			const budget =
				typeof params.tokenBudget === "number" &&
				Number.isFinite(params.tokenBudget) &&
				params.tokenBudget > 0
					? params.tokenBudget
					: config.tokenBudget;
			const cacheDir = join(cwd, ".pi", "cache");
			const cachePath = join(cacheDir, "ranked-map-index.json");
			const exec = pi.exec.bind(pi);

			const currentHead = await getGitHead(exec, cwd, signal);
			let index: CachedIndex | null = currentHead ? loadCachedIndex(cachePath, currentHead) : null;

			if (!index) {
				try {
					if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
					const { command, args } = buildCtagsArgs(targetDir, 0);
					const result = await pi.exec(command, args, { cwd, timeout: 30_000, signal });
					if (result.code !== 0 && (!result.stdout || result.stdout.trim().length === 0)) {
						return {
							content: [
								{
									type: "text" as const,
									text: `ctags failed (exit code ${result.code}): ${result.stderr || "unknown error"}\n\nEnsure universal-ctags is installed with JSON output support.`,
								},
							],
							details: { success: false, exitCode: result.code, stderr: result.stderr } as Record<
								string,
								unknown
							>,
						};
					}
					index = buildSymbolIndex(result.stdout, currentHead || "unknown");
					try {
						writeFileSync(cachePath, JSON.stringify(index), "utf-8");
					} catch {
						/* non-critical */
					}
				} catch (err) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to build symbol index: ${err instanceof Error ? err.message : String(err)}\nEnsure universal-ctags is installed.`,
							},
						],
						details: {
							success: false,
							error: err instanceof Error ? err.message : String(err),
						} as Record<string, unknown>,
					};
				}
			}

			const totalSymbols = Object.values(index.symbols).flat().length;
			const mode = selectMode(query, totalSymbols, config.autoThreshold);
			const modeLabel = mode === "full_dump" ? "full_dump" : "ranked";

			let ranked: { files: RankedFileScore[]; totalTokens: number; truncated: boolean };
			if (mode === "full_dump") {
				ranked = dumpAllFiles(index.symbols, budget);
			} else {
				let keywordScores: Record<string, number> = {};
				if (query) {
					const { fileMatches, terms } = await runKeywordSearch(
						exec,
						query,
						targetDir,
						cwd,
						signal,
					);
					keywordScores = computeKeywordScores(fileMatches, terms);
				}
				const fileDates = await runGitRecency(exec, config.recencyWindowDays, cwd, signal);
				const recencyScores = computeRecencyScores(fileDates, config.recencyWindowDays);
				ranked = rankFiles(keywordScores, recencyScores, config.weights, budget, index.symbols);
			}

			const filesWithPreviews = ranked.files.map((f) => {
				if (mode === "full_dump") return f;
				let preview = "";
				try {
					const fullPath = resolve(cwd, targetDir, f.path);
					if (existsSync(fullPath))
						preview = readFileSync(fullPath, "utf-8").split("\n").slice(0, 5).join("\n");
				} catch {
					/* empty preview */
				}
				return { ...f, preview };
			});

			const output = formatOutput(
				filesWithPreviews,
				budget,
				ranked.truncated,
				modeLabel as "ranked" | "full_dump",
			);
			const symbolCount = Object.values(index.symbols).flat().length;
			const fileCount = Object.keys(index.symbols).length;
			const displayMode =
				output.mode === "full_dump"
					? "full dump"
					: `ranked${query ? ` (query="${query}")` : " (recency-only)"}`;
			const truncatedInfo = output.truncated
				? ` (truncated to ${output.files.length} files)`
				: ` (${output.files.length} files)`;

			return {
				content: [
					{
						type: "text" as const,
						text: `${output.mode === "full_dump" ? "Codebase map" : "Ranked repo map"} for: ${targetDir}\nMode: ${displayMode}, ${output.total_tokens} of ${budget} tokens used${truncatedInfo}\nIndex: ${fileCount} files, ${symbolCount} symbols\n\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``,
					},
				],
				details: {
					success: true,
					config,
					output,
					indexHead: index.head,
					indexBuiltAt: index.builtAt,
				} as Record<string, unknown>,
			};
		},
	});
}
