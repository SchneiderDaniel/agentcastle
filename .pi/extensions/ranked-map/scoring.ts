/**
 * ranked-map — Keyword scoring, recency scoring, commit count scoring, and file ranking
 *
 * Pure module — no pi SDK imports.
 * Computes keyword relevance scores (binary and frequency-weighted),
 * recency decay scores, commit count scores, and combines them into
 * ranked file list with token budget enforcement.
 */

import type { SymbolEntry, RankedEntry, RankedFileScore } from "./types.ts";
import { buildOutputFromEntries, estimateTokens, formatSymbols } from "./format.ts";

/**
 * Compute keyword relevance scores per file using binary (Jaccard overlap) matching.
 *
 * For each file, score = matchedTerms / queryTerms (fraction of query terms present in file).
 * Returns 0 for files with no matches.
 *
 * This is the original scoring method. Use computeKeywordScores for frequency-weighted.
 */
export function computeBinaryKeywordScores(
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
 * Compute keyword relevance scores per file using frequency-weighted matching.
 *
 * Uses rg --count-matches output: each file gets a total match count across all
 * expanded query terms. Score = min(1.0, count * scalingFactor).
 *
 * This penalizes files that merely mention a term once vs files where terms are
 * central (multiple occurrences).
 *
 * @param fileCounts - Map of file path → total match count across all expanded terms
 * @param scalingFactor - Multiplier applied to count before capping at 1.0 (default 0.2)
 * @returns Map of file path → keyword score (0 to 1)
 */
export function computeKeywordScores(
	fileCounts: Record<string, number>,
	scalingFactor: number = 0.2,
): Record<string, number> {
	const scores: Record<string, number> = {};

	for (const [file, count] of Object.entries(fileCounts)) {
		const effectiveCount = Math.max(0, count);
		if (effectiveCount === 0) {
			scores[file] = 0;
		} else {
			const raw = Math.min(1.0, effectiveCount * scalingFactor);
			scores[file] = Math.round(raw * 100) / 100;
		}
	}

	return scores;
}

/**
 * Compute commit count scores for files.
 *
 * Files with more git commits over the recency window have more developer
 * attention and are likely more important.
 *
 * Score = min(1.0, commitCount / maxCommitCount)
 * - File with most commits → score 1.0
 * - File with 0 commits → score 0.0
 * - All files same count → all get 1.0
 * - Single file → score 1.0
 *
 * @param commitCounts - Map of file path → commit count
 * @returns Map of file path → commit count score (0 to 1)
 */
export function computeCommitCountScores(
	commitCounts: Record<string, number>,
): Record<string, number> {
	const scores: Record<string, number> = {};
	const counts = Object.values(commitCounts).filter((c) => c > 0);

	if (counts.length === 0) {
		// All zero or empty — all scores 0
		for (const file of Object.keys(commitCounts)) {
			scores[file] = 0;
		}
		return scores;
	}

	const maxCount = Math.max(...counts);

	for (const [file, count] of Object.entries(commitCounts)) {
		const effectiveCount = Math.max(0, count);
		if (effectiveCount === 0) {
			scores[file] = 0;
		} else {
			const raw = Math.min(1.0, effectiveCount / maxCount);
			scores[file] = Math.round(raw * 100) / 100;
		}
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
 * Apply path-aware keyword score boost.
 *
 * Files whose relative path contains any of the expanded query terms
 * get their keyword score boosted by 1.5x (capped at 1.0).
 * This elevates files that are semantically relevant by directory path.
 *
 * Expanded terms are regex alternation groups like "(extension|extensions|extens)".
 * Each alternative is checked individually against the file path (case-insensitive).
 * Files with score ≤ 0 are skipped (no boost for zero or negative scores).
 *
 * @param keywordScores - Map of file path → keyword score (0 to 1)
 * @param expandedTerms - Array of expanded regex patterns, one per query term
 * @returns New map with boosted scores, original input not mutated
 */
export function applyPathBoost(
	keywordScores: Record<string, number>,
	expandedTerms: string[],
): Record<string, number> {
	const boosted: Record<string, number> = {};

	for (const [path, score] of Object.entries(keywordScores)) {
		if (score <= 0) {
			boosted[path] = score;
			continue;
		}

		const pathLower = path.toLowerCase();
		let matched = false;

		for (const term of expandedTerms) {
			if (!term) continue;

			// Strip outer parens and split on | to get individual alternatives
			const inner = term.startsWith("(") && term.endsWith(")") ? term.slice(1, -1) : term;
			const alternatives = inner.split("|");

			for (const alt of alternatives) {
				const clean = alt.replace(/[()|\\]/g, "").toLowerCase();
				if (!clean) continue;
				if (pathLower.includes(clean)) {
					matched = true;
					break;
				}
			}
			if (matched) break;
		}

		if (matched) {
			const raw = Math.min(1.0, score * 1.5);
			boosted[path] = Math.round(raw * 100) / 100;
		} else {
			boosted[path] = score;
		}
	}

	return boosted;
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
 *
 * @param pathOverrides - Optional per-directory prefix penalty overrides (e.g. { ".pi/": 0.7 })
 * @param queryTerms - Optional query terms; if any term matches the file path, penalty is capped at min 0.7
 */
export function applyTestFilePenalty(
	files: { path: string; score: number }[],
	pathOverrides?: Record<string, number>,
	queryTerms?: string[],
): void {
	for (const f of files) {
		if (!isTestFile(f.path)) continue;
		let penalty = TEST_FILE_PENALTY; // default 0.5

		// Check path overrides first
		if (pathOverrides) {
			for (const [prefix, factor] of Object.entries(pathOverrides)) {
				if (f.path.startsWith(prefix)) {
					penalty = factor;
					break;
				}
			}
		}

		// If query terms match the file path, apply a lighter touch
		if (queryTerms) {
			const pathLower = f.path.toLowerCase();
			for (const term of queryTerms) {
				const clean = term.replace(/[()|\\]/g, "").toLowerCase();
				if (pathLower.includes(clean)) {
					penalty = Math.max(0.7, penalty); // cap at 0.7 min
					break;
				}
			}
		}

		f.score = Math.round(f.score * penalty * 100) / 100;
	}
}

/**
 * Rank files by combined score (weighted sum of keyword + recency + fileSize + commitCount),
 * sort descending, and fill within token budget (greedy).
 *
 * Test files (.test., .spec., /test/) receive a 0.5x score penalty
 * so source files rank higher than their corresponding tests.
 *
 * @param fileSizeScores - Optional file size scores from computeFileSizeScores.
 *                         When omitted, fileSize weight contributes 0 to the score.
 * @param commitCountScores - Optional commit count scores from computeCommitCountScores.
 *                            When omitted, commitCount weight contributes 0 to the score.
 */
export function rankFiles(
	keywordScores: Record<string, number>,
	recencyScores: Record<string, number>,
	weights: { keyword: number; recency: number; fileSize?: number; commitCount?: number },
	tokenBudget: number,
	symbolEntries: Record<string, SymbolEntry[]>,
	fileSizeScores?: Record<string, number>,
	commitCountScores?: Record<string, number>,
	testFilePenalties?: Record<string, number>,
	queryTerms?: string[],
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
		const cc = commitCountScores?.[file] ?? 0;
		const fsWeight = weights.fileSize ?? 0;
		const ccWeight = weights.commitCount ?? 0;
		const syms = symbolEntries[file] ?? [];
		const score = kw * weights.keyword + rec * weights.recency + fs * fsWeight + cc * ccWeight;
		scored.push({ path: file, score: Math.round(score * 100) / 100, symbols: syms });
	}

	// Apply test-file penalty before sorting (with optional path overrides and query terms)
	applyTestFilePenalty(scored, testFilePenalties, queryTerms);

	// Sort descending by score, tie-break by path alphabetically
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.path.localeCompare(b.path);
	});

	return buildOutputFromEntries(scored as RankedEntry[], tokenBudget);
}
