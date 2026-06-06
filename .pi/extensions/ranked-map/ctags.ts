/**
 * ranked-map — Ctags parsing and symbol index building
 *
 * Pure module — no pi SDK imports, no async I/O.
 * Parses ctags JSONL output, builds command arguments, constructs symbol index.
 */

import type { CtagsTag, CachedIndex, SymbolEntry } from "./types.ts";

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
 * Build ctags command arguments.
 *
 * Default excludes: node_modules, .git (common sources of noise),
 * plus Q&A data files (*.jsonl), docs (*.md), and large irrelevant dirs.
 * Extra patterns from .piignore can be passed via extraExcludes.
 * max_depth: 0 = unlimited (ctags default).
 */
export function buildCtagsArgs(
	targetDir: string,
	maxDepth: number,
	extraExcludes?: string[],
): { command: string; args: string[] } {
	const excludes = [
		// Standard noise
		"node_modules",
		".git",
		"*.json",
		"*.min.js",
		"*.css",
		"static",
		// Q&A data files — zero code symbols
		"*.jsonl",
		// Docs — no code symbols
		"*.md",
		// Pi agent internals — massive, irrelevant
		// NOTE: ctags --exclude matches against basename only, so no path prefix allowed
		"context",
		"sessions",
		"npm",
		"chromium-deps",
		"crawl4ai-venv",
		// Submodules scanned like any other directory
		// Benchmarks — not source
		"benchmarks",
	];

	// Deduplicate: merge extra excludes from piignore, avoid duplicates
	const seen = new Set(excludes);
	if (extraExcludes) {
		for (const ex of extraExcludes) {
			if (!seen.has(ex)) {
				excludes.push(ex);
				seen.add(ex);
			}
		}
	}

	const args: string[] = ["-R", "--output-format=json", "--tag-relative=always"];

	for (const ex of excludes) {
		args.push(`--exclude=${ex}`);
	}

	if (maxDepth > 0) {
		args.push(`--maxdepth=${maxDepth}`);
	}

	args.push(targetDir);

	return { command: "ctags", args };
}

/**
 * Normalize absolute paths relative to targetDir.
 * If the path starts with targetDir + "/", strip the prefix.
 * Returns the path unchanged if no prefix match or no targetDir.
 */
export function normalizeCtagsPath(path: string, targetDir?: string): string {
	if (!targetDir || !path) return path;
	const prefix = targetDir.endsWith("/") ? targetDir : targetDir + "/";
	if (path.startsWith(prefix)) {
		return path.slice(prefix.length);
	}
	return path;
}

/**
 * Build symbol index from ctags JSONL output.
 * Groups symbols by file path and sorts by line number.
 *
 * When targetDir is provided, absolute paths are normalized to relative
 * by stripping the targetDir prefix. This ensures symbol keys match
 * the relative paths used by git and ripgrep.
 */
export function buildSymbolIndex(
	ctagsJsonl: string,
	head: string,
	now: number = Date.now(),
	targetDir?: string,
): CachedIndex {
	const tags = parseCtagsOutput(ctagsJsonl);
	const symbols: Record<string, SymbolEntry[]> = {};

	for (const tag of tags) {
		const normalizedPath = normalizeCtagsPath(tag.path, targetDir);
		if (!symbols[normalizedPath]) {
			symbols[normalizedPath] = [];
		}
		symbols[normalizedPath]!.push({
			type: tag.kind,
			name: tag.name,
			line: tag.line ?? 0,
			pattern: tag.pattern || undefined,
		});
	}

	// Sort by line number
	for (const file of Object.keys(symbols)) {
		symbols[file]!.sort((a, b) => a.line - b.line);
	}

	return { head, builtAt: now, symbols };
}
