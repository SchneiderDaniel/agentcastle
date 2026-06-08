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
 * Compute file size penalty scores.
 *
 * Smaller files get higher scores (closer to 1.0), larger files get lower
 * scores (closer to 0.0). This encourages smaller, more focused files to
 * rank higher than large monolithic files with similar keyword/recency scores.
 *
 * Score formula: score = 1 - (fileSize - minSize) / (maxSize - minSize)
 * - Smallest file → score 1.0
 * - Largest file → score 0.0
 * - All files same size → all get 0 (no penalty distinction)
 * - Single file → score 0
 */
export function computeFileSizeScores(fileSizes: Record<string, number>): Record<string, number> {
	const scores: Record<string, number> = {};
	const sizes = Object.values(fileSizes);

	if (sizes.length === 0) return scores;

	const minSize = Math.min(...sizes);
	const maxSize = Math.max(...sizes);

	// All same size (including single file) → all get 0
	if (maxSize === minSize) {
		for (const file of Object.keys(fileSizes)) {
			scores[file] = 0;
		}
		return scores;
	}

	for (const [file, size] of Object.entries(fileSizes)) {
		scores[file] = Math.round((1 - (size - minSize) / (maxSize - minSize)) * 100) / 100;
	}

	return scores;
}

/**
 * Apply test-file penalty to a set of ranked file scores.
 *
 * Files matching test patterns (.test., .spec., /test/) get their score
 * multiplied by TEST_PENALTY (0.5x). This reduces, but doesn't eliminate,
 * their ranking position — source files rank higher than tests.
 */
const TEST_FILE_PENALTY = 0.5;

/**
 * Pattern for detecting test files:
 * - Contains .test. (e.g. foo.test.ts, foo.test.mts)
 * - Contains .spec. (e.g. foo.spec.ts)
 * - Contains /test/ directory segment (e.g. src/test/foo.ts)
 */
const TEST_FILE_RE = /(\.test\.|\.spec\.|\/test\/)/;

/**
 * Check if a file path matches test-file patterns.
 */
export function isTestFile(path: string): boolean {
	return TEST_FILE_RE.test(path);
}

/**
 * Apply penalty to scores of test files in-place.
 */
export function applyTestFilePenalty(files: { path: string; score: number }[]): void {
	for (const f of files) {
		if (isTestFile(f.path)) {
			f.score = Math.round(f.score * TEST_FILE_PENALTY * 100) / 100;
		}
	}
}

/**
 * Rank files by combined score (weighted sum of keyword + recency + fileSize),
 * sort descending, and fill within token budget (greedy).
 *
 * Test files (.test., .spec., /test/) receive a 0.5x score penalty
 * so source files rank higher than their corresponding tests.
 *
 * @param fileSizeScores - Optional file size scores from computeFileSizeScores.
 *                         When omitted, fileSize weight contributes 0 to the score.
 */
export function rankFiles(
	keywordScores: Record<string, number>,
	recencyScores: Record<string, number>,
	weights: { keyword: number; recency: number; fileSize?: number },
	tokenBudget: number,
	symbolEntries: Record<string, SymbolEntry[]>,
	fileSizeScores?: Record<string, number>,
): { files: RankedFileScore[]; totalTokens: number; truncated: boolean } {
	// Only include files present in the ctags symbol index.
	// Files from keyword search or git recency not in ctags index
	// would show "(no symbols)" in output — filter them out.
	const allFiles = new Set([...Object.keys(symbolEntries)]);

	type FileScore = { path: string; score: number; symbols: SymbolEntry[] };
	const scored: FileScore[] = [];

	for (const file of allFiles) {
		const kw = keywordScores[file] ?? 0;
		const rec = recencyScores[file] ?? 0;
		const fs = fileSizeScores?.[file] ?? 0;
		const fsWeight = weights.fileSize ?? 0;
		const syms = symbolEntries[file] ?? [];
		const score = kw * weights.keyword + rec * weights.recency + fs * fsWeight;
		scored.push({ path: file, score: Math.round(score * 100) / 100, symbols: syms });
	}

	// Apply test-file penalty before sorting
	applyTestFilePenalty(scored);

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
