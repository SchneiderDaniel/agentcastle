/**
 * ranked-map — .piignore integration
 *
 * Reads .piignore file and converts its patterns to ctags --exclude arguments.
 * Pure module — no pi SDK imports. Zero async I/O.
 *
 * Supports:
 * - Comment lines (#)
 * - Directory patterns (dir/ → --exclude=dir)
 * - Glob patterns (*.ext → --exclude=*.ext)
 * - Path patterns (path/to/dir/ → --exclude=path/to/dir)
 * - Negation patterns (!pattern → skipped, ctags can't negate)
 *
 * Not supported (silently skipped):
 * - Negation (!)
 * - Double-star glob patterns (**)
 * - Leading slash patterns (absolute paths)
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Parse a single .piignore line into a ctags --exclude pattern.
 * Returns null for lines that can't be converted (comments, negations, empty).
 */
export function parsePiignoreLine(line: string): string | null {
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

	// Ctags --exclude supports globs but not ** (double-star)
	// Skip patterns containing ** that aren't just trailing /**
	if (pattern.includes("**")) return null;

	// Skip patterns with leading / (absolute-style paths)
	if (pattern.startsWith("/")) return null;

	return pattern || null;
}

/**
 * Read .piignore file and return list of ctags --exclude argument values.
 * Returns empty array if file doesn't exist or can't be read.
 */
export function buildPiignoreExcludes(piignorePath: string): string[] {
	try {
		if (!existsSync(piignorePath)) return [];

		const content = readFileSync(piignorePath, "utf-8");
		const lines = content.split("\n");
		const excludes: string[] = [];

		for (const line of lines) {
			const pattern = parsePiignoreLine(line);
			if (pattern) {
				excludes.push(pattern);
			}
		}

		return excludes;
	} catch {
		return [];
	}
}
