/**
 * ranked-map — Ignore-file integration (.piignore / .gitignore)
 *
 * Reads .piignore and .gitignore files and converts their patterns to
 * ctags --exclude arguments. Pure module — no pi SDK imports. Zero async I/O.
 *
 * Supports:
 * - Comment lines (#)
 * - Directory patterns (dir/ → --exclude=dir)
 * - Glob patterns (*.ext → --exclude=*.ext)
 * - Path patterns — extracts basename for ctags compat (path/to/dir/ → --exclude=dir)
 * - Negation patterns (!pattern → skipped, ctags can't negate)
 *
 * Not supported (silently skipped):
 * - Negation (!)
 * - Double-star in middle of glob patterns
 * - Leading slash patterns (absolute paths)
 *
 * Supported:
 * - Leading double-star slash prefix (strip prefix, process remainder)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Parse a single ignore-file line into a ctags --exclude pattern.
 * Returns null for lines that can't be converted (comments, negations, empty).
 *
 * Works for both .piignore and .gitignore formats — they use the same
 * gitignore syntax for the patterns we support.
 */
export function parseIgnoreLine(line: string): string | null {
	const trimmed = line.trim();

	// Skip empty lines and comments
	if (!trimmed || trimmed.startsWith("#")) return null;

	// Skip negations (gitignore !pattern) — ctags can't exclude negate
	if (trimmed.startsWith("!")) return null;

	// Strip trailing / if present (gitignore dir pattern)
	let pattern = trimmed;
	if (pattern.endsWith("/")) {
		pattern = pattern.slice(0, -1);
	}

	// Strip trailing /** (gitignore "all contents" indicator)
	if (pattern.endsWith("/**")) {
		pattern = pattern.slice(0, -3);
		if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
	}

	// Strip leading **/ prefix (gitignore "at any depth" indicator)
	// e.g. **/venv/ → venv, **/credentials.* → credentials.*
	// Strip repeatedly to handle patterns like **/**/dir/
	while (pattern.startsWith("**/")) {
		pattern = pattern.slice(3);
	}

	// Ctags --exclude supports globs but not ** in middle of pattern
	// After stripping leading **/, remaining ** means a/**/b or similar — reject.
	// Also reject bare ** (just the globstar).
	// NOTE: check before basename extraction — a/**/b must be rejected
	// even though basename alone ("b") wouldn't contain **.
	if (pattern.includes("**")) return null;

	// Skip patterns with leading / (absolute-style paths)
	// NOTE: check before basename extraction — /absolute/path must be
	// rejected even though basename alone ("path") wouldn't start with /.
	if (pattern.startsWith("/")) return null;

	// Extract basename (last path component) for ctags --exclude compatibility.
	// ctags --exclude matches against basename only, not full path.
	if (pattern.includes("/")) {
		pattern = pattern.split("/").pop()!;
	}

	return pattern || null;
}

/**
 * Read an ignore file (.piignore or .gitignore) and return list of
 * ctags --exclude argument values. Returns empty array if file
 * doesn't exist or can't be read.
 *
 * When scopePrefix is provided, each pattern is prefixed with the scope path
 * to scope the exclude to that subdirectory. This is used for submodule
 * .gitignore files so patterns like __pycache__/ are applied only within
 * the submodule (e.g. flask_blogs/__pycache__) rather than globally.
 *
 * ctags --exclude matches against full path when pattern contains '/',
 * otherwise matches against basename only.
 */
export function buildIgnoreExcludes(ignoreFilePath: string, scopePrefix?: string): string[] {
	try {
		if (!existsSync(ignoreFilePath)) return [];

		const content = readFileSync(ignoreFilePath, "utf-8");
		const lines = content.split("\n");
		const excludes: string[] = [];

		for (const line of lines) {
			const pattern = parseIgnoreLine(line);
			if (pattern) {
				if (scopePrefix) {
					excludes.push(`${scopePrefix}/${pattern}`);
				} else {
					excludes.push(pattern);
				}
			}
		}

		return excludes;
	} catch {
		return [];
	}
}

/**
 * Recursively discover all .gitignore files under rootDir.
 * Excludes .git/ directories to avoid indexing git internals.
 *
 * Optional skipDirs parameter specifies directory basenames to skip
 * during traversal (e.g. ["node_modules", ".venv", "dist"]).
 * These are typically derived from the root .gitignore file and prevent
 * traversal into directories that are already gitignored.
 *
 * Returns absolute paths to each .gitignore file found.
 */
export function discoverIgnoreFiles(rootDir: string, skipDirs?: string[]): string[] {
	const results: string[] = [];
	const skipSet = new Set(skipDirs ?? []);

	try {
		if (!existsSync(rootDir)) return [];

		const entries = readdirSync(rootDir);

		for (const entry of entries) {
			// Skip .git directory and any directories matching skipDirs
			if (entry === ".git") continue;
			if (skipSet.has(entry)) continue;

			const fullPath = join(rootDir, entry);

			try {
				const stat = statSync(fullPath);

				if (stat.isDirectory()) {
					// Recurse into subdirectories, passing skipDirs through
					const nested = discoverIgnoreFiles(fullPath, skipDirs);
					results.push(...nested);
				} else if (entry === ".gitignore") {
					results.push(fullPath);
				}
			} catch {
				// Skip entries we can't stat
				continue;
			}
		}
	} catch {
		// Return empty for unreadable directories
	}

	return results;
}

// ═══════════════════════════════════════════════════════════════════════
// Backward-compatible aliases (old names still work)
// ═══════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use parseIgnoreLine instead. Retained for backward compatibility.
 */
export function parsePiignoreLine(line: string): string | null {
	return parseIgnoreLine(line);
}

/**
 * @deprecated Use buildIgnoreExcludes instead. Retained for backward compatibility.
 */
export function buildPiignoreExcludes(piignorePath: string): string[] {
	return buildIgnoreExcludes(piignorePath);
}
