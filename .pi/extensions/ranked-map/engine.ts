/**
 * ranked-map — RankedMapEngine orchestration class
 *
 * Extracts the execute handler logic into a testable class with
 * independent methods for index building, ranking, previews, and formatting.
 *
 * Constructor takes config and exec, making every phase testable
 * without running the full handler.
 */

import {
	type ExecFn,
	type CachedIndex,
	type RankedMapConfig,
	type RankedFileScore,
	type RankedMapResult,
} from "./types.ts";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildCtagsArgs, buildSymbolIndex } from "./ctags.ts";
import { loadCachedIndex, computeConfigHash } from "./cache.ts";
import {
	selectMode,
	dumpAllFiles,
	formatOutput,
	getStructuralOverview,
	formatSymbols,
} from "./format.ts";
import {
	computeKeywordScores,
	computeRecencyScores,
	computeFileSizeScores,
	rankFiles,
} from "./scoring.ts";
import { runKeywordSearch } from "./search.ts";
import { runGitRecency, getGitHead, discoverSubmodules } from "./git.ts";
import { buildPiignoreExcludes, buildIgnoreExcludes, discoverIgnoreFiles } from "./piignore.ts";

/** Result shape for the rank method — extends dumpAllFiles/rankFiles result with mode. */
export interface RankResult {
	files: RankedFileScore[];
	totalTokens: number;
	truncated: boolean;
	mode: "ranked" | "full_dump";
}

/**
 * Orchestrates the ranked-map pipeline: index, search, rank, format.
 *
 * Usage:
 *   const engine = new RankedMapEngine(config, exec, cwd);
 *   const index = await engine.buildOrLoadIndex(targetDir, cacheDir, signal);
 *   const ranked = await engine.rank(index, query, budget, signal);
 *   const withPreviews = engine.addPreviews(ranked.files, targetDir, ranked.mode);
 *   const output = engine.format(withPreviews, budget, ranked.truncated, ranked.mode);
 */
export class RankedMapEngine {
	private config: RankedMapConfig;
	private exec: ExecFn;
	private cwd: string;

	constructor(config: RankedMapConfig, exec: ExecFn, cwd: string) {
		this.config = config;
		this.exec = exec;
		this.cwd = cwd;
	}

	/**
	 * Build or load the symbol index.
	 *
	 * 1. Looks up git HEAD for cache invalidation.
	 * 2. Tries to load a cached index matching current HEAD.
	 * 3. On cache miss, runs ctags, parses JSONL output, caches the result.
	 *
	 * @throws Error if ctags fails with non-zero exit and no usable output.
	 */
	async buildOrLoadIndex(
		targetDir: string,
		cacheDir: string,
		signal?: AbortSignal,
	): Promise<CachedIndex> {
		const cachePath = resolve(cacheDir, "ranked-map-index.json");
		const currentHead = await getGitHead(this.exec, this.cwd, signal);
		const configHash = computeConfigHash(this.config);

		// Try cache first
		if (currentHead) {
			const cached = loadCachedIndex(cachePath, currentHead, configHash, targetDir);
			if (cached) return cached;
		}

		// Build new index
		try {
			if (!existsSync(cacheDir)) {
				mkdirSync(cacheDir, { recursive: true });
			}
		} catch {
			// non-critical — cache dir may already exist
		}

		// Incorporate .piignore patterns as additional ctags excludes
		const piignorePath = join(this.cwd, ".piignore");
		const piignoreExcludes = buildIgnoreExcludes(piignorePath);

		// Incorporate .gitignore patterns from root and submodules
		const targetAbs = resolve(this.cwd, targetDir);
		const gitignorePaths = discoverIgnoreFiles(targetAbs);
		const gitignoreExcludes = gitignorePaths.flatMap((p) => buildIgnoreExcludes(p));

		const allExcludes = [...piignoreExcludes, ...gitignoreExcludes];

		const { command, args } = buildCtagsArgs(targetDir, 0, allExcludes);
		const result = await this.exec(command, args, {
			cwd: this.cwd,
			timeout: 30_000,
			signal,
		});

		if (result.code !== 0 && (!result.stdout || result.stdout.trim().length === 0)) {
			throw new Error(
				`ctags failed (exit code ${result.code}): ${result.stderr || "unknown error"}\n\nEnsure universal-ctags is installed with JSON output support.`,
			);
		}

		const index = buildSymbolIndex(result.stdout, currentHead || "unknown", undefined, targetDir);
		index.configHash = configHash;
		index.targetDir = targetDir;

		try {
			writeFileSync(cachePath, JSON.stringify(index), "utf-8");
		} catch {
			/* non-critical — cache write failure is not fatal */
		}

		return index;
	}

	/**
	 * Rank files based on query and recency, or dump all for small repos.
	 *
	 * Mode selection:
	 * - query provided → "ranked" (keyword + recency scoring)
	 * - no query, totalSymbols <= autoThreshold → "full_dump" (path-sorted)
	 * - no query, totalSymbols > autoThreshold → "ranked" (recency-only)
	 *
	 * @param index - Symbol index from buildOrLoadIndex
	 * @param query - Query string for keyword search (empty string means no query)
	 * @param budget - Token budget for output
	 * @param targetDir - Target directory for keyword search scope (e.g. ".", "src", "/abs/path")
	 * @param signal - Optional AbortSignal for cancellation
	 */
	async rank(
		index: CachedIndex,
		query: string,
		budget: number,
		targetDir: string,
		signal?: AbortSignal,
	): Promise<RankResult> {
		const totalSymbols = Object.values(index.symbols).flat().length;
		const mode = selectMode(query, totalSymbols, this.config.autoThreshold);

		if (mode === "full_dump") {
			const dumped = dumpAllFiles(index.symbols, budget);
			return { ...dumped, mode: "full_dump" as const };
		}

		// Ranked mode: compute keyword scores (if query) and recency scores
		let keywordScores: Record<string, number> = {};
		const hasQuery = query.trim().length > 0;
		if (hasQuery) {
			const { fileMatches, terms } = await runKeywordSearch(
				this.exec,
				query,
				targetDir,
				this.cwd,
				signal,
			);
			keywordScores = computeKeywordScores(fileMatches, terms);
		}

		// Discover submodules and pass them to runGitRecency for submodule-aware recency
		const submodules = await discoverSubmodules(this.exec, this.cwd, signal);
		const fileDates = await runGitRecency(
			this.exec,
			this.config.recencyWindowDays,
			this.cwd,
			signal,
			submodules,
		);
		const recencyScores = computeRecencyScores(fileDates, this.config.recencyWindowDays);

		// Compute file size scores for file size penalty
		const fileSizes: Record<string, number> = {};
		for (const filePath of Object.keys(index.symbols)) {
			try {
				const fullPath = resolve(this.cwd, targetDir, filePath);
				if (existsSync(fullPath)) {
					fileSizes[filePath] = statSync(fullPath).size;
				}
			} catch {
				// ignore files that can't be read
			}
		}
		const fileSizeScores = computeFileSizeScores(fileSizes);

		const ranked = rankFiles(
			keywordScores,
			recencyScores,
			this.config.weights,
			budget,
			index.symbols,
			fileSizeScores,
		);

		// In recency-only mode (no query), inject structural overview files
		// to ensure at least one file per top-level directory appears in output.
		// Structural files get score 0.1 so they don't get truncated by token budget.
		if (!hasQuery) {
			const allPaths = Object.keys(index.symbols);
			const structuralFiles = getStructuralOverview(allPaths);
			const existingByPath = new Map(ranked.files.map((f) => [f.path, f]));

			for (const sf of structuralFiles) {
				const existing = existingByPath.get(sf.path);
				if (existing) {
					// Bump score to at least 0.1 for structural overview files
					if (existing.score < sf.score) {
						existing.score = sf.score;
					}
				} else {
					const syms = index.symbols[sf.path] ?? [];
					const symText = formatSymbols(syms, sf.path);
					ranked.files.push({
						path: sf.path,
						score: sf.score,
						symbols: symText,
						preview: "",
					});
					existingByPath.set(sf.path, ranked.files[ranked.files.length - 1]!);
				}
			}

			// Re-sort by score descending (structural files with 0.1 will be at bottom)
			ranked.files.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				return a.path.localeCompare(b.path);
			});
		}

		return { ...ranked, mode: "ranked" as const };
	}

	/**
	 * Strip ctag pattern delimiters to extract the actual code line.
	 * Pattern format is typically /^code line$/ or ?^code line$?
	 */
	private stripPattern(pattern: string): string {
		// Pattern format: /^...$/  or ?^...$?
		const match = pattern.match(/^[\/?]\^?(.+?)\$?[\/?]$/);
		if (match?.[1]) {
			return match[1];
		}
		// Fallback: just return the pattern as-is
		return pattern;
	}

	/**
	 * Add file previews for ranked mode results.
	 *
	 * When an index is provided, tries to show the first ctag pattern line
	 * (the definition line) instead of reading the first 5 file lines.
	 * Falls back to reading first 5 lines when no pattern is available.
	 * Full_dump mode files are returned unchanged.
	 */
	addPreviews(
		files: RankedFileScore[],
		targetDir: string,
		mode: "ranked" | "full_dump",
		index?: CachedIndex,
	): RankedFileScore[] {
		if (mode === "full_dump") return files;

		return files.map((f) => {
			if (f.preview) return f; // already has preview
			let preview = "";

			// Try pattern-based preview from index
			if (index?.symbols[f.path] && index.symbols[f.path]!.length > 0) {
				const firstSymbol = index.symbols[f.path]![0];
				if (firstSymbol.pattern) {
					preview = this.stripPattern(firstSymbol.pattern);
					return { ...f, preview };
				}
			}

			// Fallback: read first 5 lines from disk
			try {
				const fullPath = resolve(this.cwd, targetDir, f.path);
				if (existsSync(fullPath)) {
					preview = readFileSync(fullPath, "utf-8").split("\n").slice(0, 5).join("\n");
				}
			} catch {
				/* empty preview */
			}
			return { ...f, preview };
		});
	}

	/**
	 * Format ranked files into the output shape expected by the tool.
	 * Delegates to formatOutput internally.
	 */
	format(
		files: RankedFileScore[],
		budget: number,
		truncated: boolean,
		mode: "ranked" | "full_dump",
	): RankedMapResult {
		return formatOutput(files, budget, truncated, mode);
	}
}
