/**
 * ranked-map — Output formatting and mode selection
 *
 * Pure module — no pi SDK imports.
 * Token estimation, mode selection, full dump, symbol formatting, output shaping.
 */

import type { SymbolEntry, RankedEntry, RankedFileScore, RankedMapResult } from "./types.ts";

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
 * Build output array from ranked entries under a token budget (greedy fill).
 *
 * Shared helper used by both dumpAllFiles() and rankFiles() to avoid
 * duplicating the budget-checking logic.
 *
 * For each entry:
 * 1. Format symbols via formatSymbols() and estimate tokens (+ PREVIEW_TOKEN_ESTIMATE).
 * 2. If tokenBudget <= 0 → set truncated = true and break.
 * 3. If adding entry would exceed budget (and totalTokens > 0) → set truncated = true and break.
 * 4. Push entry with path, score, symbols (formatted), and empty preview.
 * 5. Accumulate totalTokens.
 */
export function buildOutputFromEntries(
	entries: RankedEntry[],
	tokenBudget: number,
): { files: RankedFileScore[]; totalTokens: number; truncated: boolean } {
	const files: RankedFileScore[] = [];
	let totalTokens = 0;
	let truncated = false;
	const PREVIEW_TOKEN_ESTIMATE = 50;

	for (const entry of entries) {
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

/**
 * Dump all symbols sorted by file path, filling greedily within token budget.
 * Each file gets score=0 and empty preview. Delegates to buildOutputFromEntries().
 */
export function dumpAllFiles(
	symbols: Record<string, SymbolEntry[]>,
	tokenBudget: number,
): { files: RankedFileScore[]; totalTokens: number; truncated: boolean } {
	const entries: RankedEntry[] = Object.entries(symbols)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([path, syms]) => ({ path, score: 0, symbols: syms ?? [] }));
	return buildOutputFromEntries(entries, tokenBudget);
}

/**
 * Check whether a symbol kind is high-signal and should be listed individually.
 * High-signal kinds: class, function, method, interface, type, enum.
 * Low-signal kinds (constant, variable, property, member, other, empty) are
 * summarized by count only.
 */
export function isHighSignalKind(kind: string): boolean {
	switch (kind) {
		case "class":
		case "function":
		case "method":
		case "interface":
		case "type":
		case "enum":
			return true;
		default:
			return false;
	}
}

/** Pluralize a symbol kind for summary display. */
function pluralizeKind(kind: string, count: number): string {
	if (count === 1) return kind;
	// Simple English plural: add "es" for words ending in s, x, ch, sh
	if (/[sxchsh]$/i.test(kind)) return kind + "es";
	return kind + "s";
}

/**
 * Format symbol entries into a compact string for tool output.
 *
 * Produces a summary line with per-kind counts, then individual lines for
 * high-signal kinds (class, function, method, interface, type, enum).
 * Low-signal kinds (constant, variable, property, member, etc.) appear
 * only in the summary count.
 *
 * Examples:
 *   src/foo.ts
 *   4 symbol(s): 1 class, 1 function, 2 constants
 *     class UserModel
 *     function get_user
 */
export function formatSymbols(symbols: SymbolEntry[], path: string): string {
	if (!symbols) symbols = [];
	if (symbols.length === 0) return `${path}\n  (no symbols)`;

	// Count by kind
	const kindCounts = new Map<string, number>();
	for (const sym of symbols) {
		const kind = sym.type || "";
		kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
	}

	// Filter out entries with empty type
	const nonEmptyKinds = [...kindCounts.entries()].filter(([kind]) => kind !== "");

	if (nonEmptyKinds.length === 0) return `${path}\n  (no symbols)`;

	// Build summary — sort kinds alphabetically for deterministic output
	const totalSymbols = symbols.length;
	nonEmptyKinds.sort(([a], [b]) => a.localeCompare(b));
	const summaryParts: string[] = [];
	for (const [kind, count] of nonEmptyKinds) {
		summaryParts.push(`${count} ${pluralizeKind(kind, count)}`);
	}
	const symbolLabel = totalSymbols === 1 ? "symbol" : "symbols";
	const summary = `${totalSymbols} ${symbolLabel}: ${summaryParts.join(", ")}`;

	// Build individual lines for high-signal symbols
	const highSignalLines: string[] = [];
	for (const sym of symbols) {
		if (isHighSignalKind(sym.type)) {
			highSignalLines.push(`  ${sym.type} ${sym.name}`);
		}
	}

	if (highSignalLines.length === 0) {
		return `${path}\n  ${summary}`;
	}

	return `${path}\n  ${summary}\n${highSignalLines.join("\n")}`;
}

/**
 * Get a structural overview of the repository — one representative file
 * per top-level directory. Used in recency-only mode to ensure the agent
 * sees at least one file from each top-level directory.
 *
 * Returns entries with score: 0.1 (low but non-zero, so they appear at
 * the bottom of ranked results) and empty preview.
 */
export function getStructuralOverview(filePaths: string[]): { path: string; score: number }[] {
	const seen = new Set<string>();
	const overview: { path: string; score: number }[] = [];

	for (const filePath of filePaths) {
		// Normalize: strip leading ./ if present
		const normalized = filePath.startsWith("./") ? filePath.slice(2) : filePath;

		// Get top-level directory
		const slashIdx = normalized.indexOf("/");
		const topDir = slashIdx === -1 ? normalized : normalized.slice(0, slashIdx);

		if (!seen.has(topDir)) {
			seen.add(topDir);
			overview.push({ path: filePath, score: 0.1 });
		}
	}

	return overview;
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
