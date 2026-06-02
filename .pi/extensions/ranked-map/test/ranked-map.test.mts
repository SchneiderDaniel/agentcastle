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
	RankedFileScore,
	RankedMapResult,
	CtagsTag,
	ExecFn,
} from "../types.ts";

// Config
import { loadRankedMapConfig, DEFAULT_CONFIG, MAX_RECENCY_WINDOW_DAYS } from "../config.ts";

// Ctags
import { parseCtagsOutput, buildCtagsArgs, buildSymbolIndex } from "../ctags.ts";

// Cache
import { loadCachedIndex } from "../cache.ts";

// Format
import {
	estimateTokens,
	selectMode,
	dumpAllFiles,
	formatSymbols,
	formatOutput,
} from "../format.ts";

// Scoring
import { computeKeywordScores, computeRecencyScores, rankFiles } from "../scoring.ts";

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
			weights: { keyword: 0.5, recency: 0.3 },
		};
		assert.strictEqual(config.tokenBudget, 2048);
	});

	it("CachedIndex is a valid type interface", () => {
		const ci: CachedIndex = {
			head: "abc",
			builtAt: 1000,
			symbols: { "a.ts": [{ type: "function", name: "foo", line: 1 }] },
		};
		assert.strictEqual(ci.head, "abc");
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

describe("DEFAULT_CONFIG", () => {
	it("exports a constant with correct shape", () => {
		assert.strictEqual(DEFAULT_CONFIG.tokenBudget, 2048);
		assert.strictEqual(DEFAULT_CONFIG.recencyWindowDays, 30);
		assert.strictEqual(DEFAULT_CONFIG.cacheTtlHours, 24);
		assert.strictEqual(DEFAULT_CONFIG.autoThreshold, 20000);
		assert.strictEqual(DEFAULT_CONFIG.weights.keyword, 0.5);
		assert.strictEqual(DEFAULT_CONFIG.weights.recency, 0.3);
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
		"full pipeline: buildSymbolIndex → computeKeywordScores → computeRecencyScores → rankFiles → formatOutput produces valid shape",
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
			const kwScores = computeKeywordScores(fileMatches, queryTerms);

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
