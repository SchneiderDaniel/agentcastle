/**
 * ranked-map — Keyword scoring, recency scoring, and file ranking
 *
 * Pure module — no pi SDK imports.
 * Computes keyword relevance scores, recency decay scores, and combines
 * them into ranked file list with token budget enforcement.
 */

import type { SymbolEntry, RankedFileScore } from "./types.ts";
import { estimateTokens, formatSymbols } from "./format.ts";

/**
 * Compute keyword relevance scores per file using Jaccard overlap.
 *
 * For each file, score = matchedTerms / queryTerms (fraction of query terms present in file).
 * Returns 0 for files with no matches.
 */
export function computeKeywordScores(
	fileTermMatches: Record<string, string[]>,
	queryTerms: string[],
): Record<string, number> {
	const scores: Record<string, number> = {};
	const totalTerms = queryTerms.length;

	for (const [file, matched] of Object.entries(fileTermMatches)) {
		scores[file] = totalTerms > 0 ? matched.length / totalTerms : 0;
	}

	return scores;
}

/**
 * Compute recency scores using linear decay.
 *
 * Score = max(0, 1 - ageInDays / windowDays)
 * - file touched today → score 1.0
 * - file touched at windowDays boundary → ~0.0
 * - file never touched → score 0.0
 */
export function computeRecencyScores(
	fileLastTouched: Record<string, string>,
	windowDays: number,
	now: Date = new Date(),
): Record<string, number> {
	const scores: Record<string, number> = {};
	const nowMs = now.getTime();

	for (const [file, dateStr] of Object.entries(fileLastTouched)) {
		const fileDate = new Date(dateStr);
		const ageMs = nowMs - fileDate.getTime();
		const ageDays = ageMs / (1000 * 60 * 60 * 24);

		if (windowDays <= 0) {
			// When window is 0, only files touched on same calendar day get 1.0
			const todayStr = now.toISOString().split("T")[0];
			const fileDateStr = dateStr.split("T")[0];
			scores[file] = fileDateStr === todayStr ? 1.0 : 0.0;
		} else if (ageDays <= 0) {
			scores[file] = 1.0;
		} else if (ageDays >= windowDays) {
			scores[file] = 0.0;
		} else {
			scores[file] = Math.round((1 - ageDays / windowDays) * 100) / 100;
		}
	}

	return scores;
}

/**
 * Rank files by combined score (weighted sum of keyword + recency),
 * sort descending, and fill within token budget (greedy).
 */
export function rankFiles(
	keywordScores: Record<string, number>,
	recencyScores: Record<string, number>,
	weights: { keyword: number; recency: number },
	tokenBudget: number,
	symbolEntries: Record<string, SymbolEntry[]>,
): { files: RankedFileScore[]; totalTokens: number; truncated: boolean } {
	const allFiles = new Set([
		...Object.keys(keywordScores),
		...Object.keys(recencyScores),
		...Object.keys(symbolEntries),
	]);

	type FileScore = { path: string; score: number; symbols: SymbolEntry[] };
	const scored: FileScore[] = [];

	for (const file of allFiles) {
		const kw = keywordScores[file] ?? 0;
		const rec = recencyScores[file] ?? 0;
		const syms = symbolEntries[file] ?? [];
		const score = kw * weights.keyword + rec * weights.recency;
		scored.push({ path: file, score: Math.round(score * 100) / 100, symbols: syms });
	}

	// Sort descending by score, tie-break by path alphabetically
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.path.localeCompare(b.path);
	});

	const files: RankedFileScore[] = [];
	let totalTokens = 0;
	let truncated = false;

	const PREVIEW_TOKEN_ESTIMATE = 50;

	for (const entry of scored) {
		const symText = formatSymbols(entry.symbols, entry.path);
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
			path: entry.path,
			score: entry.score,
			symbols: symText,
			preview: "",
		});
		totalTokens += entryTokens;
	}

	return { files, totalTokens, truncated };
}
