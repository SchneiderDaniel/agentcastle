/**
 * codebase-mapper — Scans codebase structure with ctags and returns symbol hierarchy
 *
 * Provides the map_codebase tool. Discovers all symbols (classes, functions,
 * methods, variables) grouped by file. Returns metadata only — never file contents.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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
	const args = ["-R", "--output-format=json", "--exclude=node_modules", "--exclude=.git"];

	if (maxDepth > 0) {
		args.push(`--maxdepth=${maxDepth}`);
	}

	args.push(targetDir);

	return { command: "ctags", args };
}

// ═══════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════

export default function codebaseMapper(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "map_codebase",
		label: "Map Codebase",
		description:
			"Run ctags (Universal Ctags) on a target directory and return a compressed, " +
			"hierarchical tree of symbols (classes, functions, methods, variables) grouped by file. " +
			"Output: JSON object where keys are file paths and values are arrays of " +
			'{ "type": string, "name": string, "line": number } entries. ' +
			"Use this to answer 'What files and functions exist?' before reading any files. " +
			"This tool is strictly read-only and metadata-focused. " +
			"It never returns file contents or function bodies. " +
			"Requires universal-ctags compiled with JSON output support.",
		promptSnippet: "Map a codebase directory by running ctags and returning symbol hierarchy",
		promptGuidelines: [
			"Use map_codebase at the start of a task to get a macro-level skeleton of the repository. This answers 'What files and functions exist?' without reading individual files.",
			"Default target_directory is project root, default max_depth is 0 (unlimited). Pass max_depth=3 for a top-level overview only.",
			"Combine map_codebase results with read to inspect specific functions by file path and line number.",
			"Run map_codebase once and reuse the result — re-running is expensive for large codebases.",
		],
		parameters: Type.Object({
			target_directory: Type.Optional(
				Type.String({
					default: ".",
					description: "Path to the directory to map (default: current working directory)",
				}),
			),
			max_depth: Type.Optional(
				Type.Number({
					default: 0,
					description:
						"Maximum directory recursion depth (0 = unlimited, default 0). " +
						"Use small values (1-3) for a top-level overview to avoid overloading context.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const targetDir = params.target_directory || ".";
			const maxDepth = params.max_depth ?? 0;
			const cwd = ctx.cwd;

			// Build and run ctags command
			const { command, args } = buildCtagsArgs(targetDir, maxDepth);

			const result = await pi.exec(command, args, {
				cwd,
				timeout: 30_000,
			});

			if (result.code !== 0) {
				// ctags may produce stderr warnings about skipped files
				// but still output valid JSONL to stdout — only fail if stdout is empty
				if (!result.stdout || result.stdout.trim().length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`ctags failed (exit code ${result.code}): ` +
									(result.stderr || "unknown error") +
									"\n\nEnsure universal-ctags is installed with JSON output support (`ctags --list-output-formats`).",
							},
						],
						details: { success: false, exitCode: result.code, stderr: result.stderr } as Record<
							string,
							unknown
						>,
					};
				}
			}

			// Parse and group
			const map = buildCodebaseMap(result.stdout);

			// Format as pretty JSON for LLM consumption
			const json = JSON.stringify(map, null, 2);

			const symbolCount = Object.values(map).flat().length;
			const fileCount = Object.keys(map).length;

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Codebase map for: ${targetDir}\n` +
							`Files: ${fileCount}, Symbols: ${symbolCount}\n\n` +
							"```json\n" +
							json +
							"\n```",
					},
				],
				details: { success: true, fileCount, symbolCount, map } as Record<string, unknown>,
			};
		},
	});
}
