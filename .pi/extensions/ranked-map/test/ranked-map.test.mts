/**
 * Tests for Ranked Repo Map (keyword + recency scoring for token-efficient codebase context)
 *
 * Imports pure modules and adapters from the modular ranked-map extension.
 * Pure functions tested directly; adapter functions tested with mockExec.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ranked-map/test/ranked-map.test.mts
 *
 * Integration test runs real ctags against .pi/extensions/ranked-map/test/fixtures/ctags-sample/
 * (skipped if ctags not installed).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════
// Module Imports
// ═══════════════════════════════════════════════════════════════════════

// Types
import type {
	RankedMapConfig,
	CachedIndex,
	SymbolEntry,
	RankedEntry,
	RankedFileScore,
	RankedMapResult,
	CtagsTag,
	ExecFn,
} from "../types.ts";

// Config
import { loadRankedMapConfig, DEFAULT_CONFIG, MAX_RECENCY_WINDOW_DAYS } from "../config.ts";

// Ctags
import {
	parseCtagsOutput,
	buildCtagsArgs,
	buildSymbolIndex,
	normalizeCtagsPath,
} from "../ctags.ts";

// Cache
import { loadCachedIndex, computeConfigHash } from "../cache.ts";

// Format
import {
	estimateTokens,
	selectMode,
	dumpAllFiles,
	buildOutputFromEntries,
	formatSymbols,
	formatOutput,
	isHighSignalKind,
} from "../format.ts";

// Scoring
import {
	computeKeywordScores,
	computeBinaryKeywordScores,
	computeRecencyScores,
	rankFiles,
} from "../scoring.ts";

// Adapters
import { runKeywordSearch } from "../search.ts";
import { runGitRecency, getGitHead } from "../git.ts";

// ═══════════════════════════════════════════════════════════════════════
// Mock ExecFn for adapter tests
// ═══════════════════════════════════════════════════════════════════════

/** Create a mock ExecFn that returns canned stdout. */
function mockExecFn(result: {
	stdout?: string;
	stderr?: string;
	code?: number;
	killed?: boolean;
}): ExecFn {
	return async () =>
		Promise.resolve({
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			code: result.code ?? 0,
			killed: result.killed ?? false,
		});
}

/** Create a mock ExecFn that rejects with an error. */
function mockExecFnError(error: Error): ExecFn {
	return async () => Promise.reject(error);
}

/** Create a mock ExecFn with conditional response based on command. */
function mockExecConditional(
	matchFn: (
		cmd: string,
		args: string[],
	) => {
		stdout?: string;
		stderr?: string;
		code?: number;
		killed?: boolean;
	} | null,
): ExecFn {
	return async (command, args, _opts) => {
		const matched = matchFn(command, args);
		if (matched !== null) {
			return {
				stdout: matched.stdout ?? "",
				stderr: matched.stderr ?? "",
				code: matched.code ?? 0,
				killed: matched.killed ?? false,
			};
		}
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
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
// Phase 0: Type Verification (compile-time checks)
// ═══════════════════════════════════════════════════════════════════════

describe("types module exports", () => {
	it("RankedMapConfig is a valid type interface", () => {
		// Compile-time check — verify shape at runtime
		const config: RankedMapConfig = {
			tokenBudget: 2048,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		assert.strictEqual(config.tokenBudget, 2048);
	});

	it("RankedMapConfig accepts weights with fileSize field", () => {
		const config: RankedMapConfig = {
			tokenBudget: 2048,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.6, recency: 0.3, fileSize: 0.1 },
		};
		assert.strictEqual(config.weights.fileSize, 0.1);
	});

	it("RankedMapConfig accepts fileSize=0 (lower bound)", () => {
		const config: RankedMapConfig = {
			tokenBudget: 2048,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.7, recency: 0.3, fileSize: 0 },
		};
		assert.strictEqual(config.weights.fileSize, 0);
	});

	it("RankedMapConfig accepts fileSize=1 (upper bound)", () => {
		const config: RankedMapConfig = {
			tokenBudget: 2048,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0, recency: 0, fileSize: 1 },
		};
		assert.strictEqual(config.weights.fileSize, 1);
	});

	it("RankedMapConfig requires fileSize in weights", () => {
		const config: RankedMapConfig = {
			tokenBudget: 2048,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		assert.strictEqual(config.weights.keyword, 0.5);
		assert.strictEqual(config.weights.recency, 0.3);
		assert.strictEqual(config.weights.fileSize, 0.2);
	});

	it("CachedIndex is a valid type interface", () => {
		const ci: CachedIndex = {
			head: "abc",
			builtAt: 1000,
			symbols: { "a.ts": [{ type: "function", name: "foo", line: 1 }] },
		};
		assert.strictEqual(ci.head, "abc");
	});

	it("CachedIndex accepts optional targetDir field", () => {
		const ci: CachedIndex = {
			head: "abc",
			builtAt: 1000,
			symbols: { "a.ts": [{ type: "function", name: "foo", line: 1 }] },
			targetDir: "src",
		};
		assert.strictEqual(ci.targetDir, "src");

		const ciAbs: CachedIndex = {
			head: "abc",
			builtAt: 1000,
			symbols: { "a.ts": [{ type: "function", name: "foo", line: 1 }] },
			targetDir: "/home/user/project",
		};
		assert.strictEqual(ciAbs.targetDir, "/home/user/project");
	});

	it("SymbolEntry is a valid type interface", () => {
		const se: SymbolEntry = { type: "function", name: "bar", line: 5 };
		assert.strictEqual(se.name, "bar");
	});

	it("RankedFileScore is a valid type interface", () => {
		const rfs: RankedFileScore = {
			path: "a.ts",
			score: 0.5,
			symbols: "a.ts\n  function foo",
			preview: "",
		};
		assert.strictEqual(rfs.path, "a.ts");
	});

	it("RankedMapResult is a valid type interface", () => {
		const rmr: RankedMapResult = {
			files: [],
			total_tokens: 0,
			budget: 2048,
			truncated: false,
			mode: "ranked",
		};
		assert.strictEqual(rmr.mode, "ranked");
	});

	it("CtagsTag is a valid type interface", () => {
		const ct: CtagsTag = {
			_type: "tag",
			name: "foo",
			kind: "function",
			path: "a.ts",
			pattern: "",
		};
		assert.strictEqual(ct.name, "foo");
	});

	it("ExecFn is a valid type", () => {
		const fn: ExecFn = async (_cmd, _args, _opts) => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		});
		assert.strictEqual(typeof fn, "function");
	});
});

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
			assert.strictEqual(result.tokenBudget, 4096);
			assert.strictEqual(result.recencyWindowDays, 30);
			assert.strictEqual(result.cacheTtlHours, 24);
			assert.strictEqual(result.weights.keyword, 0.65);
			assert.strictEqual(result.weights.recency, 0.2);
			assert.strictEqual(result.weights.fileSize, 0.1);
			assert.strictEqual(result.weights.commitCount, 0.05);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns defaults when rankedMap key absent from settings.json", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ theme: "dark" }));
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 4096);
			assert.strictEqual(result.weights.keyword, 0.65);
			assert.strictEqual(result.weights.recency, 0.2);
			assert.strictEqual(result.weights.fileSize, 0.1);
			assert.strictEqual(result.weights.commitCount, 0.05);
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

	it("rejects negative tokenBudget, falls back to default (4096)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: -100 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.tokenBudget, 4096);
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
			assert.strictEqual(result.tokenBudget, 4096);
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
			assert.strictEqual(result.tokenBudget, 4096);
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
			assert.strictEqual(result.weights.keyword, 0.65);
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
			assert.strictEqual(result.tokenBudget, 4096);
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
			// No weights specified: use all defaults
			assert.strictEqual(result.weights.keyword, 0.65);
			assert.strictEqual(result.weights.recency, 0.2);
			assert.strictEqual(result.weights.fileSize, 0.1);
			assert.strictEqual(result.weights.commitCount, 0.05);
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

	it("parses custom fileSize weight from settings.json", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.6, recency: 0.3, fileSize: 0.1 } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.weights.keyword, 0.6);
			assert.strictEqual(result.weights.recency, 0.3);
			assert.strictEqual(result.weights.fileSize, 0.1);
		} finally {
			cleanupDir(dir);
		}
	});

	it("rejects fileSize < 0, falls back to default", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.5, recency: 0.3, fileSize: -0.1 } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.weights.keyword, 0.5);
			assert.strictEqual(result.weights.recency, 0.3);
			assert.strictEqual(result.weights.fileSize, 0.1);
		} finally {
			cleanupDir(dir);
		}
	});

	it("rejects fileSize > 1, falls back to default", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.5, recency: 0.3, fileSize: 1.5 } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.weights.fileSize, 0.1);
		} finally {
			cleanupDir(dir);
		}
	});

	it("rejects non-numeric fileSize, falls back to default", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.5, recency: 0.3, fileSize: "abc" } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.weights.fileSize, 0.1);
		} finally {
			cleanupDir(dir);
		}
	});

	it("normalizes sum of keyword+recency+fileSize when sum > 1", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.8, recency: 0.6, fileSize: 0.6 } } }),
			);
			const result = loadRankedMapConfig(dir);
			// 0.8 + 0.6 + 0.6 = 2.0, normalize: 0.8/2.0 = 0.4, 0.6/2.0 = 0.3, 0.6/2.0 = 0.3
			assert.ok(Math.abs(result.weights.keyword - 0.4) < 0.01);
			assert.ok(Math.abs(result.weights.recency - 0.3) < 0.01);
			assert.ok(Math.abs(result.weights.fileSize! - 0.3) < 0.01);
		} finally {
			cleanupDir(dir);
		}
	});

	it("partial config with only fileSize sets defaults for keyword and recency", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { fileSize: 0.1 } } }),
			);
			const result = loadRankedMapConfig(dir);
			// keyword and recency default when not in weights object
			assert.strictEqual(result.weights.keyword, 0.65);
			assert.strictEqual(result.weights.recency, 0.2);
			assert.strictEqual(result.weights.fileSize, 0.1);
		} finally {
			cleanupDir(dir);
		}
	});

	it("fileSize: 0 does not trigger normalization when keyword+recency+fileSize <= 1", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.5, recency: 0.3, fileSize: 0 } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.weights.keyword, 0.5);
			assert.strictEqual(result.weights.recency, 0.3);
			assert.strictEqual(result.weights.fileSize, 0);
		} finally {
			cleanupDir(dir);
		}
	});

	it("fileSize: 0.2 with keyword 0.5 and recency 0.3 sums to 1.0 exactly, no normalization", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.weights.keyword, 0.5);
			assert.strictEqual(result.weights.recency, 0.3);
			assert.strictEqual(result.weights.fileSize, 0.2);
		} finally {
			cleanupDir(dir);
		}
	});
});

describe("DEFAULT_CONFIG", () => {
	it("exports a constant with correct shape", () => {
		assert.strictEqual(DEFAULT_CONFIG.tokenBudget, 4096);
		assert.strictEqual(DEFAULT_CONFIG.recencyWindowDays, 30);
		assert.strictEqual(DEFAULT_CONFIG.cacheTtlHours, 24);
		assert.strictEqual(DEFAULT_CONFIG.autoThreshold, 20000);
		assert.strictEqual(DEFAULT_CONFIG.weights.keyword, 0.65);
		assert.strictEqual(DEFAULT_CONFIG.weights.recency, 0.2);
		assert.strictEqual(DEFAULT_CONFIG.weights.fileSize, 0.1);
		assert.strictEqual(DEFAULT_CONFIG.weights.commitCount, 0.05);
	});

	it("default weights sum to exactly 1.0", () => {
		const { keyword, recency, fileSize, commitCount } = DEFAULT_CONFIG.weights;
		assert.strictEqual(keyword + recency + (fileSize ?? 0) + (commitCount ?? 0), 1.0);
	});

	it("MAX_RECENCY_WINDOW_DAYS is 365", () => {
		assert.strictEqual(MAX_RECENCY_WINDOW_DAYS, 365);
	});
});

describe("config module has no pi SDK imports", () => {
	it("does not import from @earendil-works/pi-coding-agent", async () => {
		const content = readFileSync(resolve(__dirname, "../config.ts"), "utf-8");
		assert.ok(
			!content.includes("@earendil-works/pi-coding-agent"),
			"config.ts should not import from pi-coding-agent",
		);
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

	it("no query, autoThreshold=0, totalSymbols=0 → full_dump", () => {
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
// Phase 2a: Ctags Parsing (parseCtagsOutput — formerly internal)
// ═══════════════════════════════════════════════════════════════════════

describe("parseCtagsOutput", () => {
	it("parses valid ctags JSONL into CtagsTag[]", () => {
		const tags = parseCtagsOutput(SAMPLE_CTAGS_JSONL);
		assert.strictEqual(tags.length, 6);
		assert.strictEqual(tags[0]!.name, "login_handler");
		assert.strictEqual(tags[0]!.kind, "function");
		assert.strictEqual(tags[0]!.path, "api/routes.py");
	});

	it("skips pseudo-tags", () => {
		const input =
			JSON.stringify({ _type: "ptag", name: "JSON_OUTPUT_VERSION", kind: "pseudo", path: "" }) +
			"\n" +
			JSON.stringify({
				_type: "tag",
				name: "foo",
				kind: "function",
				path: "a.ts",
				pattern: "",
				line: 1,
			});
		const tags = parseCtagsOutput(input);
		assert.strictEqual(tags.length, 1);
		assert.strictEqual(tags[0]!.name, "foo");
	});

	it("skips malformed JSON lines", () => {
		const input =
			"not json\n" +
			JSON.stringify({ _type: "tag", name: "foo", kind: "function", path: "a.ts", pattern: "" });
		const tags = parseCtagsOutput(input);
		assert.strictEqual(tags.length, 1);
		assert.strictEqual(tags[0]!.name, "foo");
	});

	it("handles empty input returns empty array", () => {
		assert.strictEqual(parseCtagsOutput("").length, 0);
	});

	it("handles non-string input returns empty array", () => {
		assert.strictEqual(parseCtagsOutput(null as unknown as string).length, 0);
		assert.strictEqual(parseCtagsOutput(undefined as unknown as string).length, 0);
	});

	it("skips tags with missing required fields", () => {
		const input = JSON.stringify({ _type: "tag", name: "foo" }); // missing kind, path
		assert.strictEqual(parseCtagsOutput(input).length, 0);
	});

	it("filters out JSON-value kinds (defense-in-depth)", () => {
		const input = JSON.stringify({
			_type: "tag",
			name: "myNumber",
			kind: "number",
			path: "data.json",
			pattern: "",
		});
		assert.strictEqual(parseCtagsOutput(input).length, 0);
	});

	it("preserves line field when present", () => {
		const tags = parseCtagsOutput(SAMPLE_CTAGS_JSONL);
		const loginHandler = tags.find((t) => t.name === "login_handler")!;
		assert.strictEqual(loginHandler.line, 12);
	});

	it("line field is undefined when not present in input", () => {
		const input = JSON.stringify({
			_type: "tag",
			name: "foo",
			kind: "function",
			path: "a.ts",
			pattern: "",
		});
		const tags = parseCtagsOutput(input);
		assert.strictEqual(tags[0]!.line, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2b: Ctags Args Building
// ═══════════════════════════════════════════════════════════════════════

describe("buildCtagsArgs", () => {
	it("returns command='ctags' and args array", () => {
		const result = buildCtagsArgs(".", 0);
		assert.strictEqual(result.command, "ctags");
		assert.ok(Array.isArray(result.args));
	});

	it("includes standard excludes", () => {
		const result = buildCtagsArgs("/some/dir", 0);
		assert.ok(result.args.includes("--exclude=node_modules"));
		assert.ok(result.args.includes("--exclude=.git"));
		assert.ok(result.args.includes("--exclude=*.json"));
	});

	it("includes maxDepth arg when > 0", () => {
		const result = buildCtagsArgs(".", 3);
		assert.ok(result.args.includes("--maxdepth=3"));
	});

	it("omits maxDepth when 0 (unlimited)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(!result.args.some((a) => a.startsWith("--maxdepth")));
	});

	it("target directory is last arg", () => {
		const result = buildCtagsArgs("src", 0);
		assert.strictEqual(result.args[result.args.length - 1], "src");
	});

	it("includes --output-format=json", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--output-format=json"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2b-ii: --tag-relative=always ctags flag
// ═══════════════════════════════════════════════════════════════════════

describe("buildCtagsArgs — --tag-relative=always", () => {
	it("includes --tag-relative=always with absolute targetDir", () => {
		const result = buildCtagsArgs("/home/user/project", 0);
		assert.ok(result.args.includes("--tag-relative=always"));
	});

	it("includes --tag-relative=always with relative targetDir", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--tag-relative=always"));
	});

	it("--tag-relative=always appears before targetDir in args", () => {
		const result = buildCtagsArgs("/home/user/project", 0);
		const tagRelativeIdx = result.args.indexOf("--tag-relative=always");
		const targetIdx = result.args.indexOf("/home/user/project");
		assert.ok(tagRelativeIdx >= 0, "--tag-relative=always should be present");
		assert.ok(tagRelativeIdx < targetIdx, "--tag-relative=always should appear before targetDir");
	});

	it("regression: existing excludes still present when --tag-relative=always added", () => {
		const result = buildCtagsArgs("/home/user/project", 0);
		assert.ok(result.args.includes("--exclude=node_modules"));
		assert.ok(result.args.includes("--exclude=.git"));
		assert.ok(result.args.includes("--exclude=*.json"));
		assert.ok(result.args.includes("--exclude=*.jsonl"));
		assert.ok(result.args.includes("--exclude=*.md"));
	});

	it("regression: --output-format=json still present", () => {
		const result = buildCtagsArgs("/home/user/project", 0);
		assert.ok(result.args.includes("--output-format=json"));
	});

	it("regression: targetDir is still last arg", () => {
		const result = buildCtagsArgs("/home/user/project", 0);
		assert.strictEqual(result.args[result.args.length - 1], "/home/user/project");
	});

	it("dedup works, --tag-relative=always present with extraExcludes+absolute dir", () => {
		const result = buildCtagsArgs("/home/user/project", 0, ["extra_dir", "*.extra"]);
		assert.ok(result.args.includes("--tag-relative=always"));
		assert.ok(result.args.includes("--exclude=extra_dir"));
		assert.ok(result.args.includes("--exclude=*.extra"));
		// node_modules should not be duplicated
		const nodeModulesCount = result.args.filter((a) => a === "--exclude=node_modules").length;
		assert.equal(nodeModulesCount, 1, "node_modules should not be duplicated");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2c: Symbol Index Build
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
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2c-ii: Path normalization (defense-in-depth)
// ═══════════════════════════════════════════════════════════════════════

describe("normalizeCtagsPath", () => {
	it("strips targetDir prefix from absolute paths", () => {
		const result = normalizeCtagsPath("/home/user/project/src/foo.ts", "/home/user/project");
		assert.equal(result, "src/foo.ts");
	});

	it("handles targetDir with trailing slash", () => {
		const result = normalizeCtagsPath("/home/user/project/src/foo.ts", "/home/user/project/");
		assert.equal(result, "src/foo.ts");
	});

	it("returns path unchanged when no targetDir", () => {
		const result = normalizeCtagsPath("/absolute/path/to/file.ts", undefined);
		assert.equal(result, "/absolute/path/to/file.ts");
	});

	it("returns path unchanged when targetDir is empty string", () => {
		const result = normalizeCtagsPath("/absolute/path/to/file.ts", "");
		assert.equal(result, "/absolute/path/to/file.ts");
	});

	it("does not modify relative paths", () => {
		const result = normalizeCtagsPath("src/foo.ts", "/home/user/project");
		assert.equal(result, "src/foo.ts");
	});

	it("does not modify paths that don't start with targetDir prefix", () => {
		const result = normalizeCtagsPath("/other/dir/file.ts", "/home/user/project");
		assert.equal(result, "/other/dir/file.ts");
	});

	it("handles empty path", () => {
		const result = normalizeCtagsPath("", "/home/user/project");
		assert.equal(result, "");
	});
});

describe("buildSymbolIndex — targetDir normalization", () => {
	it("normalizes absolute ctags paths when targetDir provided", () => {
		const jsonl = JSON.stringify({
			_type: "tag",
			name: "foo",
			kind: "function",
			path: "/home/user/project/src/foo.ts",
			pattern: "/^foo()$/",
			line: 1,
		});
		const index = buildSymbolIndex(jsonl, "head", undefined, "/home/user/project");
		const keys = Object.keys(index.symbols);
		assert.equal(keys.length, 1);
		assert.equal(keys[0], "src/foo.ts");
	});

	it("preserves absolute paths when targetDir not provided", () => {
		const jsonl = JSON.stringify({
			_type: "tag",
			name: "foo",
			kind: "function",
			path: "/home/user/project/src/foo.ts",
			pattern: "/^foo()$/",
			line: 1,
		});
		const index = buildSymbolIndex(jsonl, "head");
		const keys = Object.keys(index.symbols);
		assert.equal(keys.length, 1);
		assert.equal(keys[0], "/home/user/project/src/foo.ts");
	});

	it("does not modify relative paths when targetDir provided", () => {
		const jsonl = JSON.stringify({
			_type: "tag",
			name: "foo",
			kind: "function",
			path: "src/foo.ts",
			pattern: "/^foo()$/",
			line: 1,
		});
		const index = buildSymbolIndex(jsonl, "head", undefined, "/home/user/project");
		const keys = Object.keys(index.symbols);
		assert.equal(keys.length, 1);
		assert.equal(keys[0], "src/foo.ts");
	});

	it("does not modify paths not matching targetDir prefix", () => {
		const jsonl = JSON.stringify({
			_type: "tag",
			name: "foo",
			kind: "function",
			path: "/other/dir/src/foo.ts",
			pattern: "/^foo()$/",
			line: 1,
		});
		const index = buildSymbolIndex(jsonl, "head", undefined, "/home/user/project");
		const keys = Object.keys(index.symbols);
		assert.equal(keys.length, 1);
		assert.equal(keys[0], "/other/dir/src/foo.ts");
	});

	it("handles empty ctags output with targetDir (no crash)", () => {
		const index = buildSymbolIndex("", "head", undefined, "/home/user/project");
		assert.equal(Object.keys(index.symbols).length, 0);
	});

	it("normalizes paths when some are absolute and some relative", () => {
		const jsonl = [
			JSON.stringify({
				_type: "tag",
				name: "foo",
				kind: "function",
				path: "/home/user/project/src/foo.ts",
				line: 1,
			}),
			JSON.stringify({
				_type: "tag",
				name: "bar",
				kind: "function",
				path: "src/bar.ts",
				line: 10,
			}),
		].join("\n");
		const index = buildSymbolIndex(jsonl, "head", undefined, "/home/user/project");
		const keys = Object.keys(index.symbols).sort();
		assert.deepEqual(keys, ["src/bar.ts", "src/foo.ts"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2d: Cache
// ═══════════════════════════════════════════════════════════════════════

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
// Phase 2e: Config Hash Cache Invalidation
// ═══════════════════════════════════════════════════════════════════════

describe("computeConfigHash", () => {
	it("returns deterministic hash for same config", () => {
		const config: RankedMapConfig = {
			tokenBudget: 4096,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		const hash1 = computeConfigHash(config);
		const hash2 = computeConfigHash(config);
		assert.equal(hash1, hash2);
	});

	it("returns different hash for different config", () => {
		const configA: RankedMapConfig = {
			tokenBudget: 4096,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		const configB: RankedMapConfig = {
			tokenBudget: 8192,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		assert.notEqual(computeConfigHash(configA), computeConfigHash(configB));
	});

	it("returns hex string", () => {
		const config: RankedMapConfig = {
			tokenBudget: 4096,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		const hash = computeConfigHash(config);
		assert.ok(/^[0-9a-f]+$/.test(hash), "hash should be hex string, got: " + hash);
	});

	it("returns different hash when fileSize weight changes (cache invalidation)", () => {
		const baseConfig: RankedMapConfig = {
			tokenBudget: 4096,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		const changedConfig: RankedMapConfig = {
			tokenBudget: 4096,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.1 },
		};
		assert.notEqual(computeConfigHash(baseConfig), computeConfigHash(changedConfig));
	});

	it("different fileSize values produce different hash", () => {
		const configA: RankedMapConfig = {
			tokenBudget: 4096,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		};
		const configB: RankedMapConfig = {
			tokenBudget: 4096,
			recencyWindowDays: 30,
			cacheTtlHours: 24,
			autoThreshold: 20000,
			weights: { keyword: 0.5, recency: 0.3, fileSize: 0 },
		};
		assert.notEqual(computeConfigHash(configA), computeConfigHash(configB));
	});
});

describe("loadCachedIndex — configHash validation", () => {
	function setupCacheDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ranked-cfgcache-"));
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

	it("returns cached index when configHash matches", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				configHash: "abc123",
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, "abc123");
			assert.ok(result !== null);
			assert.equal(result!.head, SAMPLE_HEAD);
			assert.equal(result!.configHash, "abc123");
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns null when configHash mismatches", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const stale = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				configHash: "oldhash",
			};
			writeFileSync(cachePath, JSON.stringify(stale));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, "newhash");
			assert.strictEqual(result, null);
		} finally {
			cleanupDir(dir);
		}
	});

	it("accepts cached index without configHash (backward compat)", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				// no configHash
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			// When current configHash is provided but cached index has none, accept it
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, "currenthash");
			assert.ok(result !== null);
			assert.equal(result!.configHash, undefined);
		} finally {
			cleanupDir(dir);
		}
	});

	it("accepted when no configHash provided and cached has none", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			// No configHash argument: backward compat, no validation
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD);
			assert.ok(result !== null);
		} finally {
			cleanupDir(dir);
		}
	});

	it("accepted when configHash provided but cached has none (backward compat)", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, "anyhash");
			assert.ok(result !== null);
			assert.equal(result!.configHash, undefined);
		} finally {
			cleanupDir(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2f: targetDir Cache Validation
// ═══════════════════════════════════════════════════════════════════════

describe("loadCachedIndex — targetDir validation", () => {
	function setupCacheDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ranked-tgtdir-"));
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

	it("returns cached index when stored targetDir matches current param", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				targetDir: "/home/user/project",
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, undefined, "/home/user/project");
			assert.ok(result !== null, "should return cached index");
			assert.equal(result!.targetDir, "/home/user/project");
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns null when stored targetDir mismatches current param", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const stale = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				targetDir: "/home/user/project",
			};
			writeFileSync(cachePath, JSON.stringify(stale));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, undefined, "/other/project");
			assert.strictEqual(result, null, "should reject cache on targetDir mismatch");
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns null when stored targetDir is parent of current param (not prefix match)", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const stale = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				targetDir: "/home/user/project",
			};
			writeFileSync(cachePath, JSON.stringify(stale));
			const result = loadCachedIndex(
				cachePath,
				SAMPLE_HEAD,
				undefined,
				"/home/user/project/subdir",
			);
			assert.strictEqual(result, null, "should reject cache — not a prefix match");
		} finally {
			cleanupDir(dir);
		}
	});

	it("accepts cache when stored targetDir absent and current param present (backward compat)", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				// no targetDir
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, undefined, "/home/project");
			assert.ok(result !== null, "should accept cache when stored targetDir is absent");
			assert.equal(result!.targetDir, undefined);
		} finally {
			cleanupDir(dir);
		}
	});

	it("accepts cache when stored targetDir present and current param undefined (backward compat)", () => {
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const valid = {
				head: SAMPLE_HEAD,
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
				targetDir: "/home/user/project",
			};
			writeFileSync(cachePath, JSON.stringify(valid));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD); // no targetDir param
			assert.ok(result !== null, "should accept cache when no targetDir validation requested");
			assert.equal(result!.targetDir, "/home/user/project");
		} finally {
			cleanupDir(dir);
		}
	});

	it("existing cache tests still pass when targetDir param is added", () => {
		// HEAD mismatch still rejects
		const dir = setupCacheDir();
		try {
			const cachePath = join(dir, ".pi", "cache", "ranked-map-index.json");
			const stale = {
				head: "differenthead",
				builtAt: Date.now(),
				symbols: { "a.ts": [{ type: "class", name: "A", line: 1 }] },
			};
			writeFileSync(cachePath, JSON.stringify(stale));
			const result = loadCachedIndex(cachePath, SAMPLE_HEAD, undefined, "/some/dir");
			assert.strictEqual(result, null, "HEAD mismatch should still reject");
		} finally {
			cleanupDir(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Keyword Scoring
// ═══════════════════════════════════════════════════════════════════════

describe("computeBinaryKeywordScores (backward compat)", () => {
	it("single keyword matches 2 of 5 files → scores 1.0 for matches, 0 for non-matches", () => {
		const fileMatches: Record<string, string[]> = {
			"a.ts": ["auth"],
			"b.ts": ["auth"],
			"c.ts": [],
			"d.ts": [],
			"e.ts": [],
		};
		const scores = computeBinaryKeywordScores(fileMatches, ["auth"]);
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
		const scores = computeBinaryKeywordScores(fileMatches, ["login", "auth", "token"]);
		assert.strictEqual(scores["a.ts"], 2 / 3);
		assert.strictEqual(scores["b.ts"], 1 / 3);
		assert.strictEqual(scores["c.ts"], 1.0);
	});

	it("empty query string → all scores 0", () => {
		const fileMatches: Record<string, string[]> = { "a.ts": ["auth"], "b.ts": ["login"] };
		const scores = computeBinaryKeywordScores(fileMatches, []);
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
	});

	it("no files match → all scores 0", () => {
		const fileMatches: Record<string, string[]> = { "a.ts": [], "b.ts": [], "c.ts": [] };
		const scores = computeBinaryKeywordScores(fileMatches, ["auth", "token"]);
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
		assert.strictEqual(scores["c.ts"], 0);
	});

	it("all files match all terms → uniform score 1.0", () => {
		const fileMatches: Record<string, string[]> = {
			"a.ts": ["auth", "login"],
			"b.ts": ["auth", "login"],
		};
		const scores = computeBinaryKeywordScores(fileMatches, ["auth", "login"]);
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 1.0);
	});

	it("single file, single term, file matches → score 1.0", () => {
		const scores = computeBinaryKeywordScores({ "a.ts": ["auth"] }, ["auth"]);
		assert.strictEqual(scores["a.ts"], 1.0);
	});

	it("empty files array → empty map", () => {
		const scores = computeBinaryKeywordScores({}, ["auth"]);
		assert.strictEqual(Object.keys(scores).length, 0);
	});

	it("partial match: file matches 1 of 3 terms", () => {
		const scores = computeBinaryKeywordScores({ "a.ts": ["login"] }, ["login", "auth", "token"]);
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
		const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
		const scores = computeRecencyScores({ "a.ts": past.toISOString() }, 30, now);
		assert.strictEqual(scores["a.ts"], 0.0);
	});

	it("file halfway through window → score ~0.5", () => {
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
			newest: "2026-05-23T10:00:00Z",
			mid: "2026-05-08T10:00:00Z",
			oldest: "2026-04-23T10:00:00Z",
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
		assert.strictEqual(a.score, 0.5);
		assert.strictEqual(b.score, 0.4);
		assert.strictEqual(c.score, 0.3);
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

	it("sets truncated=true when some files excluded due to budget", () => {
		const kw = { "a.ts": 1.0, "b.ts": 0.5, "c.ts": 0.3, "d.ts": 0.1 };
		const rec = { "a.ts": 0, "b.ts": 0, "c.ts": 0, "d.ts": 0 };
		const result = rankFiles(kw, rec, weights, 10, syms);
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
		const result = rankFiles({ "a.ts": 1.0 }, { "b.ts": 1.0 }, weights, 5000, {
			"a.ts": syms["a.ts"]!,
			"b.ts": syms["b.ts"]!,
		});
		const a = result.files.find((f) => f.path === "a.ts")!;
		assert.strictEqual(a.score, 0.5);
	});

	it("all scores 0 → alphabetical order preserved in ranking", () => {
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

describe("isHighSignalKind", () => {
	it("returns true for class", () => {
		assert.strictEqual(isHighSignalKind("class"), true);
	});
	it("returns true for function", () => {
		assert.strictEqual(isHighSignalKind("function"), true);
	});
	it("returns true for method", () => {
		assert.strictEqual(isHighSignalKind("method"), true);
	});
	it("returns true for interface", () => {
		assert.strictEqual(isHighSignalKind("interface"), true);
	});
	it("returns true for type", () => {
		assert.strictEqual(isHighSignalKind("type"), true);
	});
	it("returns true for enum", () => {
		assert.strictEqual(isHighSignalKind("enum"), true);
	});
	it("returns false for constant", () => {
		assert.strictEqual(isHighSignalKind("constant"), false);
	});
	it("returns false for variable", () => {
		assert.strictEqual(isHighSignalKind("variable"), false);
	});
	it("returns false for property", () => {
		assert.strictEqual(isHighSignalKind("property"), false);
	});
	it("returns false for member", () => {
		assert.strictEqual(isHighSignalKind("member"), false);
	});
	it("returns false for other", () => {
		assert.strictEqual(isHighSignalKind("other"), false);
	});
	it("returns false for empty string", () => {
		assert.strictEqual(isHighSignalKind(""), false);
	});
	it("is case-sensitive: Class returns false", () => {
		assert.strictEqual(isHighSignalKind("Class"), false);
		assert.strictEqual(isHighSignalKind("Function"), false);
	});
});

describe("formatSymbols", () => {
	it("summarizes mixed symbols with summary line and high-signal lines", () => {
		const syms: SymbolEntry[] = [
			{ type: "class", name: "UserModel", line: 1 },
			{ type: "function", name: "get_user", line: 10 },
			{ type: "constant", name: "DEFAULT_NAME", line: 5 },
			{ type: "variable", name: "tmp", line: 7 },
		];
		const result = formatSymbols(syms, "models/user.py");
		assert.ok(result.includes("models/user.py"));
		assert.ok(result.includes("4 symbols: 1 class, 1 constant, 1 function, 1 variable"));
		assert.ok(result.includes("  class UserModel"));
		assert.ok(result.includes("  function get_user"));
		// Low-signal kinds (constant, variable) appear only in count, not as individual lines
		assert.ok(!result.includes("constant DEFAULT_NAME"));
		assert.ok(!result.includes("variable tmp"));
	});

	it("only constants/variables outputs summary line only", () => {
		const syms: SymbolEntry[] = [
			{ type: "constant", name: "FOO", line: 1 },
			{ type: "variable", name: "bar", line: 2 },
		];
		const result = formatSymbols(syms, "a.ts");
		assert.ok(result.includes("a.ts"));
		assert.ok(result.includes("2 symbols: 1 constant, 1 variable"));
		// No individual lines since both are low-signal
		const linesAfterPath = result.split("\n").slice(1).filter(Boolean);
		assert.strictEqual(linesAfterPath.length, 1); // just the summary line
	});

	it("only high-signal kinds outputs summary + individual lines", () => {
		const syms: SymbolEntry[] = [
			{ type: "class", name: "Foo", line: 1 },
			{ type: "function", name: "bar", line: 5 },
			{ type: "method", name: "baz", line: 10 },
		];
		const result = formatSymbols(syms, "a.ts");
		assert.ok(result.includes("3 symbols: 1 class, 1 function, 1 method"));
		assert.ok(result.includes("  class Foo"));
		assert.ok(result.includes("  function bar"));
		assert.ok(result.includes("  method baz"));
	});

	it("empty array shows fallback message", () => {
		const result = formatSymbols([], "empty.ts");
		assert.ok(result.includes("empty.ts"));
		assert.ok(result.includes("no symbols"));
	});

	it("single high-signal symbol outputs summary + one line", () => {
		const result = formatSymbols([{ type: "function", name: "foo", line: 1 }], "a.ts");
		assert.strictEqual(result, "a.ts\n  1 symbol: 1 function\n  function foo");
	});

	it("40 constants + 3 classes: summary shows counts, only 3 class lines", () => {
		const syms: SymbolEntry[] = [
			...Array.from({ length: 40 }, (_, i) => ({
				type: "constant" as const,
				name: `c${i}`,
				line: i,
			})),
			{ type: "class", name: "A", line: 100 },
			{ type: "class", name: "B", line: 200 },
			{ type: "class", name: "C", line: 300 },
		];
		const result = formatSymbols(syms, "big.ts");
		assert.ok(result.includes("43 symbols: 3 classes, 40 constants"));
		// Only class lines emitted
		assert.ok(result.includes("  class A"));
		assert.ok(result.includes("  class B"));
		assert.ok(result.includes("  class C"));
		// No constant lines
		assert.ok(!result.includes("constant c"));
		// Summary + 3 class lines = 4 additional lines besides path
		const lines = result.split("\n");
		assert.strictEqual(lines.length, 5); // path + summary + 3 class lines
	});

	it("null/undefined symbols falls back to (no symbols) without crash", () => {
		const result1 = formatSymbols(null as unknown as SymbolEntry[], "n.ts");
		assert.ok(result1.includes("(no symbols)"));
		const result2 = formatSymbols(undefined as unknown as SymbolEntry[], "n.ts");
		assert.ok(result2.includes("(no symbols)"));
	});

	it("100 high-signal symbols produces 102 lines (summary + 100 individual)", () => {
		const syms: SymbolEntry[] = Array.from({ length: 100 }, (_, i) => ({
			type: "function" as const,
			name: `f${i}`,
			line: i,
		}));
		const result = formatSymbols(syms, "big.ts");
		const lines = result.split("\n");
		assert.strictEqual(lines.length, 102); // path + summary + 100 lines
		assert.ok(result.includes("100 symbols: 100 functions"));
	});

	it("mixed kinds where count sums to 0 (all filtered) shows (no symbols)", () => {
		// If somehow all symbols have empty type, they're not counted in summary
		const syms: SymbolEntry[] = [
			{ type: "", name: "x", line: 1 },
			{ type: "", name: "y", line: 2 },
		];
		const result = formatSymbols(syms, "a.ts");
		assert.ok(result.includes("(no symbols)"));
	});

	it("summary uses singular for count of 1", () => {
		const result = formatSymbols([{ type: "class", name: "Foo", line: 1 }], "a.ts");
		assert.ok(result.includes("1 symbol"));
		assert.ok(!result.includes("1 symbols"));
	});

	it("summary uses plural for count > 1", () => {
		const syms: SymbolEntry[] = [
			{ type: "class", name: "Foo", line: 1 },
			{ type: "class", name: "Bar", line: 5 },
			{ type: "function", name: "baz", line: 10 },
		];
		const result = formatSymbols(syms, "a.ts");
		assert.ok(result.includes("2 classes"));
		assert.ok(result.includes("1 function"));
		assert.ok(result.includes("3 symbols"));
	});
});

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
// Phase 6b: buildOutputFromEntries helper (shared budget-fill loop)
// ═══════════════════════════════════════════════════════════════════════

describe("buildOutputFromEntries", () => {
	const symA: SymbolEntry[] = [{ type: "function", name: "foo", line: 1 }];
	const symB: SymbolEntry[] = [{ type: "class", name: "Bar", line: 5 }];

	it("single entry fits within budget → 1 file, totalTokens > 0, truncated = false", () => {
		const entries: RankedEntry[] = [{ path: "a.ts", score: 0.0, symbols: symA }];
		const result = buildOutputFromEntries(entries, 5000);
		assert.strictEqual(result.files.length, 1);
		assert.ok(result.totalTokens > 0);
		assert.strictEqual(result.truncated, false);
	});

	it("empty entries array → empty result, no truncation", () => {
		const result = buildOutputFromEntries([], 5000);
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.totalTokens, 0);
		assert.strictEqual(result.truncated, false);
	});

	it("zero token budget → empty files, truncated = true", () => {
		const entries: RankedEntry[] = [{ path: "a.ts", score: 0.5, symbols: symA }];
		const result = buildOutputFromEntries(entries, 0);
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.totalTokens, 0);
		assert.strictEqual(result.truncated, true);
	});

	it("first entry alone fits, second exceeds → 1 file, truncated = true", () => {
		const bigText = Array.from({ length: 200 }, (_, i) => ({
			type: "function",
			name: `f${i}`,
			line: i,
		})) as SymbolEntry[];
		const entries: RankedEntry[] = [
			{ path: "small.ts", score: 0.5, symbols: symA },
			{ path: "big.ts", score: 0.5, symbols: bigText },
		];
		const result = buildOutputFromEntries(entries, 150);
		// First entry should fit (small with 1 symbol = ~1 token + 50 preview ≈ 51 tokens)
		// Second is too big
		assert.strictEqual(result.files.length, 1);
		assert.strictEqual(result.truncated, true);
	});

	it("entry tokens exactly equal budget → included, truncated = false (fits exactly, no truncation needed)", () => {
		const entries: RankedEntry[] = [{ path: "a.ts", score: 0.5, symbols: symA }];
		// The entry will have estimateTokens(formattedSymbols) + 50 preview
		// Use a very tight budget — matching exactly
		const symText = "a.ts\n  1 symbol: 1 function\n  function foo";
		const entryTokens = Math.ceil(symText.length / 4) + 50;
		const result = buildOutputFromEntries(entries, entryTokens);
		assert.strictEqual(result.files.length, 1);
		// Guard is > not >=, so exact fit is not truncated
		assert.strictEqual(result.truncated, false);
	});

	it("budget exactly enough for first 2 of 3 entries → 2 files, truncated = true", () => {
		const entries: RankedEntry[] = [
			{ path: "a.ts", score: 0.5, symbols: symA },
			{ path: "b.ts", score: 0.4, symbols: [{ type: "function", name: "bar", line: 2 }] },
			{ path: "c.ts", score: 0.3, symbols: [{ type: "function", name: "baz", line: 3 }] },
		];
		// a.ts + b.ts tokens + 2*50 preview ≈ 2 small entries
		const entryTokens = Math.ceil("a.ts\n  1 symbol: 1 function\n  function foo".length / 4) + 50;
		const result = buildOutputFromEntries(entries, entryTokens * 2);
		assert.strictEqual(result.files.length, 2);
		assert.strictEqual(result.truncated, true);
	});

	it("all entries fit within budget → all included, truncated = false", () => {
		const entries: RankedEntry[] = [
			{ path: "a.ts", score: 0.5, symbols: symA },
			{ path: "b.ts", score: 0.4, symbols: symB },
		];
		const result = buildOutputFromEntries(entries, 5000);
		assert.strictEqual(result.files.length, 2);
		assert.strictEqual(result.truncated, false);
	});

	it("score values preserved in output", () => {
		const entries: RankedEntry[] = [{ path: "a.ts", score: 0.75, symbols: symA }];
		const result = buildOutputFromEntries(entries, 5000);
		assert.strictEqual(result.files[0]!.score, 0.75);
	});

	it("path values preserved in output", () => {
		const entries: RankedEntry[] = [{ path: "src/main.ts", score: 1.0, symbols: symA }];
		const result = buildOutputFromEntries(entries, 5000);
		assert.strictEqual(result.files[0]!.path, "src/main.ts");
	});

	it("entry with empty SymbolEntry[] produces (no symbols) string, still included", () => {
		const entries: RankedEntry[] = [{ path: "empty.ts", score: 0.5, symbols: [] }];
		const result = buildOutputFromEntries(entries, 5000);
		assert.strictEqual(result.files.length, 1);
		assert.ok(result.files[0]!.symbols.includes("no symbols"));
	});

	it("PREVIEW_TOKEN_ESTIMATE (50) added to each entry's token count", () => {
		const entries: RankedEntry[] = [
			{ path: "a.ts", score: 0.5, symbols: symA },
			{ path: "b.ts", score: 0.5, symbols: [{ type: "function", name: "g", line: 1 }] },
		];
		const result = buildOutputFromEntries(entries, 5000);
		// Two entries, each gets +50 preview tokens added to their symbol tokens
		const expectedSymbolTokens =
			Math.ceil("a.ts\n  1 symbol: 1 function\n  function foo".length / 4) +
			Math.ceil("b.ts\n  1 symbol: 1 function\n  function g".length / 4);
		assert.strictEqual(result.totalTokens, expectedSymbolTokens + 100);
	});

	it("tokenBudget <= 0 guard fires before first entry → empty files + truncated = true even with negative budget", () => {
		const entries: RankedEntry[] = [{ path: "a.ts", score: 0.5, symbols: symA }];
		const result = buildOutputFromEntries(entries, -5);
		assert.strictEqual(result.files.length, 0);
		assert.strictEqual(result.truncated, true);
	});

	it("totalTokens > 0 guard allows first oversized entry through but blocks second", () => {
		const big: SymbolEntry[] = Array.from({ length: 100 }, (_, i) => ({
			type: "function",
			name: `longFuncName_${i}`,
			line: i,
		})) as SymbolEntry[];
		const entries: RankedEntry[] = [
			{ path: "big.ts", score: 0.5, symbols: big },
			{ path: "small.ts", score: 0.3, symbols: symA },
		];
		// Budget enough for exactly the first entry (oversized) but not the second
		const result = buildOutputFromEntries(entries, 50);
		assert.strictEqual(result.files.length, 1);
		assert.strictEqual(result.truncated, true);
	});

	it("RankedEntry type accepts SymbolEntry[] and score: number, returns correct shape", () => {
		const entries: RankedEntry[] = [{ path: "a.ts", score: 0.85, symbols: symA }];
		const result = buildOutputFromEntries(entries, 5000);
		assert.strictEqual(result.files.length, 1);
		assert.strictEqual(result.files[0]!.score, 0.85);
		assert.ok(Array.isArray(result.files));
		assert.strictEqual(typeof result.totalTokens, "number");
		assert.strictEqual(typeof result.truncated, "boolean");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: Adapter Functions (async with mockExec)
// ═══════════════════════════════════════════════════════════════════════

describe("runKeywordSearch (async, mockExec)", () => {
	it("returns fileMatches for matching terms", async () => {
		const mockExec = mockExecFn({
			stdout: "src/app.ts\napi/routes.py\n",
			code: 0,
		});
		const result = await runKeywordSearch(mockExec, "auth login", ".", "/test", undefined);
		assert.ok(result.terms.length > 0);
		// Both terms should find files in the mock output
		assert.ok(Object.keys(result.fileMatches).length > 0);
	});

	it("returns empty when rg fails (non-zero exit)", async () => {
		const mockExec = mockExecFn({
			stdout: "",
			stderr: "",
			code: 1,
		});
		const result = await runKeywordSearch(mockExec, "nonexistent", ".", "/test", undefined);
		assert.strictEqual(Object.keys(result.fileMatches).length, 0);
	});

	it("handles empty query string", async () => {
		const mockExec = mockExecFn({ stdout: "", code: 0 });
		const result = await runKeywordSearch(mockExec, "", ".", "/test", undefined);
		assert.strictEqual(result.terms.length, 0);
		assert.strictEqual(Object.keys(result.fileMatches).length, 0);
	});

	it("calls rg with expected args", async () => {
		let capturedArgs: string[] = [];
		const mockExec = mockExecConditional((cmd, args) => {
			if (cmd === "rg") {
				capturedArgs = args;
				return { stdout: "file.ts\n", code: 0 };
			}
			return null;
		});
		await runKeywordSearch(mockExec, "queryTerm", "src", "/cwd", undefined);
		assert.ok(capturedArgs.includes("--files-with-matches"));
		assert.ok(capturedArgs.includes("--ignore-case"));
		assert.ok(capturedArgs.includes("queryTerm"));
		assert.ok(capturedArgs.includes("src"));
	});

	it("escapes regex special characters in query terms", async () => {
		let capturedTerm = "";
		const mockExec = mockExecConditional((cmd, args) => {
			if (cmd === "rg") {
				capturedTerm = args[args.length - 2]!; // second-to-last is the escaped term
				return { stdout: "", code: 1 };
			}
			return null;
		});
		await runKeywordSearch(mockExec, "file.ts", ".", "/cwd", undefined);
		// The dot should be escaped
		assert.ok(capturedTerm.includes("\\."));
	});
});

describe("runGitRecency (async, mockExec)", () => {
	it("parses git log output into file-date map", async () => {
		const mockStdout = [
			"2026-05-23T10:00:00Z",
			"src/app.ts",
			"src/utils.ts",
			"2026-05-22T10:00:00Z",
			"src/old.ts",
		].join("\n");
		const mockExec = mockExecFn({ stdout: mockStdout, code: 0 });
		const result = await runGitRecency(mockExec, 30, "/test", undefined);
		assert.strictEqual(result["src/app.ts"], "2026-05-23T10:00:00Z");
		assert.strictEqual(result["src/utils.ts"], "2026-05-23T10:00:00Z");
		assert.strictEqual(result["src/old.ts"], "2026-05-22T10:00:00Z");
	});

	it("returns empty map when git log fails", async () => {
		const mockExec = mockExecFn({ stdout: "", code: 128 });
		const result = await runGitRecency(mockExec, 30, "/test", undefined);
		assert.strictEqual(Object.keys(result).length, 0);
	});

	it("returns empty map for empty output", async () => {
		const mockExec = mockExecFn({ stdout: "", code: 0 });
		const result = await runGitRecency(mockExec, 30, "/test", undefined);
		assert.strictEqual(Object.keys(result).length, 0);
	});

	it("only captures most recent date per file (first occurrence)", async () => {
		const mockStdout = [
			"2026-05-23T10:00:00Z",
			"src/app.ts",
			"2026-05-22T10:00:00Z",
			"src/app.ts", // same file, older date — should be ignored
		].join("\n");
		const mockExec = mockExecFn({ stdout: mockStdout, code: 0 });
		const result = await runGitRecency(mockExec, 30, "/test", undefined);
		assert.strictEqual(result["src/app.ts"], "2026-05-23T10:00:00Z");
	});

	it("calls git log with expected args", async () => {
		let capturedArgs: string[] = [];
		const mockExec = mockExecConditional((cmd, args) => {
			if (cmd === "git" && args[0] === "log") {
				capturedArgs = args;
				return { stdout: "", code: 0 };
			}
			return null;
		});
		await runGitRecency(mockExec, 14, "/test", undefined);
		assert.ok(capturedArgs.some((a) => a.includes("14 days ago")));
		assert.ok(capturedArgs.includes("--name-only"));
		assert.ok(capturedArgs.includes("--diff-filter=AM"));
	});
});

describe("getGitHead (async, mockExec)", () => {
	it("returns HEAD hash on success", async () => {
		const mockExec = mockExecFn({ stdout: "abc123def456\n", code: 0 });
		const result = await getGitHead(mockExec, "/test", undefined);
		assert.strictEqual(result, "abc123def456");
	});

	it("returns null on non-zero exit", async () => {
		const mockExec = mockExecFn({ stdout: "", code: 128 });
		const result = await getGitHead(mockExec, "/test", undefined);
		assert.strictEqual(result, null);
	});

	it("calls git rev-parse HEAD", async () => {
		let capturedArgs: string[] = [];
		const mockExec = mockExecConditional((cmd, args) => {
			if (cmd === "git") {
				capturedArgs = args;
				return { stdout: "abc\n", code: 0 };
			}
			return null;
		});
		await getGitHead(mockExec, "/test", undefined);
		assert.deepStrictEqual(capturedArgs, ["rev-parse", "HEAD"]);
	});
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
		assert.strictEqual(estimateTokens("ab"), 1);
	});

	it("null/undefined keywordScores keys handled as missing", () => {
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
		assert.strictEqual(missing.score, 0.3);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 9: Entry Point Verification
// ═══════════════════════════════════════════════════════════════════════

describe("entry point (index.ts)", () => {
	it("module can be imported without errors", async () => {
		// Dynamic import to verify the module loads
		const mod = await import("../index.ts");
		assert.ok(mod !== undefined);
	});

	it("default export is a function", async () => {
		const mod = await import("../index.ts");
		assert.strictEqual(typeof mod.default, "function");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 10: Integration (real ctags, rg, git — skip if missing)
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
		const sampleDir = resolve(".pi/extensions/ranked-map/test/fixtures/ctags-sample");
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
			const sampleDir = resolve(".pi/extensions/ranked-map/test/fixtures/ctags-sample");
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
			const stdout = execSync(
				'git log --since="365 days ago" --pretty=format:"%ad" --date=iso --name-only',
				{
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);
			assert.ok(stdout.length > 0, "git log should produce output");
		},
	);

	it(
		"full pipeline: buildSymbolIndex → computeBinaryKeywordScores → computeRecencyScores → rankFiles → formatOutput produces valid shape",
		{ skip: !hasCtags || !hasCtagsJson ? ctagsSkip : false },
		() => {
			const sampleDir = resolve(".pi/extensions/ranked-map/test/fixtures/ctags-sample");
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

			const fileMatches: Record<string, string[]> = {};
			const queryTerms = ["login", "handler"];
			for (const f of allFiles) {
				const content = existsSync(join(sampleDir, f))
					? readFileSync(join(sampleDir, f), "utf-8")
					: "";
				const matched = queryTerms.filter((t) => content.toLowerCase().includes(t.toLowerCase()));
				fileMatches[f] = matched;
			}
			const kwScores = computeBinaryKeywordScores(fileMatches, queryTerms);

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
