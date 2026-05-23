/**
 * ranked-map — Ranked repo map for token-efficient codebase context
 *
 * Provides the ranked_map tool. Uses keyword overlap (rg) + git recency
 * to rank files by relevance, returning only the top files within a
 * configurable token budget. Phase 1: keyword + recency only.
 * Co-change scoring deferred to Phase 2.
 *
 * Reuses parseCtagsOutput / buildCtagsArgs from codebase-mapper.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, relative } from "node:path";

import { parseCtagsOutput, buildCtagsArgs } from "./codebase-mapper";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface RankedMapConfig {
	tokenBudget: number;
	recencyWindowDays: number;
	cacheTtlHours: number;
	weights: { keyword: number; recency: number };
}

export interface CachedIndex {
	head: string;
	builtAt: number;
	symbols: Record<string, SymbolEntry[]>;
}

export interface SymbolEntry {
	type: string;
	name: string;
	line: number;
}

export interface RankedFileScore {
	path: string;
	score: number;
	symbols: string;
	preview: string;
}

export interface RankedMapResult {
	files: RankedFileScore[];
	total_tokens: number;
	budget: number;
	truncated: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Defaults
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: RankedMapConfig = {
	tokenBudget: 2048,
	recencyWindowDays: 30,
	cacheTtlHours: 24,
	weights: { keyword: 0.5, recency: 0.3 },
};

const MAX_RECENCY_WINDOW_DAYS = 365;

// ═══════════════════════════════════════════════════════════════════════
// Pure Functions (exported for testing)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Estimate tokens from text (~4 chars per token heuristic).
 * No external dependency needed. ±20% accuracy sufficient for budget guardrail.
 */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / 4);
}

/**
 * Load ranked map configuration from .pi/settings.json.
 * Falls back to defaults on missing file, parse errors, or missing keys.
 */
export function loadRankedMapConfig(cwd: string): RankedMapConfig {
	try {
		const settingsPath = join(cwd, ".pi", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw);
		const rm = settings?.rankedMap;

		if (!rm) return { ...DEFAULT_CONFIG };

		let tokenBudget = DEFAULT_CONFIG.tokenBudget;
		if (
			typeof rm.tokenBudget === "number" &&
			Number.isFinite(rm.tokenBudget) &&
			Number.isInteger(rm.tokenBudget) &&
			rm.tokenBudget > 0
		) {
			tokenBudget = rm.tokenBudget;
		}

		let recencyWindowDays = DEFAULT_CONFIG.recencyWindowDays;
		if (
			typeof rm.recencyWindowDays === "number" &&
			Number.isFinite(rm.recencyWindowDays) &&
			Number.isInteger(rm.recencyWindowDays) &&
			rm.recencyWindowDays > 0
		) {
			recencyWindowDays = Math.min(rm.recencyWindowDays, MAX_RECENCY_WINDOW_DAYS);
		}

		let cacheTtlHours = DEFAULT_CONFIG.cacheTtlHours;
		if (
			typeof rm.cacheTtlHours === "number" &&
			Number.isFinite(rm.cacheTtlHours) &&
			rm.cacheTtlHours > 0
		) {
			cacheTtlHours = rm.cacheTtlHours;
		}

		let kwWeight = DEFAULT_CONFIG.weights.keyword;
		let recWeight = DEFAULT_CONFIG.weights.recency;

		if (rm.weights && typeof rm.weights === "object") {
			const w = rm.weights;

			if (
				typeof w.keyword === "number" &&
				Number.isFinite(w.keyword) &&
				w.keyword >= 0 &&
				w.keyword <= 1
			) {
				kwWeight = w.keyword;
			}

			if (
				typeof w.recency === "number" &&
				Number.isFinite(w.recency) &&
				w.recency >= 0 &&
				w.recency <= 1
			) {
				recWeight = w.recency;
			}

			const sum = kwWeight + recWeight;
			if (sum > 1) {
				kwWeight = kwWeight / sum;
				recWeight = recWeight / sum;
			}
		}

		return {
			tokenBudget,
			recencyWindowDays,
			cacheTtlHours,
			weights: { keyword: kwWeight, recency: recWeight },
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Compute keyword relevance scores per file using Jaccard overlap.
 *
 * For each file, score = matchedTerms / queryTerms (fraction of query terms present in file).
 * Returns 0 for files with no matches.
 */
export function computeKeywordScores(
	fileTermMatches: Record<string, string[]>,
	queryTerms: string[],
): Record<string, number> {
	const scores: Record<string, number> = {};
	const totalTerms = queryTerms.length;

	for (const [file, matched] of Object.entries(fileTermMatches)) {
		scores[file] = totalTerms > 0 ? matched.length / totalTerms : 0;
	}

	return scores;
}

/**
 * Compute recency scores using linear decay.
 *
 * Score = max(0, 1 - ageInDays / windowDays)
 * - file touched today → score 1.0
 * - file touched at windowDays boundary → ~0.0
 * - file never touched → score 0.0
 */
export function computeRecencyScores(
	fileLastTouched: Record<string, string>,
	windowDays: number,
	now: Date = new Date(),
): Record<string, number> {
	const scores: Record<string, number> = {};
	const nowMs = now.getTime();

	for (const [file, dateStr] of Object.entries(fileLastTouched)) {
		const fileDate = new Date(dateStr);
		const ageMs = nowMs - fileDate.getTime();
		const ageDays = ageMs / (1000 * 60 * 60 * 24);

		if (windowDays <= 0) {
			// When window is 0, only files touched on same calendar day get 1.0
			const todayStr = now.toISOString().split("T")[0];
			const fileDateStr = dateStr.split("T")[0];
			scores[file] = fileDateStr === todayStr ? 1.0 : 0.0;
		} else if (ageDays <= 0) {
			scores[file] = 1.0;
		} else if (ageDays >= windowDays) {
			scores[file] = 0.0;
		} else {
			scores[file] = Math.round((1 - ageDays / windowDays) * 100) / 100;
		}
	}

	return scores;
}

/**
 * Format symbol entries into a compact string for tool output.
 */
export function formatSymbols(symbols: SymbolEntry[], path: string): string {
	if (!symbols || symbols.length === 0) return `${path}\n  (no symbols)`;

	const lines: string[] = [];
	for (const sym of symbols) {
		lines.push(`  ${sym.type} ${sym.name}`);
	}
	return `${path}\n${lines.join("\n")}`;
}

/**
 * Rank files by combined score (weighted sum of keyword + recency),
 * sort descending, and fill within token budget (greedy).
 */
export function rankFiles(
	keywordScores: Record<string, number>,
	recencyScores: Record<string, number>,
	weights: { keyword: number; recency: number },
	tokenBudget: number,
	symbolEntries: Record<string, SymbolEntry[]>,
): { files: RankedFileScore[]; totalTokens: number; truncated: boolean } {
	const allFiles = new Set([
		...Object.keys(keywordScores),
		...Object.keys(recencyScores),
		...Object.keys(symbolEntries),
	]);

	type FileScore = { path: string; score: number; symbols: SymbolEntry[] };
	const scored: FileScore[] = [];

	for (const file of allFiles) {
		const kw = keywordScores[file] ?? 0;
		const rec = recencyScores[file] ?? 0;
		const syms = symbolEntries[file] ?? [];
		const score = kw * weights.keyword + rec * weights.recency;
		scored.push({ path: file, score: Math.round(score * 100) / 100, symbols: syms });
	}

	// Sort descending by score, tie-break by path alphabetically
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.path.localeCompare(b.path);
	});

	const files: RankedFileScore[] = [];
	let totalTokens = 0;
	let truncated = false;

	const PREVIEW_TOKEN_ESTIMATE = 50;

	for (const entry of scored) {
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
 * Format ranked results into output shape.
 */
export function formatOutput(
	rankedFiles: RankedFileScore[],
	budget: number,
	truncated: boolean,
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
	};
}

/**
 * Load cached index from disk.
 * Returns null if cache missing, malformed, HEAD mismatch, or missing required keys.
 */
export function loadCachedIndex(cachePath: string, currentHead: string): CachedIndex | null {
	try {
		if (!existsSync(cachePath)) return null;
		const raw = readFileSync(cachePath, "utf-8");
		const parsed = JSON.parse(raw);

		if (!parsed || typeof parsed !== "object") return null;
		if (typeof parsed.head !== "string") return null;
		if (typeof parsed.builtAt !== "number") return null;
		if (!parsed.symbols || typeof parsed.symbols !== "object") return null;

		// HEAD mismatch → stale
		if (parsed.head !== currentHead) return null;

		return {
			head: parsed.head,
			builtAt: parsed.builtAt,
			symbols: parsed.symbols as Record<string, SymbolEntry[]>,
		};
	} catch {
		return null;
	}
}

/**
 * Build symbol index from ctags JSONL output.
 */
export function buildSymbolIndex(
	ctagsJsonl: string,
	head: string,
	now: number = Date.now(),
): CachedIndex {
	const tags = parseCtagsOutput(ctagsJsonl);
	const symbols: Record<string, SymbolEntry[]> = {};

	for (const tag of tags) {
		if (!symbols[tag.path]) {
			symbols[tag.path] = [];
		}
		symbols[tag.path]!.push({
			type: tag.kind,
			name: tag.name,
			line: tag.line ?? 0,
		});
	}

	// Sort by line number
	for (const file of Object.keys(symbols)) {
		symbols[file]!.sort((a, b) => a.line - b.line);
	}

	return { head, builtAt: now, symbols };
}

/**
 * Run rg --files-with-matches for each query term and return matched terms per file.
 */
export function runKeywordSearch(
	query: string,
	directory: string,
	cwd: string,
): { fileMatches: Record<string, string[]>; terms: string[] } {
	const fileMatches: Record<string, string[]> = {};
	const terms = query.trim().split(/\s+/).filter(Boolean);

	if (terms.length === 0) return { fileMatches: {}, terms: [] };

	for (const term of terms) {
		try {
			// Escape regex special chars for literal search
			const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const stdout = execSync(
				`rg --files-with-matches --ignore-case --no-messages ${escaped} ${directory}`,
				{
					cwd,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 15_000,
				},
			);
			const matchedFiles = stdout.trim().split("\n").filter(Boolean);

			for (const file of matchedFiles) {
				if (!fileMatches[file]) {
					fileMatches[file] = [];
				}
				fileMatches[file]!.push(term);
			}
		} catch {
			// rg returns non-zero exit if no matches — not an error
			continue;
		}
	}

	return { fileMatches, terms };
}

/**
 * Run git log to get last-touched dates for tracked files within the window.
 */
export function runGitRecency(windowDays: number, cwd: string): Record<string, string> {
	const fileDates: Record<string, string> = {};

	try {
		// Use --diff-filter=AM to include only added/modified files
		const since = `--since="${windowDays} days ago"`;
		const stdout = execSync(
			`git log ${since} --pretty=format:"%ad" --date=format:%Y-%m-%dT%H:%M:%SZ --name-only --diff-filter=AM`,
			{
				cwd,
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 15_000,
			},
		);

		const lines = stdout.split("\n");
		let currentDate: string | null = null;

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			// Check if this line looks like a date (from --pretty=format)
			if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(trimmed)) {
				currentDate = trimmed;
				continue;
			}

			// It's a file path
			if (currentDate && trimmed) {
				// Keep the most recent date per file (first encounter in git log is most recent)
				if (!fileDates[trimmed]) {
					fileDates[trimmed] = currentDate;
				}
			}
		}
	} catch {
		// git log may fail on repos with no commits — return empty
	}

	return fileDates;
}

/**
 * Get the current git HEAD for cache invalidation.
 */
export function getGitHead(cwd: string): string | null {
	try {
		return execSync("git rev-parse HEAD", {
			cwd,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 5_000,
		}).trim();
	} catch {
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════

export default function rankedMap(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ranked_map",
		label: "Ranked Repo Map",
		description:
			"Ranked file index using keyword overlap (ripgrep) and git recency scoring. " +
			"Returns the most relevant subset of the codebase within a configurable token budget. " +
			"Output: JSON with files array (path, score, symbols, preview), total_tokens, budget, truncated. " +
			"Reuses ctags symbol index (cached) + rg for keyword matching + git log for recency. " +
			"Recommended over map_codebase for large repos (submodule-scale, 50K+ files) — " +
			"~99% token reduction compared to full map_codebase dump.",
		promptSnippet:
			"Ranked codebase map by keyword relevance and git recency — returns top files within token budget",
		promptGuidelines: [
			"Use ranked_map instead of map_codebase for large repos (submodule-scale, 50K+ files). Map_codebase dumps ALL symbols and can consume 280K+ tokens; ranked_map returns only the most relevant subset (~2K tokens).",
			"Pass a `query` describing what you're looking for (e.g. 'login auth token') to rank by keyword relevance. Without query, ranking falls back to git recency only.",
			"Set `tokenBudget` to control output size (default 2048 tokens). Smaller budget = fewer files = faster response.",
			"The tool is on-demand (not auto-injected). Call it when you need codebase context, not every turn.",
		],
		parameters: Type.Object({
			query: Type.Optional(
				Type.String({
					default: "",
					description:
						"Space-separated query terms for keyword scoring. " +
						"Files containing these terms rank higher. " +
						"Uses rg --files-with-matches (case-insensitive, literal search).",
				}),
			),
			tokenBudget: Type.Optional(
				Type.Number({
					default: 2048,
					description:
						"Maximum token budget for output. " +
						"Greedy fill from highest-ranked file until budget exhausted. " +
						"Overrides settings.json rankedMap.tokenBudget if provided.",
				}),
			),
			directory: Type.Optional(
				Type.String({
					default: ".",
					description:
						"Target directory for ctags index and rg keyword search. " +
						"Default: project root. Set to a subdirectory for focused results.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd;
			const targetDir = params.directory || ".";
			const query = (params.query || "").trim();
			const config = loadRankedMapConfig(cwd);
			const budget =
				typeof params.tokenBudget === "number" &&
				Number.isFinite(params.tokenBudget) &&
				params.tokenBudget > 0
					? params.tokenBudget
					: config.tokenBudget;

			const cacheDir = join(cwd, ".pi", "cache");
			const cachePath = join(cacheDir, "ranked-map-index.json");

			// Get current HEAD for cache invalidation
			const currentHead = getGitHead(cwd);

			// Try loading from cache
			let index: CachedIndex | null = null;
			if (currentHead) {
				index = loadCachedIndex(cachePath, currentHead);
			}

			// Build index if cache miss
			if (!index) {
				try {
					// Ensure cache directory exists
					if (!existsSync(cacheDir)) {
						mkdirSync(cacheDir, { recursive: true });
					}

					const { command, args } = buildCtagsArgs(targetDir, 0);

					const result = await pi.exec(command, args, {
						cwd,
						timeout: 30_000,
					});

					if (result.code !== 0 && (!result.stdout || result.stdout.trim().length === 0)) {
						return {
							content: [
								{
									type: "text" as const,
									text:
										`ctags failed (exit code ${result.code}): ` +
										(result.stderr || "unknown error") +
										"\n\nEnsure universal-ctags is installed with JSON output support.",
								},
							],
							details: { success: false, exitCode: result.code, stderr: result.stderr } as Record<
								string,
								unknown
							>,
						};
					}

					index = buildSymbolIndex(result.stdout, currentHead || "unknown");

					// Write cache
					try {
						writeFileSync(cachePath, JSON.stringify(index), "utf-8");
					} catch {
						// Non-critical — proceed without cache
					}
				} catch (err: any) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Failed to build symbol index: ${err.message || err}` +
									"\nEnsure universal-ctags is installed.",
							},
						],
						details: { success: false, error: err.message } as Record<string, unknown>,
					};
				}
			}

			// Compute keyword scores (if query provided)
			let keywordScores: Record<string, number> = {};
			if (query) {
				const { fileMatches, terms } = runKeywordSearch(query, targetDir, cwd);
				keywordScores = computeKeywordScores(fileMatches, terms);
			}

			// Compute recency scores
			const fileDates = runGitRecency(config.recencyWindowDays, cwd);
			const recencyScores = computeRecencyScores(fileDates, config.recencyWindowDays);

			// Rank files
			const ranked = rankFiles(keywordScores, recencyScores, config.weights, budget, index.symbols);

			// Fill previews from actual file contents
			const filesWithPreviews = ranked.files.map((f) => {
				let preview = "";
				try {
					const fullPath = resolve(cwd, targetDir, f.path);
					if (existsSync(fullPath)) {
						const content = readFileSync(fullPath, "utf-8");
						preview = content.split("\n").slice(0, 5).join("\n");
					}
				} catch {
					// preview stays empty
				}
				return { ...f, preview };
			});

			const output = formatOutput(filesWithPreviews, budget, ranked.truncated);

			// Build summary text
			const symbolCount = Object.values(index.symbols).flat().length;
			const fileCount = Object.keys(index.symbols).length;

			const queryInfo = query ? `query="${query}", ` : "no query, ";
			const truncatedInfo = output.truncated
				? ` (truncated to ${output.files.length} files)`
				: ` (${output.files.length} files)`;

			return {
				content: [
					{
						type: "text" as const,
						text:
							`Ranked repo map for: ${targetDir}\n` +
							`${queryInfo}${output.total_tokens} of ${budget} tokens used${truncatedInfo}\n` +
							`Index: ${fileCount} files, ${symbolCount} symbols\n\n` +
							"```json\n" +
							JSON.stringify(output, null, 2) +
							"\n```",
					},
				],
				details: {
					success: true,
					config,
					output,
					indexHead: index.head,
					indexBuiltAt: index.builtAt,
				} as Record<string, unknown>,
			};
		},
	});
}
