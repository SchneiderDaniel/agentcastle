import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { loadRankedMapConfig } from "./config.ts";
import { RankedMapEngine } from "./engine.ts";

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
			"Set `tokenBudget` to control output size (default 4096 tokens). Smaller budget = fewer files = faster response.",
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
					default: 4096,
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
			const exec = pi.exec.bind(pi);

			const engine = new RankedMapEngine(config, exec, cwd);

			// Phase 1: Build or load symbol index
			let index;
			try {
				index = await engine.buildOrLoadIndex(targetDir, cacheDir, signal);
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

			// Phase 2: Rank/dump files
			const ranked = await engine.rank(index, query, budget, signal);

			// Phase 3: Add file previews (ranked mode only) — pass index for pattern-based preview
			const filesWithPreviews = engine.addPreviews(ranked.files, targetDir, ranked.mode, index);

			// Phase 4: Format output
			const output = engine.format(filesWithPreviews, budget, ranked.truncated, ranked.mode);

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
