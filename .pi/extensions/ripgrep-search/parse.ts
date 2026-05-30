/**
 * Output parsers for ripgrep --vimgrep and grep -rnH output.
 *
 * Pure functions — no dependencies on pi SDK or other modules.
 * Imports only types from types.ts.
 */

import type { RgMatch, RgResult } from "./types.ts";

/**
 * Parse raw ripgrep --vimgrep output into RgResult.
 *
 * --vimgrep output format: file:line:column:text
 * Parsed with regex: ^(.+?):(\d+):(\d+):(.*)$
 *
 * Empty input, null, undefined → empty result.
 * Malformed lines (missing colons, non-numeric line/column) → skipped.
 * Lines with colons in the text portion → text is everything after third colon.
 */
export function parseVimgrepOutput(
	raw: string | null | undefined,
	maxResults: number = Infinity,
): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];
	let totalMatches = 0;

	const vimgrepRegex = /^(.+?):(\d+):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(vimgrepRegex);
		if (!match) continue;

		const lineNum = parseInt(match[2]!, 10);
		const column = parseInt(match[3]!, 10);
		if (isNaN(lineNum) || isNaN(column)) continue;

		totalMatches++;

		if (results.length < maxResults) {
			const file = match[1]!;
			const text = match[4]!;
			results.push({
				file,
				line: lineNum,
				column,
				text,
			});
		}
	}

	return {
		total_returned: totalMatches,
		results,
		truncated: totalMatches > maxResults,
	};
}

/**
 * Parse generic grep -rnH output into RgResult.
 * grep -rnH produces: file:line:text
 * Since grep lacks column info,
 * column defaults to 1.
 */
export function parseGrepOutput(
	raw: string | null | undefined,
	maxResults: number = Infinity,
): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];
	let totalMatches = 0;

	// grep -rnH: file:line:text
	// Text may contain colons, so match greedily from start
	const grepRegex = /^(.+?):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(grepRegex);
		if (!match) continue;

		const lineNum = parseInt(match[2]!, 10);
		if (isNaN(lineNum)) continue;

		totalMatches++;

		if (results.length < maxResults) {
			const file = match[1]!;
			const text = match[3]!;
			results.push({
				file,
				line: lineNum,
				column: 1,
				text,
			});
		}
	}

	return {
		total_returned: totalMatches,
		results,
		truncated: totalMatches > maxResults,
	};
}
