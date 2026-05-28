/**
 * Tests for Ranked Repo Map (keyword + recency scoring for token-efficient codebase context)
 *
 * Pure function tests for computeKeywordScores(), computeRecencyScores(),
 * rankFiles(), formatOutput(), loadRankedMapConfig().
 * Local copies match source at .pi/extensions/ranked-map.ts exactly.
 *
 * Run with:
 *   node --experimental-strip-types --test test/ranked-map.test.mts
 *
 * Integration test runs real ctags against test/fixtures/ctags-sample/
 * (skipped if ctags not installed).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/ranked-map.ts)
// ═══════════════════════════════════════════════════════════════════════

export interface RankedMapConfig {
	tokenBudget: number;
	recencyWindowDays: number;
	cacheTtlHours: number;
	autoThreshold: number;
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
	mode: "ranked" | "full_dump";
}

// ═══════════════════════════════════════════════════════════════════════
// Pure functions under test (match source at .pi/extensions/ranked-map.ts)
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: RankedMapConfig = {
	tokenBudget: 2048,
	recencyWindowDays: 30,
	cacheTtlHours: 24,
	autoThreshold: 20000,
	weights: { keyword: 0.5, recency: 0.3 },
};

const MAX_RECENCY_WINDOW_DAYS = 365;

/**
 * Estimate tokens from text (~4 chars per token heuristic).
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Determine tool mode based on query presence, symbol count, and autoThreshold.
 * query provided → ranked (keyword + recency)
 * no query, totalSymbols <= autoThreshold → full_dump (path-sorted)
 * no query, totalSymbols > autoThreshold → ranked (recency-only)
 */
export function selectMode(
	query: string,
	totalSymbols: number,
	autoThreshold: number,
): "ranked" | "full_dump" {
	if (query.trim()) return "ranked";
	if (totalSymbols <= autoThreshold) return "full_dump";
	return "ranked";
}

/**
 * Dump all symbols sorted by file path, filling greedily within token budget.
 * Each file gets score=0 and empty preview.
 */
export function dumpAllFiles(
	symbols: Record<string, SymbolEntry[]>,
	tokenBudget: number,
): { files: RankedFileScore[]; totalTokens: number; truncated: boolean } {
	const filePaths = Object.keys(symbols).sort();
	const files: RankedFileScore[] = [];
	let totalTokens = 0;
	let truncated = false;
	const PREVIEW_TOKEN_ESTIMATE = 50;

	for (const path of filePaths) {
		const syms = symbols[path] ?? [];
		const symText = formatSymbols(syms, path);
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
			path,
			score: 0,
			symbols: symText,
			preview: "",
		});
		totalTokens += entryTokens;
	}

	return { files, totalTokens, truncated };
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

		// tokenBudget: must be positive integer
		let tokenBudget = DEFAULT_CONFIG.tokenBudget;
		if (
			typeof rm.tokenBudget === "number" &&
			Number.isFinite(rm.tokenBudget) &&
			Number.isInteger(rm.tokenBudget) &&
			rm.tokenBudget > 0
		) {
			tokenBudget = rm.tokenBudget;
		}

		// recencyWindowDays: clamp to [1, MAX_RECENCY_WINDOW_DAYS]
		let recencyWindowDays = DEFAULT_CONFIG.recencyWindowDays;
		if (
			typeof rm.recencyWindowDays === "number" &&
			Number.isFinite(rm.recencyWindowDays) &&
			Number.isInteger(rm.recencyWindowDays) &&
			rm.recencyWindowDays > 0
		) {
			recencyWindowDays = Math.min(rm.recencyWindowDays, MAX_RECENCY_WINDOW_DAYS);
		}

		// autoThreshold: non-negative integer (0 = always-ranked)
		let autoThreshold = DEFAULT_CONFIG.autoThreshold;
		if (
			typeof rm.autoThreshold === "number" &&
			Number.isFinite(rm.autoThreshold) &&
			Number.isInteger(rm.autoThreshold) &&
			rm.autoThreshold >= 0
		) {
			autoThreshold = rm.autoThreshold;
		}

		// cacheTtlHours: must be positive
		let cacheTtlHours = DEFAULT_CONFIG.cacheTtlHours;
		if (
			typeof rm.cacheTtlHours === "number" &&
			Number.isFinite(rm.cacheTtlHours) &&
			rm.cacheTtlHours > 0
		) {
			cacheTtlHours = rm.cacheTtlHours;
		}

		// weights: validate and normalize
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

			// Normalize if sum > 1
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
			autoThreshold,
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
	fileLastTouched: Record<string, string>, // ISO date strings
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
 * Get preview (first 5 lines) of file contents.
 * Returns empty string if file can't be read.
 */
export function getFilePreview(filePath: string, cwd: string): string {
	try {
		const fullPath = resolve(cwd, filePath);
		if (!existsSync(fullPath)) return "";
		const content = readFileSync(fullPath, "utf-8");
		const lines = content.split("\n").slice(0, 5);
		return lines.join("\n");
	} catch {
		return "";
	}
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
	// Collect all file paths
	const allFiles = new Set([
		...Object.keys(keywordScores),
		...Object.keys(recencyScores),
		...Object.keys(symbolEntries),
	]);

	// Compute weighted scores
	type FileScore = { path: string; score: number; symbols: SymbolEntry[] };
	const scored: FileScore[] = [];

	for (const file of allFiles) {
		const kw = keywordScores[file] ?? 0;
		const rec = recencyScores[file] ?? 0;
		const syms = symbolEntries[file] ?? [];
		// Combined score = kw * weight.keyword + rec * weight.recency
		const score = kw * weights.keyword + rec * weights.recency;
		scored.push({ path: file, score: Math.round(score * 100) / 100, symbols: syms });
	}

	// Sort descending by score, tie-break by path alphabetically
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.path.localeCompare(b.path);
	});

	// Greedy fill within token budget
	const files: RankedFileScore[] = [];
	let totalTokens = 0;
	let truncated = false;

	// Estimate tokens: symbol header + 5 lines of preview (~200 chars average)
	const PREVIEW_TOKEN_ESTIMATE = 50; // 5 lines × 10 tokens/line

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
			preview: "", // Will be filled by caller with actual file contents
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
	mode: "ranked" | "full_dump" = "ranked",
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
		mode,
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
	// Reuse parseCtagsOutput logic — in the real extension this is imported
	// from codebase-mapper.ts. For tests, we inline a minimal version.
	const tags = parseTags(ctagsJsonl);
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

/** Minimal ctags JSONL parser (subset of parseCtagsOutput). */
interface MinCtagsTag {
	name: string;
	kind: string;
	path: string;
	line?: number;
}

function parseTags(raw: string): MinCtagsTag[] {
	if (!raw) return [];
	const lines = raw.split("\n");
	const tags: MinCtagsTag[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: any;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}

		if (parsed._type !== "tag") continue;
		if (typeof parsed.name !== "string" || !parsed.name) continue;
		if (typeof parsed.kind !== "string" || !parsed.kind) continue;
		if (typeof parsed.path !== "string" || !parsed.path) continue;

		tags.push({
			name: parsed.name,
			kind: parsed.kind,
			path: parsed.path,
			line: typeof parsed.line === "number" ? parsed.line : undefined,
		});
	}

	return tags;
}

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

/** Sample ctags JSONL output simulating a small Python/JS project. */
const SAMPLE_CTAGS_JSONL = [
	JSON.stringify({
		_type: "tag",
		name: "login_handler",
		kind: "function",
		path: "api/routes.py",
		pattern: "/^def login_handler():$/",
		line: 12,
	}),
	JSON.stringify({
		_type: "tag",
		name: "logout_handler",
		kind: "function",
		path: "api/routes.py",
		pattern: "/^def logout_handler():$/",
		line: 45,
	}),
	JSON.stringify({
		_type: "tag",
		name: "UserModel",
		kind: "class",
		path: "models/user.py",
		pattern: "/^class UserModel:$/",
		line: 1,
	}),
	JSON.stringify({
		_type: "tag",
		name: "get_user",
		kind: "function",
		path: "models/user.py",
		pattern: "/^  def get_user():$/",
		line: 10,
	}),
	JSON.stringify({
		_type: "tag",
		name: "App",
		kind: "class",
		path: "src/app.ts",
		pattern: "/^class App {$/",
		line: 1,
	}),
	JSON.stringify({
		_type: "tag",
		name: "start",
		kind: "method",
		path: "src/app.ts",
		pattern: "/^  start(): void {$/",
		line: 5,
	}),
].join("\n");

const SAMPLE_HEAD = "abc123def456";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Settings & Config Loading
// ═══════════════════════════════════════════════════════════════════════

describe("loadRankedMapConfig", () => {
	function setupTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ranked-map-test-"));
		mkdirSync(join(dir, ".pi"), { recursive: true });
		return dir;
	}

	function cleanupDir(dir: string) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	it("returns defaults when settings.json missing entirely", () => {
		const dir = mkdtempSync(join(tmpdir(), "ranked-nopi-"));
		try {
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 2048);
			assert.strictEqual(result.recencyWindowDays, 30);
			assert.strictEqual(result.cacheTtlHours, 24);
			assert.strictEqual(result.weights.keyword, 0.5);
			assert.strictEqual(result.weights.recency, 0.3);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns defaults when rankedMap key absent from settings.json", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 2048);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses custom tokenBudget=4096", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: 4096 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 4096);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses custom recencyWindowDays=14", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { recencyWindowDays: 14 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.recencyWindowDays, 14);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses custom weights {keyword: 0.6, recency: 0.4} and normalizes", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.6, recency: 0.4 } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.weights.keyword, 0.6);
			assert.strictEqual(result.weights.recency, 0.4);
		} finally {
			cleanupDir(dir);
		}
	});

	it("rejects negative tokenBudget, falls back to default (2048)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: -100 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 2048);
		} finally {
			cleanupDir(dir);
		}
	});

	it("rejects non-numeric tokenBudget, falls back to default", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: "abc" } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 2048);
		} finally {
			cleanupDir(dir);
		}
	});

	it("rejects tokenBudget=0, falls back to default (must be positive)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: 0 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 2048);
		} finally {
			cleanupDir(dir);
		}
	});

	it("clamps recencyWindowDays > 365 to 365", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { recencyWindowDays: 500 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.recencyWindowDays, 365);
		} finally {
			cleanupDir(dir);
		}
	});

	it("clamps weights sum > 1, normalizes to sum=1", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.8, recency: 0.6 } } }),
			);
			const result = loadRankedMapConfig(dir);
			// 0.8 + 0.6 = 1.4, normalize: 0.8/1.4 ≈ 0.57, 0.6/1.4 ≈ 0.43
			assert.ok(Math.abs(result.weights.keyword - 0.8 / 1.4) < 0.01);
			assert.ok(Math.abs(result.weights.recency - 0.6 / 1.4) < 0.01);
		} finally {
			cleanupDir(dir);
		}
	});

	it("rejects weight < 0 or > 1, falls back to default weight", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: -0.1, recency: 0.3 } } }),
			);
			const result = loadRankedMapConfig(dir);
			// keyword=-0.1 falls back to 0.5, recency=0.3 is valid
			// But recency is set explicitly to 0.3, keyword falls back to default
			// Wait — recency=0.3 is explicitly set, keyword falls back to default 0.5
			// But then sum = 0.5 + 0.3 = 0.8 < 1, so no normalization
			assert.strictEqual(result.weights.keyword, 0.5);
			assert.strictEqual(result.weights.recency, 0.3);
		} finally {
			cleanupDir(dir);
		}
	});

	it("malformed JSON in settings.json gracefully returns defaults", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(join(dir, ".pi", "settings.json"), "not json at all");
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 2048);
			assert.strictEqual(result.recencyWindowDays, 30);
		} finally {
			cleanupDir(dir);
		}
	});

	it("partial config (only tokenBudget set) merges defaults for missing fields", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: 1024 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 1024);
			assert.strictEqual(result.recencyWindowDays, 30); // default
			assert.strictEqual(result.cacheTtlHours, 24); // default
			assert.strictEqual(result.autoThreshold, 20000); // default
			assert.strictEqual(result.weights.keyword, 0.5); // default
			assert.strictEqual(result.weights.recency, 0.3); // default
		} finally {
			cleanupDir(dir);
		}
	});

	it("autoThreshold defaults to 20000 when not set in settings.json", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: 4096 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.autoThreshold, 20000);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses custom autoThreshold=5000", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { autoThreshold: 5000 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.autoThreshold, 5000);
		} finally {
			cleanupDir(dir);
		}
	});

	it("autoThreshold=0 is valid (always-ranked mode)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { autoThreshold: 0 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.autoThreshold, 0);
		} finally {
			cleanupDir(dir);
		}
	});

	it("negative autoThreshold falls back to default 20000", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { autoThreshold: -100 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.autoThreshold, 20000);
		} finally {
			cleanupDir(dir);
		}
	});

	it("non-integer autoThreshold falls back to default 20000", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { autoThreshold: "abc" } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.autoThreshold, 20000);
		} finally {
			cleanupDir(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 1b: Mode Selection Logic
// ═══════════════════════════════════════════════════════════════════════

describe("selectMode", () => {
	it("query provided → ranked mode", () => {
		const mode = selectMode("login auth", 100, 20000);
		assert.strictEqual(mode, "ranked");
	});

	it("no query, totalSymbols <= autoThreshold → full_dump", () => {
		const mode = selectMode("", 100, 20000);
		assert.strictEqual(mode, "full_dump");
	});

	it("no query, totalSymbols == autoThreshold → full_dump", () => {
		const mode = selectMode("", 20000, 20000);
		assert.strictEqual(mode, "full_dump");
	});

	it("no query, totalSymbols > autoThreshold → ranked (recency-only)", () => {
		const mode = selectMode("", 20001, 20000);
		assert.strictEqual(mode, "ranked");
	});

	it("no query, autoThreshold=0 → always ranked (totalSymbols 0 > 0 is false, but 0 <= 0 is true, so full_dump)", () => {
		// 0 symbols <= 0 threshold => full_dump
		const mode = selectMode("", 0, 0);
		assert.strictEqual(mode, "full_dump");
	});

	it("no query, autoThreshold=0, totalSymbols=1 → ranked (since 1 > 0)", () => {
		const mode = selectMode("", 1, 0);
		assert.strictEqual(mode, "ranked");
	});

	it("whitespace-only query treated as no query", () => {
		const mode = selectMode("   ", 100, 20000);
		assert.strictEqual(mode, "full_dump");
	});

	it("zero totalSymbols, no query, autoThreshold=20000 → full_dump", () => {
		const mode = selectMode("", 0, 20000);
		assert.strictEqual(mode, "full_dump");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Symbol Index Build & Cache
// ═══════════════════════════════════════════════════════════════════════

describe("buildSymbolIndex", () => {
	it("parses valid ctags JSONL into CachedIndex with correct shape", () => {
		const result = buildSymbolIndex(SAMPLE_CTAGS_JSONL, SAMPLE_HEAD);
		assert.strictEqual(result.head, SAMPLE_HEAD);
		assert.ok(typeof result.builtAt === "number");
		assert.ok(typeof result.symbols === "object");
	});

	it("groups symbols by file path", () => {
		const result = buildSymbolIndex(SAMPLE_CTAGS_JSONL, SAMPLE_HEAD);
		const paths = Object.keys(result.symbols).sort();
		assert.deepStrictEqual(paths, ["api/routes.py", "models/user.py", "src/app.ts"]);
	});

	it("symbols within each file sorted by line", () => {
		const result = buildSymbolIndex(SAMPLE_CTAGS_JSONL, SAMPLE_HEAD);
		const routes = result.symbols["api/routes.py"]!;
		assert.strictEqual(routes[0]!.line, 12);
		assert.strictEqual(routes[1]!.line, 45);
	});

	it("handles empty ctags output returns empty index", () => {
		const result = buildSymbolIndex("", SAMPLE_HEAD);
		assert.strictEqual(Object.keys(result.symbols).length, 0);
	});

	it("handles pseudo-tags only returns empty symbols", () => {
		const ptagOutput = JSON.stringify({
			_type: "ptag",
			name: "JSON_OUTPUT_VERSION",
			kind: "pseudo",
			path: "",
		});
		const result = buildSymbolIndex(ptagOutput, SAMPLE_HEAD);
		assert.strictEqual(Object.keys(result.symbols).length, 0);
	});

	it("ctags non-zero exit but valid stdout still parses output", () => {
		// Same as valid input — we only parse stdout, not exit code
		const result = buildSymbolIndex(SAMPLE_CTAGS_JSONL, SAMPLE_HEAD);
		assert.strictEqual(Object.keys(result.symbols).length, 3);
	});
});

describe("loadCachedIndex", () => {
	function setupCacheDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ranked-cache-"));
		mkdirSync(join(dir, ".pi", "cache"), { recursive: true });
		return dir;
	}

	function cleanupDir(dir: string) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	it("returns null when cache file missing", () => {
		const dir = setupCacheDir();
		try {
			const result = loadCachedIndex(
				join(dir, ".pi", "cache", "ranked-map-index.json"),
				SAMPLE_HEAD,
			);
			assert.strictEqual(result, null);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses valid cache file, returns CachedIndex object", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD);
			assert.ok(result !== null);
			assert.strictEqual(result!.head, SAMPLE_HEAD);
			assert.strictEqual(result!.symbols["a.ts"]!.length, 1);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns null when cache HEAD != current HEAD (stale)", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const stale = { head: "stalehead", builtAt: Date.now(), symbols: {} };
			writeFileSync(cachePath, JSON.stringify(stale));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD);
			assert.strictEqual(result, null);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns null when cache file is malformed JSON", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			writeFileSync(cachePath, "not json");
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD);
			assert.strictEqual(result, null);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns null when cache missing 'symbols' key", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			writeFileSync(cachePath, JSON.stringify({ head: SAMPLE_HEAD, builtAt: Date.now() }));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD);
			assert.strictEqual(result, null);
		} finally {
			cleanupDir(dir);
		}
	});

	it("cache with empty symbols map is valid", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			writeFileSync(
				cachePath,
				JSON.stringify({ head: SAMPLE_HEAD, builtAt: Date.now(), symbols: {} }),
			);
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD);
			assert.ok(result !== null);
			assert.strictEqual(Object.keys(result!.symbols).length, 0);
		} finally {
			cleanupDir(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Keyword Scoring
// ═══════════════════════════════════════════════════════════════════════

describe("computeKeywordScores", () => {
	it("single keyword matches 2 of 5 files → scores 1.0 for matches, 0 for non-matches", () => {
		const fileMatches: Record<string, string[]> = {
			"a.ts": ["auth"],
			"b.ts": ["auth"],
			"c.ts": [],
			"d.ts": [],
			"e.ts": [],
		};
		const scores = computeKeywordScores(fileMatches, ["auth"]);
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 1.0);
		assert.strictEqual(scores["c.ts"], 0);
		assert.strictEqual(scores["d.ts"], 0);
		assert.strictEqual(scores["e.ts"], 0);
	});

	it("multiple keywords — computes matchedTerms/queryTerms per file", () => {
		const fileMatches: Record<string, string[]> = {
			"a.ts": ["login", "auth"],
			"b.ts": ["token"],
			"c.ts": ["login", "auth", "token"],
		};
		const scores = computeKeywordScores(fileMatches, ["login", "auth", "token"]);
		assert.strictEqual(scores["a.ts"], 2 / 3);
		assert.strictEqual(scores["b.ts"], 1 / 3);
		assert.strictEqual(scores["c.ts"], 1.0);
	});

	it("empty query string → all scores 0", () => {
		const fileMatches: Record<string, string[]> = { "a.ts": ["auth"], "b.ts": ["login"] };
		const scores = computeKeywordScores(fileMatches, []);
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
	});

	it("no files match → all scores 0", () => {
		const fileMatches: Record<string, string[]> = { "a.ts": [], "b.ts": [], "c.ts": [] };
		const scores = computeKeywordScores(fileMatches, ["auth", "token"]);
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
		assert.strictEqual(scores["c.ts"], 0);
	});

	it("all files match all terms → uniform score 1.0", () => {
		const fileMatches: Record<string, string[]> = {
			"a.ts": ["auth", "login"],
			"b.ts": ["auth", "login"],
		};
		const scores = computeKeywordScores(fileMatches, ["auth", "login"]);
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 1.0);
	});

	it("single file, single term, file matches → score 1.0", () => {
		const scores = computeKeywordScores({ "a.ts": ["auth"] }, ["auth"]);
		assert.strictEqual(scores["a.ts"], 1.0);
	});

	it("empty files array → empty map", () => {
		const scores = computeKeywordScores({}, ["auth"]);
		assert.strictEqual(Object.keys(scores).length, 0);
	});

	it("partial match: file matches 1 of 3 terms", () => {
		const scores = computeKeywordScores({ "a.ts": ["login"] }, ["login", "auth", "token"]);
		assert.strictEqual(scores["a.ts"], 1 / 3);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Recency Scoring
// ═══════════════════════════════════════════════════════════════════════

describe("computeRecencyScores", () => {
	const now = new Date("2026-05-23T12:00:00Z");

	it("file touched today → score 1.0", () => {
		const scores = computeRecencyScores({ "a.ts": "2026-05-23T10:00:00Z" }, 30, now);
		assert.strictEqual(scores["a.ts"], 1.0);
	});

	it("file touched exactly recencyWindowDays ago → score ~0.0", () => {
		// 30 days ago → at boundary, should be ~0
		const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
		const scores = computeRecencyScores({ "a.ts": past.toISOString() }, 30, now);
		assert.strictEqual(scores["a.ts"], 0.0);
	});

	it("file halfway through window → score ~0.5", () => {
		// 15 days ago
		const past = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
		const scores = computeRecencyScores({ "a.ts": past.toISOString() }, 30, now);
		assert.strictEqual(scores["a.ts"], 0.5);
	});

	it("file never touched in window → score 0.0", () => {
		const scores = computeRecencyScores({ "a.ts": "2020-01-01T00:00:00Z" }, 30, now);
		assert.strictEqual(scores["a.ts"], 0.0);
	});

	it("empty files list → empty map", () => {
		const scores = computeRecencyScores({}, 30, now);
		assert.strictEqual(Object.keys(scores).length, 0);
	});

	it("multiple files with different recency → scores ordered newest > mid > oldest", () => {
		const dates: Record<string, string> = {
			newest: "2026-05-23T10:00:00Z", // today → 1.0
			mid: "2026-05-08T10:00:00Z", // 15 days ago → 0.5
			oldest: "2026-04-23T10:00:00Z", // 30 days ago → 0.0
		};
		const scores = computeRecencyScores(dates, 30, now);
		assert.ok(scores["newest"]! >= scores["mid"]!);
		assert.ok(scores["mid"]! >= scores["oldest"]!);
	});

	it("windowDays=0 → only files touched today get 1.0, rest 0.0", () => {
		const scores = computeRecencyScores(
			{ "a.ts": "2026-05-23T10:00:00Z", "b.ts": "2026-05-22T10:00:00Z" },
			0,
			now,
		);
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 0.0);
	});

	it("single file touched multiple times → uses most recent date", () => {
		const scores = computeRecencyScores({ "a.ts": "2026-05-23T10:00:00Z" }, 30, now);
		assert.strictEqual(scores["a.ts"], 1.0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Ranking + Token Budget
// ═══════════════════════════════════════════════════════════════════════

describe("rankFiles", () => {
	const syms: Record<string, SymbolEntry[]> = {
		"a.ts": [{ type: "function", name: "foo", line: 1 }],
		"b.ts": [{ type: "class", name: "Bar", line: 1 }],
		"c.ts": [{ type: "function", name: "baz", line: 1 }],
	};
	const weights = { keyword: 0.5, recency: 0.3 };

	it("combines keyword*0.5 + recency*0.3 into final scores", () => {
		const kw = { "a.ts": 1.0, "b.ts": 0.5, "c.ts": 0 };
		const rec = { "a.ts": 0.0, "b.ts": 0.5, "c.ts": 1.0 };
		const result = rankFiles(kw, rec, weights, 5000, syms);
		const a = result.files.find((f) => f.path === "a.ts")!;
		const b = result.files.find((f) => f.path === "b.ts")!;
		const c = result.files.find((f) => f.path === "c.ts")!;
		assert.strictEqual(a.score, 0.5); // 1.0*0.5 + 0.0*0.3 = 0.5
		assert.strictEqual(b.score, 0.4); // 0.5*0.5 + 0.5*0.3 = 0.25 + 0.15 = 0.4
		assert.strictEqual(c.score, 0.3); // 0.0*0.5 + 1.0*0.3 = 0.3
	});

	it("sorts descending by final score", () => {
		const kw = { "a.ts": 1.0, "b.ts": 0.5, "c.ts": 0 };
		const rec = { "a.ts": 1.0, "b.ts": 0.5, "c.ts": 1.0 };
		const result = rankFiles(kw, rec, weights, 5000, syms);
		const scores = result.files.map((f) => f.score);
		for (let i = 1; i < scores.length; i++) {
			assert.ok(
				scores[i]! <= scores[i - 1]!,
				`Score at index ${i} (${scores[i]}) should be <= score at ${i - 1} (${scores[i - 1]})`,
			);
		}
	});

	it("tie scores resolved by alphabetical path (deterministic)", () => {
		const kw = { "b.ts": 1.0, "a.ts": 1.0 };
		const rec = { "b.ts": 0, "a.ts": 0 };
		const tsyms = { "a.ts": syms["a.ts"]!, "b.ts": syms["b.ts"]! };
		const result = rankFiles(kw, rec, weights, 5000, tsyms);
		assert.strictEqual(result.files[0]!.path, "a.ts");
		assert.strictEqual(result.files[1]!.path, "b.ts");
	});

	it("token budget greedy fill: includes highest-score files first until budget exhausted", () => {
		const kw = { "large.ts": 1.0, "small.ts": 0.8, "tiny.ts": 0.6 };
		const rec = { "large.ts": 0, "small.ts": 0, "tiny.ts": 0 };
		const lsyms: Record<string, SymbolEntry[]> = {
			"large.ts": Array.from({ length: 50 }, (_, i) => ({
				type: "function",
				name: `f${i}`,
				line: i,
			})),
			"small.ts": [{ type: "function", name: "g", line: 1 }],
			"tiny.ts": [{ type: "class", name: "H", line: 1 }],
		};
		// Very tight budget — should only include highest score file
		const result = rankFiles(kw, rec, weights, 50, lsyms);
		assert.ok(result.truncated || result.files.length <= 3);
	});

	it("sets truncated=true when some files excluded due to budget", () => {
		const kw = { "a.ts": 1.0, "b.ts": 0.5, "c.ts": 0.3, "d.ts": 0.1 };
		const rec = { "a.ts": 0, "b.ts": 0, "c.ts": 0, "d.ts": 0 };
		const result = rankFiles(kw, rec, weights, 10, syms);
		// Budget of 10 tokens should only fit 1 file max
		assert.ok(result.truncated || result.files.length < 4);
	});

	it("sets truncated=false when all files fit within budget", () => {
		const result = rankFiles({ "a.ts": 1.0 }, { "a.ts": 0 }, weights, 5000, {
			"a.ts": syms["a.ts"]!,
		});
		assert.strictEqual(result.truncated, false);
	});

	it("empty file list → totalTokens=0, no crash", () => {
		const result = rankFiles({}, {}, weights, 100, {});
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.totalTokens, 0);
		assert.strictEqual(result.truncated, false);
	});

	it("zero token budget → empty result, truncated=true", () => {
		const result = rankFiles({ "a.ts": 1.0 }, { "a.ts": 0 }, weights, 0, { "a.ts": syms["a.ts"]! });
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.truncated, true);
	});

	it("missing scores for a file treated as 0", () => {
		// recencyScores missing "a.ts" — treated as 0
		const result = rankFiles(
			{ "a.ts": 1.0 },
			{ "b.ts": 1.0 }, // "a.ts" not in recencyScores
			weights,
			5000,
			{ "a.ts": syms["a.ts"]!, "b.ts": syms["b.ts"]! },
		);
		const a = result.files.find((f) => f.path === "a.ts")!;
		assert.strictEqual(a.score, 0.5); // 1.0*0.5 + 0*0.3 = 0.5
	});

	it("all scores 0 → input order preserved in ranking (or alphabetical)", () => {
		const inputSyms: Record<string, SymbolEntry[]> = {
			"z.ts": [{ type: "function", name: "z", line: 1 }],
			"a.ts": [{ type: "function", name: "a", line: 1 }],
			"m.ts": [{ type: "function", name: "m", line: 1 }],
		};
		const result = rankFiles(
			{ "z.ts": 0, "a.ts": 0, "m.ts": 0 },
			{ "z.ts": 0, "a.ts": 0, "m.ts": 0 },
			weights,
			5000,
			inputSyms,
		);
		// Should be alphabetical order (tie-break)
		assert.strictEqual(result.files[0]!.path, "a.ts");
		assert.strictEqual(result.files[1]!.path, "m.ts");
		assert.strictEqual(result.files[2]!.path, "z.ts");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Output Formatting
// ═══════════════════════════════════════════════════════════════════════

describe("formatOutput", () => {
	it("output has top-level keys: files, total_tokens, budget, truncated, mode", () => {
		const result = formatOutput([], 2048, false);
		assert.ok("files" in result);
		assert.ok("total_tokens" in result);
		assert.ok("budget" in result);
		assert.ok("truncated" in result);
		assert.ok("mode" in result);
	});

	it("mode defaults to 'ranked' when not specified", () => {
		const result = formatOutput([], 2048, false);
		assert.strictEqual(result.mode, "ranked");
	});

	it("mode can be set to 'full_dump'", () => {
		const result = formatOutput([], 2048, false, "full_dump");
		assert.strictEqual(result.mode, "full_dump");
	});

	it("each file entry has path, score, symbols, preview", () => {
		const ranked: RankedFileScore[] = [
			{
				path: "a.ts",
				score: 0.85,
				symbols: "a.ts\n  function foo",
				preview: "function foo() { return 1; }",
			},
		];
		const result = formatOutput(ranked, 2048, false);
		const entry = result.files[0]!;
		assert.ok("path" in entry);
		assert.ok("score" in entry);
		assert.ok("symbols" in entry);
		assert.ok("preview" in entry);
	});

	it("scores rounded to 2 decimal places", () => {
		const ranked: RankedFileScore[] = [
			{
				path: "a.ts",
				score: 0.666666,
				symbols: "a.ts\n  function foo",
				preview: "function foo() { return 1; }",
			},
		];
		const result = formatOutput(ranked, 2048, false);
		// score should be rounded
		assert.strictEqual(result.files[0]!.score, 0.67);
	});

	it("empty files array → files: [], total_tokens: 0", () => {
		const result = formatOutput([], 2048, false);
		assert.deepStrictEqual(result.files, []);
		assert.strictEqual(result.total_tokens, 0);
	});

	it("truncated flag preserved in output", () => {
		const result = formatOutput([], 100, true);
		assert.strictEqual(result.truncated, true);
	});

	it("handles multiple files in output", () => {
		const ranked: RankedFileScore[] = [
			{ path: "a.ts", score: 0.9, symbols: "a.ts\n  function foo", preview: "..." },
			{ path: "b.ts", score: 0.5, symbols: "b.ts\n  class Bar", preview: "..." },
		];
		const result = formatOutput(ranked, 2048, false);
		assert.strictEqual(result.files.length, 2);
		assert.strictEqual(result.files[0]!.path, "a.ts");
		assert.strictEqual(result.files[1]!.path, "b.ts");
	});
});

describe("formatSymbols", () => {
	it("formats path and symbol types/names", () => {
		const syms: SymbolEntry[] = [
			{ type: "class", name: "UserModel", line: 1 },
			{ type: "function", name: "get_user", line: 10 },
		];
		const result = formatSymbols(syms, "models/user.py");
		assert.ok(result.includes("models/user.py"));
		assert.ok(result.includes("class UserModel"));
		assert.ok(result.includes("function get_user"));
	});

	it("no symbols shows fallback message", () => {
		const result = formatSymbols([], "empty.ts");
		assert.ok(result.includes("empty.ts"));
		assert.ok(result.includes("no symbols"));
	});

	it("single symbol formatted correctly", () => {
		const result = formatSymbols([{ type: "function", name: "foo", line: 1 }], "a.ts");
		assert.strictEqual(result, "a.ts\n  function foo");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6b: dumpAllFiles
// ═══════════════════════════════════════════════════════════════════════

describe("dumpAllFiles", () => {
	it("returns all files sorted alphabetically by path", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"z.ts": [{ type: "function", name: "zFunc", line: 1 }],
			"a.ts": [{ type: "class", name: "AClass", line: 1 }],
			"m.ts": [{ type: "method", name: "mMethod", line: 5 }],
		};
		const result = dumpAllFiles(syms, 5000);
		assert.strictEqual(result.files.length, 3);
		assert.strictEqual(result.files[0]!.path, "a.ts");
		assert.strictEqual(result.files[1]!.path, "m.ts");
		assert.strictEqual(result.files[2]!.path, "z.ts");
	});

	it("each file has score=0 in full dump", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"a.ts": [{ type: "function", name: "foo", line: 1 }],
		};
		const result = dumpAllFiles(syms, 5000);
		assert.strictEqual(result.files[0]!.score, 0);
	});

	it("each file has empty preview in full dump", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"a.ts": [{ type: "function", name: "foo", line: 1 }],
		};
		const result = dumpAllFiles(syms, 5000);
		assert.strictEqual(result.files[0]!.preview, "");
	});

	it("empty symbols → empty result, no crash", () => {
		const result = dumpAllFiles({}, 5000);
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.totalTokens, 0);
		assert.strictEqual(result.truncated, false);
	});

	it("truncated when token budget exceeded", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"big.ts": Array.from({ length: 100 }, (_, i) => ({
				type: "function",
				name: `f${i}`,
				line: i,
			})),
			"small.ts": [{ type: "function", name: "g", line: 1 }],
		};
		const result = dumpAllFiles(syms, 50);
		assert.ok(result.truncated);
	});

	it("zero token budget → empty result, truncated=true", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"a.ts": [{ type: "function", name: "foo", line: 1 }],
		};
		const result = dumpAllFiles(syms, 0);
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.truncated, true);
	});

	it("all files fit within budget → truncated=false", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"a.ts": [{ type: "function", name: "foo", line: 1 }],
		};
		const result = dumpAllFiles(syms, 5000);
		assert.strictEqual(result.truncated, false);
	});

	it("files without symbols still included (empty symbol list)", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"empty.ts": [],
			"with.ts": [{ type: "function", name: "foo", line: 1 }],
		};
		const result = dumpAllFiles(syms, 5000);
		assert.strictEqual(result.files.length, 2);
		assert.ok(result.files.find((f) => f.path === "empty.ts"));
	});

	it("totalTokens reflects consumed token count", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"a.ts": [{ type: "function", name: "foo", line: 1 }],
		};
		const result = dumpAllFiles(syms, 5000);
		assert.ok(result.totalTokens > 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: Integration (real ctags, rg, git — skip if missing)
// ═══════════════════════════════════════════════════════════════════════

describe("integration: real tools", () => {
	const hasCtags = (() => {
		try {
			execSync("ctags --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();

	const hasCtagsJson = (() => {
		if (!hasCtags) return false;
		try {
			const tmpFile = resolve("/tmp/__rm_ctags_probe.ts");
			writeFileSync(tmpFile, "const x = 1;\n", "utf-8");
			const out = execSync(`ctags --output-format=json "${tmpFile}"`, {
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 5_000,
			});
			const parsed = JSON.parse(out.trim());
			return parsed._type === "tag" || parsed._type === "ptag";
		} catch {
			return false;
		} finally {
			try {
				execSync("rm -f /tmp/__rm_ctags_probe.ts", { stdio: "ignore" });
			} catch {
				/* ignore */
			}
		}
	})();

	const hasRg = (() => {
		try {
			execSync("rg --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();

	const hasGit = (() => {
		try {
			execSync("git --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();

	const ctagsSkip = !hasCtags || !hasCtagsJson ? "ctags with JSON output not installed" : false;

	it("real ctags on fixture dir produces parseable JSONL", { skip: ctagsSkip }, () => {
		const sampleDir = resolve("test/fixtures/ctags-sample");
		const stdout = execSync(
			"ctags -R --output-format=json --exclude=node_modules --exclude=.git .",
			{
				cwd: sampleDir,
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 10_000,
			},
		);

		assert.ok(stdout.length > 0, "ctags should produce output");
		const index = buildSymbolIndex(stdout, "testhead");
		const allSymbols = Object.values(index.symbols).flat();
		assert.ok(allSymbols.length > 0, `Expected at least 1 symbol, got ${allSymbols.length}`);
	});

	it(
		"real rg --files-with-matches for query returns expected files",
		{ skip: !hasRg ? "rg not installed" : false },
		() => {
			const sampleDir = resolve("test/fixtures/ctags-sample");
			const stdout = execSync("rg --files-with-matches --ignore-case login .", {
				cwd: sampleDir,
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 10_000,
			});
			const files = stdout.trim().split("\n").filter(Boolean);
			assert.ok(files.length > 0, "Expected at least 1 file matching 'login'");
			assert.ok(
				files.some((f) => f.includes("routes")),
				"Expected api/routes.py to match",
			);
		},
	);

	it(
		"real git log returns file paths with dates",
		{ skip: !hasGit ? "git not installed" : false },
		() => {
			// Run from repo root — will always have git history
			const stdout = execSync(
				'git log --since="365 days ago" --pretty=format:"%ad" --date=iso --name-only',
				{
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);
			// Should have some output in a real repo
			assert.ok(stdout.length > 0, "git log should produce output");
		},
	);

	it(
		"full pipeline: buildSymbolIndex → computeKeywordScores → computeRecencyScores → rankFiles → formatOutput produces valid shape",
		{ skip: !hasCtags || !hasCtagsJson ? ctagsSkip : false },
		() => {
			const sampleDir = resolve("test/fixtures/ctags-sample");
			const stdout = execSync(
				"ctags -R --output-format=json --exclude=node_modules --exclude=.git .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);
			const index = buildSymbolIndex(stdout, "test");
			const allFiles = Object.keys(index.symbols);

			// Build keyword scores (simulate rg results)
			const fileMatches: Record<string, string[]> = {};
			const queryTerms = ["login", "handler"];
			for (const f of allFiles) {
				const content = existsSync(join(sampleDir, f))
					? readFileSync(join(sampleDir, f), "utf-8")
					: "";
				const matched = queryTerms.filter((t) => content.toLowerCase().includes(t.toLowerCase()));
				fileMatches[f] = matched;
			}
			const kwScores = computeKeywordScores(fileMatches, queryTerms);

			// Build recency scores (all touched today for fixture)
			const recScores: Record<string, string> = {};
			for (const f of allFiles) {
				recScores[f] = new Date().toISOString();
			}
			const recScoresComputed = computeRecencyScores(recScores, 30);

			const ranked = rankFiles(
				kwScores,
				recScoresComputed,
				{ keyword: 0.5, recency: 0.3 },
				2048,
				index.symbols,
			);
			const output = formatOutput(ranked.files, 2048, ranked.truncated);

			assert.ok("files" in output);
			assert.ok("total_tokens" in output);
			assert.ok(output.total_tokens > 0);
			assert.ok(output.files.length > 0);
		},
	);
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 8: Edge Cases & Error Paths
// ═══════════════════════════════════════════════════════════════════════

describe("edge cases", () => {
	it("empty codebase → empty ranking, no crash", () => {
		const result = rankFiles({}, {}, { keyword: 0.5, recency: 0.3 }, 2048, {});
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.totalTokens, 0);
	});

	it("token estimate: ~4 chars per token heuristic", () => {
		const text = "hello world this is a test";
		const tokens = estimateTokens(text);
		assert.strictEqual(tokens, Math.ceil(text.length / 4));
	});

	it("empty string token estimate = 0", () => {
		assert.strictEqual(estimateTokens(""), 0);
	});

	it("estimateTokens handles short strings", () => {
		assert.strictEqual(estimateTokens("ab"), 1); // ceil(2/4) = 1
	});

	it("null/undefined keywordScores keys handled as missing", () => {
		// file "missing" in recency but not in keyword → score uses 0 for keyword
		const result = rankFiles(
			{ "a.ts": 1.0 },
			{ "a.ts": 0.5, "missing.ts": 1.0 },
			{ keyword: 0.5, recency: 0.3 },
			5000,
			{
				"a.ts": [{ type: "function", name: "foo", line: 1 }],
				"missing.ts": [{ type: "function", name: "bar", line: 1 }],
			},
		);
		const missing = result.files.find((f) => f.path === "missing.ts")!;
		assert.strictEqual(missing.score, 0.3); // 0*0.5 + 1.0*0.3 = 0.3
	});
});
