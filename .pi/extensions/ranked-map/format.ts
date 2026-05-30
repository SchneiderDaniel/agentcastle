/**
 * ranked-map — Output formatting and mode selection
 *
 * Pure module — no pi SDK imports.
 * Token estimation, mode selection, full dump, symbol formatting, output shaping.
 */

import type { SymbolEntry, RankedFileScore, RankedMapResult } from "./types.ts";

/**
 * Estimate tokens from text (~4 chars per token heuristic).
 * No external dependency needed. ±20% accuracy sufficient for budget guardrail.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Determine tool mode based on query presence, symbol count, and autoThreshold.
 * query provided → ranked (keyword + recency)
 * no query, totalSymbols <= autoThreshold → full_dump (path-sorted)
 * no query, totalSymbols > autoThreshold → ranked (recency-only)
 */
export function selectMode(
	query: string,
	totalSymbols: number,
	autoThreshold: number,
): "ranked" | "full_dump" {
	if (query.trim()) return "ranked";
	if (totalSymbols <= autoThreshold) return "full_dump";
	return "ranked";
}

/**
 * Dump all symbols sorted by file path, filling greedily within token budget.
 * Each file gets score=0 and empty preview.
 */
export function dumpAllFiles(
	symbols: Record<string, SymbolEntry[]>,
	tokenBudget: number,
): { files: RankedFileScore[]; totalTokens: number; truncated: boolean } {
	const filePaths = Object.keys(symbols).sort();
	const files: RankedFileScore[] = [];
	let totalTokens = 0;
	let truncated = false;
	const PREVIEW_TOKEN_ESTIMATE = 50;

	for (const path of filePaths) {
		const syms = symbols[path] ?? [];
		const symText = formatSymbols(syms, path);
		const entryTokens = estimateTokens(symText) + PREVIEW_TOKEN_ESTIMATE;

		if (tokenBudget <= 0) {
			truncated = true;
			break;
		}

		if (totalTokens + entryTokens > tokenBudget && totalTokens > 0) {
			truncated = true;
			break;
		}

		files.push({
			path,
			score: 0,
			symbols: symText,
			preview: "",
		});
		totalTokens += entryTokens;
	}

	return { files, totalTokens, truncated };
}

/**
 * Format symbol entries into a compact string for tool output.
 */
export function formatSymbols(symbols: SymbolEntry[], path: string): string {
	if (!symbols || symbols.length === 0) return `${path}\n  (no symbols)`;

	const lines: string[] = [];
	for (const sym of symbols) {
		lines.push(`  ${sym.type} ${sym.name}`);
	}
	return `${path}\n${lines.join("\n")}`;
}

/**
 * Format ranked results into output shape.
 *
 * Scores are rounded to 2 decimal places.
 * total_tokens is computed from symbols + preview of all ranked files.
 */
export function formatOutput(
	rankedFiles: RankedFileScore[],
	budget: number,
	truncated: boolean,
	mode: "ranked" | "full_dump" = "ranked",
): RankedMapResult {
	return {
		files: rankedFiles.map((f) => ({
			...f,
			score: Math.round(f.score * 100) / 100,
		})),
		total_tokens: rankedFiles.reduce(
			(sum, f) => sum + estimateTokens(f.symbols) + estimateTokens(f.preview),
			0,
		),
		budget,
		truncated,
		mode,
	};
}
