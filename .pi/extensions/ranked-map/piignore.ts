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
 *
 * Also provides resolvePiignorePatterns() and matchPiignorePattern() for
 * strict path-based post-processing (Feature 2 of architecture hardening).
 * These evaluate .piignore patterns against full file paths, not basenames,
 * enabling precise exclusion like .pi/cache without affecting src/utils/cache/.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ResolvedPiignorePattern } from "./types.ts";

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
// .piignore path post-processing (strict path matching)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Read a .piignore file and resolve each line into a structured pattern
 * descriptor suitable for file-path matching (not basename matching).
 *
 * Returns an array of ResolvedPiignorePattern objects, one per non-comment,
 * non-empty line. Each pattern carries its original text, type (glob or exact),
 * and negation flag.
 *
 * Unlike parseIgnoreLine which extracts basenames for ctags compatibility,
 * this function preserves the full path for precise matching.
 *
 * Returns empty array if the file doesn't exist, is empty, or can't be read.
 */
export function resolvePiignorePatterns(filePath: string): ResolvedPiignorePattern[] {
	const patterns: ResolvedPiignorePattern[] = [];
	try {
		if (!existsSync(filePath)) return patterns;
		const content = readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const negate = trimmed.startsWith("!");
			const raw = negate ? trimmed.slice(1) : trimmed;

			// Normalize: strip trailing /**
			let pattern = raw;
			if (pattern.endsWith("/**")) {
				pattern = pattern.slice(0, -3);
				if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
			}

			// Strip trailing / for directory patterns (matching is prefix-based anyway)
			if (pattern.endsWith("/")) {
				pattern = pattern.slice(0, -1);
			}

			const type =
				pattern.includes("*") || pattern.includes("?") || pattern.includes("[")
					? ("glob" as const)
					: ("exact" as const);

			patterns.push({ raw, type, pattern, negate });
		}
		return patterns;
	} catch {
		return patterns;
	}
}

/**
 * Check whether a file path matches a resolved .piignore pattern.
 *
 * For exact patterns, checks if the file path equals the pattern or
 * starts with the pattern + "/" (directory prefix match).
 * Handles patterns with or without trailing slash.
 *
 * For glob patterns, converts the glob to a regex and tests the full path.
 * Supports *, **, and ? wildcards.
 * For glob patterns ending in a literal segment (no trailing wildcard),
 * also checks directory prefix matching (e.g., double-star temp pattern matches inside temp directory).
 */
export function matchPiignorePattern(pattern: ResolvedPiignorePattern, filePath: string): boolean {
	if (pattern.type === "exact") {
		// Exact path match
		if (filePath === pattern.pattern) return true;
		// Directory prefix match — handle both with and without trailing /
		const prefix = pattern.pattern.endsWith("/") ? pattern.pattern : pattern.pattern + "/";
		if (filePath.startsWith(prefix)) return true;
		return false;
	} else {
		// Glob matching against full path
		return matchGlob(pattern.pattern, filePath);
	}
}

/**
 * Match a glob pattern against a file path.
 * Supports *, **, and ? wildcards.
 *
 * - * matches any characters including / (full-path matching)
 * - ** matches any characters including / (any depth)
 * - ? matches any single character except /
 *
 * For patterns ending in a literal segment (no trailing wildcard),
 * also checks directory prefix matching so a double-star pattern matches inside the directory.
 */
function matchGlob(glob: string, path: string): boolean {
	// Try direct glob match
	const regex = buildGlobRegex(glob);
	try {
		if (regex.test(path)) return true;
	} catch {
		return false;
	}

	// For patterns that end with a literal segment (no trailing wildcard),
	// also try as directory prefix by appending /**
	// This handles cases like **/temp matching src/temp/file.ts.
	const lastSegment = glob.split("/").pop() || glob;
	const hasTrailingWildcard =
		lastSegment.includes("*") || lastSegment.includes("?") || lastSegment.includes("[");
	if (!hasTrailingWildcard) {
		const dirRegex = buildGlobRegex(glob + "/**");
		try {
			if (dirRegex.test(path)) return true;
		} catch {
			// ignore invalid regex
		}
	}

	return false;
}

/**
 * Build a RegExp from a glob pattern.
 * Handles ** (any depth), * (any chars including /), ? (single char except /).
 */
function buildGlobRegex(glob: string): RegExp {
	const parts = glob.split("**");

	if (parts.length === 1) {
		// No ** — simple pattern with single * matching anything
		const reStr = "^" + segmentToRegexStr(parts[0]!) + "$";
		return new RegExp(reStr);
	}

	// Has ** — join segments with .* (matches any chars including /)
	let reStr = parts.map((p) => segmentToRegexStr(p)).join(".*");
	if (!reStr.startsWith("^")) reStr = "^" + reStr;
	if (!reStr.endsWith("$")) reStr = reStr + "$";
	return new RegExp(reStr);
}

/**
 * Convert a glob segment (without **) to a regex string.
 * * matches any characters including /, ? matches any single char except /.
 */
function segmentToRegexStr(segment: string): string {
	if (!segment) return "";
	let result = "";
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "*") {
			// * matches any characters including /
			result += ".*";
		} else if (ch === "?") {
			// ? matches any single character except /
			result += "[^/]";
		} else if (/[.+^${}()|[\]\\]/.test(ch!)) {
			result += "\\" + ch;
		} else {
			result += ch;
		}
	}
	return result;
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
