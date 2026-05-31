/**
 * ranked-map — Keyword search via ripgrep
 *
 * Adapter module — uses ExecFn (pi.exec compatible) for subprocess execution.
 * Fully async with AbortSignal support.
 */

import { normalize } from "node:path";
import type { ExecFn } from "./types.ts";

/**
 * Run rg --files-with-matches for each query term and return matched terms per file.
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
