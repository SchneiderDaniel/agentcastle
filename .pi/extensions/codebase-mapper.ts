/**
 * codebase-mapper — Library layer: ctags parsing, grouping, command building.
 *
 * This module exports library functions consumed by ranked-map.ts.
 * Tool registration has been migrated to ranked-map.ts (ranked_map tool).
 * No tool is registered from this module.
 */

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

/** Raw ctags JSONL tag object (only fields we care about). */
export interface CtagsTag {
	_type: string;
	name: string;
	kind: string;
	path: string;
	pattern: string;
	line?: number;
}

/** Processed symbol entry in output tree. */
export interface SymbolEntry {
	type: string;
	name: string;
	line: number;
}

/** Output shape: file path → symbol entries. */
export type CodebaseMap = Record<string, SymbolEntry[]>;

// ═══════════════════════════════════════════════════════════════════════
// Pure Functions (exported for unit testing)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse raw ctags JSONL output into CtagsTag[].
 *
 * ctags --output-format=json emits one JSON object per line.
 * Lines with _type: "ptag" are metadata pseudo-tags — skip them.
 * Lines that are empty, malformed, or missing required fields are skipped.
 */
export function parseCtagsOutput(raw: string): CtagsTag[] {
	if (!raw || typeof raw !== "string") return [];

	const lines = raw.split("\n");
	const tags: CtagsTag[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // skip malformed lines
		}

		if (typeof parsed !== "object" || parsed === null) continue;

		const tag = parsed as Record<string, unknown>;

		// Skip pseudo-tags (metadata like JSON_OUTPUT_VERSION)
		if (tag._type === "ptag") continue;

		// Must have _type: "tag" and required fields
		if (tag._type !== "tag") continue;
		if (typeof tag.name !== "string" || !tag.name) continue;
		if (typeof tag.kind !== "string" || !tag.kind) continue;
		if (typeof tag.path !== "string" || !tag.path) continue;

		// Filter out JSON-value kinds (defense-in-depth against data file noise)
		const NON_CODE_KINDS = new Set(["number", "array", "object", "boolean", "string", "null"]);
		if (NON_CODE_KINDS.has(tag.kind)) continue;

		tags.push({
			_type: "tag",
			name: tag.name,
			kind: tag.kind,
			path: tag.path,
			pattern: typeof tag.pattern === "string" ? tag.pattern : "",
			line: typeof tag.line === "number" ? tag.line : undefined,
		});
	}

	return tags;
}

/**
 * Group parsed tags by file path.
 * Returns Record<filePath, SymbolEntry[]> with entries sorted by line number.
 */
export function groupByFile(tags: CtagsTag[]): CodebaseMap {
	const map: CodebaseMap = {};

	for (const tag of tags) {
		const filePath = tag.path;
		if (!map[filePath]) {
			map[filePath] = [];
		}
		map[filePath]!.push({
			type: tag.kind,
			name: tag.name,
			line: tag.line ?? 0,
		});
	}

	// Sort entries by line number within each file
	for (const filePath of Object.keys(map)) {
		map[filePath]!.sort((a, b) => a.line - b.line);
	}

	return map;
}

/**
 * Primary entry: parse raw ctags stdout → grouped tree.
 */
export function buildCodebaseMap(raw: string): CodebaseMap {
	const tags = parseCtagsOutput(raw);
	return groupByFile(tags);
}

/**
 * Build ctags command arguments.
 *
 * Default excludes: node_modules, .git (common sources of noise).
 * max_depth: 0 = unlimited (ctags default).
 */
export function buildCtagsArgs(
	targetDir: string,
	maxDepth: number,
): { command: string; args: string[] } {
	const args = [
		"-R",
		"--output-format=json",
		"--exclude=node_modules",
		"--exclude=.git",
		"--exclude=*.json",
		"--exclude=*.min.js",
		"--exclude=*.css",
		"--exclude=static",
	];

	if (maxDepth > 0) {
		args.push(`--maxdepth=${maxDepth}`);
	}

	args.push(targetDir);

	return { command: "ctags", args };
}
