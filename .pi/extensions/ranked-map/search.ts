/**
 * ranked-map — Keyword search via ripgrep
 *
 * Adapter module — uses ExecFn (pi.exec compatible) for subprocess execution.
 * Fully async with AbortSignal support.
 *
 * Provides two search modes:
 * - runKeywordSearch: binary per-term matching (rg --files-with-matches)
 * - runFrequencySearch: frequency-weighted matching (rg --count-matches)
 */

import { normalize } from "node:path";
import type { ExecFn } from "./types.ts";

/**
 * Run rg --files-with-matches for each query term and return matched terms per file.
 *
 * Uses the provided exec function (typically pi.exec) instead of execSync,
 * supporting AbortSignal for cancellation and timeout.
 */
/**
 * Run rg --files-with-matches for each query term and return matched terms per file.
 *
 * Uses binary matching: a file either matches a term or doesn't.
 * Returns which terms each file matched.
 *
 * Uses the provided exec function (typically pi.exec) instead of execSync,
 * supporting AbortSignal for cancellation and timeout.
 */
export async function runKeywordSearch(
	exec: ExecFn,
	query: string,
	directory: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ fileMatches: Record<string, string[]>; terms: string[] }> {
	const fileMatches: Record<string, string[]> = {};
	const terms = query.trim().split(/\s+/).filter(Boolean);

	if (terms.length === 0) return { fileMatches: {}, terms: [] };

	for (const term of terms) {
		// Escape regex special chars for literal search
		const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const result = await exec(
			"rg",
			["--files-with-matches", "--ignore-case", "--no-messages", escaped, directory],
			{ cwd, timeout: 15_000, signal },
		);
		// rg returns non-zero exit if no matches — not an error; skip silently
		if (result.code !== 0) continue;

		const matchedFiles = result.stdout.trim().split("\n").filter(Boolean);

		for (const file of matchedFiles) {
			// Normalize path to strip ./ prefix and resolve .. segments.
			// rg with target directory '.' returns paths as ./src/foo.ts,
			// while ctags and git return paths without prefix (src/foo.ts).
			// Normalizing ensures consistent keys across all sources.
			const normalizedPath = normalize(file);
			if (!fileMatches[normalizedPath]) {
				fileMatches[normalizedPath] = [];
			}
			fileMatches[normalizedPath]!.push(term);
		}
	}

	return { fileMatches, terms };
}

/**
 * Run rg --count-matches for expanded query terms and return match counts per file.
 *
 * Uses frequency-weighted matching via rg's --count-matches flag.
 * For each expanded query term (regex pattern), rg returns per-file match counts.
 * Results are aggregated across all expanded terms into a total count per file.
 *
 * This penalizes files that merely mention a term once (e.g. in a comment or CDN URL)
 * vs files where terms are central (multiple occurrences across code).
 *
 * @param exec - ExecFn for subprocess execution
 * @param expandedTerms - Array of expanded regex patterns (one per query term)
 * @param directory - Target directory for rg scope
 * @param cwd - Working directory
 * @param signal - Optional AbortSignal for cancellation
 * @returns Object with fileCounts map and the expanded terms array
 */
export async function runFrequencySearch(
	exec: ExecFn,
	expandedTerms: string[],
	directory: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ fileCounts: Record<string, number>; terms: string[] }> {
	const fileCounts: Record<string, number> = {};

	if (expandedTerms.length === 0) return { fileCounts: {}, terms: [] };

	for (const pattern of expandedTerms) {
		// rg --count-matches produces per-file match counts: "filepath:count"
		// With regex pattern (from query expansion), count includes all variants.
		const result = await exec(
			"rg",
			["--count-matches", "--ignore-case", "--no-messages", pattern, directory],
			{ cwd, timeout: 15_000, signal },
		);

		// rg returns non-zero exit if no matches — not an error; skip silently
		if (result.code !== 0) continue;

		const lines = result.stdout.trim().split("\n").filter(Boolean);

		for (const line of lines) {
			// Parse "filepath:count" format
			// Use last colon in case filepath contains colons (unlikely but safe)
			const colonIdx = line.lastIndexOf(":");
			if (colonIdx === -1) continue;

			const rawPath = line.slice(0, colonIdx);
			const countStr = line.slice(colonIdx + 1);
			const count = parseInt(countStr, 10);

			if (isNaN(count) || count <= 0) continue;

			const normalizedPath = normalize(rawPath);
			fileCounts[normalizedPath] = (fileCounts[normalizedPath] ?? 0) + count;
		}
	}

	return { fileCounts, terms: expandedTerms };
}
