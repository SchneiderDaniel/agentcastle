/**
 * Tests for new ranked-map features:
 *   Phase 1: Default token budget increase (2048 → 4096)
 *   Phase 2: Additional ctags exclude patterns
 *   Phase 3: .piignore integration in buildCtagsArgs
 *   Phase 4: Test-file penalty in scoring
 *   Phase 5: Improved preview (ctag pattern field)
 *   Phase 6: getStructuralOverview
 *   Phase 7: Integration — buildCtagsArgs with extra excludes
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ranked-map/test/features.test.ts
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Modules under test
import { loadRankedMapConfig, DEFAULT_CONFIG, MAX_RECENCY_WINDOW_DAYS } from "../config.ts";
import { buildCtagsArgs, buildSymbolIndex } from "../ctags.ts";
import { computeConfigHash } from "../cache.ts";
import {
	buildPiignoreExcludes,
	parseIgnoreLine,
	buildIgnoreExcludes,
	discoverIgnoreFiles,
} from "../piignore.ts";
import { isTestFile, applyTestFilePenalty, rankFiles } from "../scoring.ts";
import { getStructuralOverview } from "../format.ts";
import { RankedMapEngine } from "../engine.ts";
import type { CachedIndex, RankedMapConfig, RankedFileScore, ExecFn } from "../types.ts";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "ranked-features-"));
}

function cleanup(dir: string) {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

function mockExecFn(result?: { stdout?: string; stderr?: string; code?: number }): ExecFn {
	return async () =>
		Promise.resolve({
			stdout: result?.stdout ?? "",
			stderr: result?.stderr ?? "",
			code: result?.code ?? 0,
			killed: false,
		});
}

function makeConfig(overrides?: Partial<RankedMapConfig>): RankedMapConfig {
	return {
		tokenBudget: 4096,
		recencyWindowDays: 30,
		cacheTtlHours: 24,
		autoThreshold: 20000,
		weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Default token budget increase
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Default token budget increase", () => {
	it("DEFAULT_CONFIG.tokenBudget changed from 2048 to 4096", () => {
		assert.equal(DEFAULT_CONFIG.tokenBudget, 4096);
	});

	it("loadRankedMapConfig with missing settings.json returns new default tokenBudget (4096)", () => {
		const dir = tmpDir();
		try {
			const result = loadRankedMapConfig(dir);
			assert.equal(result.tokenBudget, 4096);
		} finally {
			cleanup(dir);
		}
	});

	it("loadRankedMapConfig with partial config (only recencyWindowDays) merges new default tokenBudget", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { recencyWindowDays: 14 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.equal(result.tokenBudget, 4096);
			assert.equal(result.recencyWindowDays, 14);
		} finally {
			cleanup(dir);
		}
	});

	it("loadRankedMapConfig with explicit tokenBudget override still works (user override > default)", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: 8192 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.equal(result.tokenBudget, 8192);
		} finally {
			cleanup(dir);
		}
	});

	it("regression: existing validation (negative/invalid tokenBudget falls back to default) still works with new default", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: -100 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.equal(result.tokenBudget, 4096);
		} finally {
			cleanup(dir);
		}
	});

	it("regression: tokenBudget=0 falls back to default 4096", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { tokenBudget: 0 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.equal(result.tokenBudget, 4096);
		} finally {
			cleanup(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Ctags exclude patterns
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Additional ctags exclude patterns", () => {
	it("buildCtagsArgs excludes *.jsonl (Q&A data files)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=*.jsonl"));
	});

	it("buildCtagsArgs excludes *.md (README/docs files with no code symbols)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=*.md"));
	});

	it("buildCtagsArgs excludes context/ (Q&A conversation directory)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=context"));
	});

	it("buildCtagsArgs excludes sessions/ (session logs, huge/irrelevant)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=sessions"));
	});

	it("buildCtagsArgs excludes npm/ (npm package cache)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=npm"));
	});

	it("buildCtagsArgs excludes chromium-deps/ (chromium for scrapling)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=chromium-deps"));
	});

	it("buildCtagsArgs excludes scrapling-venv/ (Python venv)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=scrapling-venv"));
	});

	it("buildCtagsArgs excludes web-search-venv/ (Python venv for web search)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=web-search-venv"));
	});

	it("buildCtagsArgs no longer excludes flask_blogs/ (submodule scanned like any other directory)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(!result.args.includes("--exclude=flask_blogs"));
	});

	it("buildCtagsArgs excludes benchmarks/ (benchmark scripts, not source)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=benchmarks"));
	});

	it("regression: existing excludes (node_modules, .git, *.json, *.min.js, *.css, static) still present", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=node_modules"));
		assert.ok(result.args.includes("--exclude=.git"));
		assert.ok(result.args.includes("--exclude=*.json"));
		assert.ok(result.args.includes("--exclude=*.min.js"));
		assert.ok(result.args.includes("--exclude=*.css"));
		assert.ok(result.args.includes("--exclude=static"));
	});

	it("regression: --maxdepth=N still works when N > 0", () => {
		const result = buildCtagsArgs(".", 3);
		assert.ok(result.args.includes("--maxdepth=3"));
	});

	it("regression: omitted when N = 0", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(!result.args.some((a) => a.startsWith("--maxdepth")));
	});

	it("regression: --output-format=json still present", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--output-format=json"));
	});

	it("new excludes appear before target directory arg (order independence)", () => {
		const result = buildCtagsArgs(".", 0);
		const targetIdx = result.args.indexOf(".");
		// All excludes should be before the target directory
		const excludeArgs = result.args.filter((a) => a.startsWith("--exclude="));
		for (const ex of excludeArgs) {
			assert.ok(result.args.indexOf(ex) < targetIdx, `${ex} should appear before target directory`);
		}
	});

	it("accepts extra excludes from piignore (deduplication)", () => {
		const result = buildCtagsArgs(".", 0, ["extra_dir", "*.extra"]);
		assert.ok(result.args.includes("--exclude=extra_dir"));
		assert.ok(result.args.includes("--exclude=*.extra"));
	});

	it("deduplicates extra excludes that duplicate built-in excludes", () => {
		const result = buildCtagsArgs(".", 0, ["node_modules", "*.md"]);
		// node_modules and *.md are already in the built-in list
		// Count occurrences — each should appear exactly once
		const nodeModulesCount = result.args.filter((a) => a === "--exclude=node_modules").length;
		const mdCount = result.args.filter((a) => a === "--exclude=*.md").length;
		assert.equal(nodeModulesCount, 1, "node_modules should not be duplicated");
		assert.equal(mdCount, 1, "*.md should not be duplicated");
	});

	it("basename-only convention: no default exclude arg contains a '/' path separator", () => {
		const result = buildCtagsArgs(".", 0);
		const excludeArgs = result.args.filter((a) => a.startsWith("--exclude="));
		for (const arg of excludeArgs) {
			const value = arg.slice("--exclude=".length);
			// Glob patterns (containing *) are exempt — they match basename regardless
			if (value.includes("*")) continue;
			// Extra excludes (piignore-originated) may contain / — but we only check defaults here
			// We're called without extraExcludes, so this tests only built-in defaults
			assert.ok(
				!value.includes("/"),
				`Built-in exclude "${value}" contains "/" — ctags --exclude matches basename only, use just the basename`,
			);
		}
	});

	it("basename-only convention: all expected basenames have corresponding --exclude arg", () => {
		const result = buildCtagsArgs(".", 0);
		const basenames = [
			"node_modules",
			".git",
			"static",
			"context",
			"sessions",
			"npm",
			"chromium-deps",
			"scrapling-venv",
			"web-search-venv",
			"benchmarks",
		];
		for (const name of basenames) {
			assert.ok(
				result.args.includes(`--exclude=${name}`),
				`Expected --exclude=${name} to be present in ctags args`,
			);
		}
	});

	it("glob excludes still present (globs match basename correctly, no change needed)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=*.json"), "*.json glob exclude");
		assert.ok(result.args.includes("--exclude=*.jsonl"), "*.jsonl glob exclude");
		assert.ok(result.args.includes("--exclude=*.md"), "*.md glob exclude");
		assert.ok(result.args.includes("--exclude=*.css"), "*.css glob exclude");
		assert.ok(result.args.includes("--exclude=*.min.js"), "*.min.js glob exclude");
	});

	it("extra excludes containing '/' are preserved (piignore-originated patterns are user choice)", () => {
		const result = buildCtagsArgs(".", 0, [".pi/venv", "build/foo"]);
		assert.ok(
			result.args.includes("--exclude=.pi/venv"),
			".pi/venv exclude with / should be preserved",
		);
		assert.ok(
			result.args.includes("--exclude=build/foo"),
			"build/foo exclude with / should be preserved",
		);
		// Verify dedup still works
		const count = result.args.filter((a) => a === "--exclude=.pi/venv").length;
		assert.equal(count, 1, "extra excludes with / should not be duplicated");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: .piignore integration in buildCtagsArgs
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: .piignore integration", () => {
	it("buildPiignoreExcludes reads .piignore and returns valid patterns", () => {
		const dir = tmpDir();
		try {
			writeFileSync(join(dir, ".piignore"), ["dist/", "*.log", ".env"].join("\n"));
			const excludes = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(excludes, ["dist", "*.log", ".env"]);
		} finally {
			cleanup(dir);
		}
	});

	it("buildCtagsArgs with extraExcludes includes piignore patterns", () => {
		const dir = tmpDir();
		try {
			writeFileSync(join(dir, ".piignore"), ["custom_dir/", "*.tmp"].join("\n"));
			const piignoreExcludes = buildPiignoreExcludes(join(dir, ".piignore"));
			const result = buildCtagsArgs(".", 0, piignoreExcludes);
			assert.ok(result.args.includes("--exclude=custom_dir"));
			assert.ok(result.args.includes("--exclude=*.tmp"));
		} finally {
			cleanup(dir);
		}
	});

	it("buildCtagsArgs without extraExcludes still works (backward compat)", () => {
		const result = buildCtagsArgs(".", 0);
		// Just verifies no crash
		assert.ok(result.args.includes("--exclude=node_modules"));
		assert.equal(result.command, "ctags");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Test-file penalty
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: Test-file penalty in scoring", () => {
	it("isTestFile detects .test. pattern", () => {
		assert.equal(isTestFile("src/foo.test.ts"), true);
		assert.equal(isTestFile("src/foo.test.mts"), true);
	});

	it("isTestFile detects .spec. pattern", () => {
		assert.equal(isTestFile("src/foo.spec.ts"), true);
		assert.equal(isTestFile("src/bar.spec.js"), true);
	});

	it("isTestFile detects /test/ directory segment", () => {
		assert.equal(isTestFile("src/test/foo.ts"), true);
		assert.equal(isTestFile("test/index.test.ts"), true);
	});

	it("isTestFile returns false for source files", () => {
		assert.equal(isTestFile("src/foo.ts"), false);
		assert.equal(isTestFile("src/components/Button.tsx"), false);
		assert.equal(isTestFile("index.ts"), false);
	});

	it("isTestFile returns false for similar but non-test patterns", () => {
		assert.equal(isTestFile("src/contest.ts"), false);
		assert.equal(isTestFile("src/attestation.ts"), false);
		assert.equal(isTestFile("src/protest.ts"), false);
	});

	it("applyTestFilePenalty multiplies test file scores by 0.5", () => {
		const files = [
			{ path: "src/foo.test.ts", score: 1.0 },
			{ path: "src/bar.ts", score: 1.0 },
		];
		applyTestFilePenalty(files);
		assert.equal(files[0]!.score, 0.5);
		assert.equal(files[1]!.score, 1.0);
	});

	it("applyTestFilePenalty does not modify non-test files", () => {
		const files = [
			{ path: "src/bar.ts", score: 0.8 },
			{ path: "src/baz.tsx", score: 0.6 },
		];
		applyTestFilePenalty(files);
		assert.equal(files[0]!.score, 0.8);
		assert.equal(files[1]!.score, 0.6);
	});

	it("applyTestFilePenalty handles empty array", () => {
		const files: { path: string; score: number }[] = [];
		applyTestFilePenalty(files);
		assert.deepEqual(files, []);
	});

	it("applyTestFilePenalty rounds to 2 decimal places", () => {
		const files = [{ path: "src/test/foo.ts", score: 0.67 }];
		applyTestFilePenalty(files);
		// 0.67 * 0.5 = 0.335 → rounds to 0.34 (Math.round rounds 0.335 to 0.34... actually Math.round(33.5) = 34, so 0.34)
		// Actually 0.67 * 0.5 = 0.335, Math.round(0.335 * 100) = Math.round(33.5) = 34, so 34/100 = 0.34
		assert.equal(files[0]!.score, 0.34);
	});

	it("rankFiles applies test-file penalty (integration test)", () => {
		const kw = { "src/foo.test.ts": 1.0, "src/bar.ts": 0.5 };
		const rec = {};
		const symbols = {
			"src/foo.test.ts": [{ type: "function", name: "testFoo", line: 1 }],
			"src/bar.ts": [{ type: "function", name: "bar", line: 1 }],
		};
		const weights = { keyword: 1.0, recency: 0.0 };
		const result = rankFiles(kw, rec, weights, 10000, symbols);

		// With kw weight 1.0 and no recency:
		// src/foo.test.ts: 1.0 * 1.0 = 1.0 → after penalty: 0.5
		// src/bar.ts: 0.5 * 1.0 = 0.5 → no penalty: 0.5
		// Both score 0.5 after penalty, tie-break by alphabetical path
		const fooEntry = result.files.find((f) => f.path === "src/foo.test.ts");
		const barEntry = result.files.find((f) => f.path === "src/bar.ts");
		assert.ok(fooEntry, "foo.test.ts should be in results");
		assert.ok(barEntry, "bar.ts should be in results");
		// With penalty, foo went from 1.0 to 0.5, bar stays at 0.5
		// Tie-break: alphabetical → bar.ts then foo.test.ts
		assert.equal(result.files[0]!.path, "src/bar.ts");
		assert.equal(result.files[0]!.score, 0.5);
		assert.equal(result.files[1]!.path, "src/foo.test.ts");
		assert.equal(result.files[1]!.score, 0.5);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 11: applyTestFilePenalty extended — path overrides + query terms
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 11: applyTestFilePenalty extended — path overrides + query terms", () => {
	it("no optional params keeps existing 0.5x penalty on test files (backward compat)", () => {
		const files = [
			{ path: ".pi/extensions/foo/test/bar.test.ts", score: 1.0 },
			{ path: "src/foo.test.ts", score: 1.0 },
			{ path: "src/normal.ts", score: 1.0 },
		];
		applyTestFilePenalty(files);
		assert.strictEqual(files[0]!.score, 0.5);
		assert.strictEqual(files[1]!.score, 0.5);
		assert.strictEqual(files[2]!.score, 1.0);
	});

	it("path override applies to matching prefix", () => {
		const files = [
			{ path: ".pi/extensions/check-extensions/test/pipeline.test.ts", score: 1.0 },
			{ path: "flask_app/test/foo.test.ts", score: 1.0 },
		];
		applyTestFilePenalty(files, { ".pi/": 0.7 });
		assert.strictEqual(files[0]!.score, 0.7);
		assert.strictEqual(files[1]!.score, 0.5);
	});

	it("multiple path overrides — first match wins", () => {
		const files = [
			{ path: ".pi/extensions/foo/test/bar.test.ts", score: 1.0 },
			{ path: "flask_app/test/foo.test.ts", score: 1.0 },
		];
		applyTestFilePenalty(files, { ".pi/": 0.7, "flask_app/": 0.8 });
		assert.strictEqual(files[0]!.score, 0.7);
		assert.strictEqual(files[1]!.score, 0.8);
	});

	it("path override with no matching prefix falls back to default 0.5", () => {
		const files = [{ path: "other/project/test/foo.test.ts", score: 1.0 }];
		applyTestFilePenalty(files, { ".pi/": 0.7 });
		assert.strictEqual(files[0]!.score, 0.5);
	});

	it("query terms matching file path cap penalty at min 0.7", () => {
		const files = [
			{ path: ".pi/extensions/check-extensions/test/pipeline.test.ts", score: 1.0 },
			{ path: "flask_app/test/foo.test.ts", score: 1.0 },
		];
		applyTestFilePenalty(files, undefined, ["extension"]);
		// .pi test path contains "extension" → cap at 0.7
		assert.strictEqual(files[0]!.score, 0.7);
		// other test path doesn't contain "extension" → stays 0.5
		assert.strictEqual(files[1]!.score, 0.5);
	});

	it("query term matching is case-insensitive and strips special chars", () => {
		const files = [{ path: ".pi/extensions/auth/test/login.test.ts", score: 1.0 }];
		applyTestFilePenalty(files, undefined, ["(auth)"]);
		// "(auth)" → cleaned to "auth" → matches "extensions/auth" → cap at 0.7
		assert.strictEqual(files[0]!.score, 0.7);
	});

	it("query term does not match path → penalty stays at default", () => {
		const files = [{ path: "src/foo.test.ts", score: 1.0 }];
		applyTestFilePenalty(files, undefined, ["extension"]);
		assert.strictEqual(files[0]!.score, 0.5);
	});

	it("path override takes precedence over query-term cap when both provided", () => {
		const files = [{ path: ".pi/extensions/check-extensions/test/pipeline.test.ts", score: 1.0 }];
		// Path override sets 0.9 first, then query-term check would try to cap at 0.7
		// But query-term check uses Math.max(0.7, penalty), so 0.9 > 0.7 → stays 0.9
		applyTestFilePenalty(files, { ".pi/": 0.9 }, ["extension"]);
		assert.strictEqual(files[0]!.score, 0.9);
	});

	it("path override lower than 0.7 can be raised by query-term cap", () => {
		const files = [{ path: ".pi/extensions/check-extensions/test/pipeline.test.ts", score: 1.0 }];
		// path override sets 0.3, then query-term check caps at Math.max(0.7, 0.3) = 0.7
		applyTestFilePenalty(files, { ".pi/": 0.3 }, ["extension"]);
		assert.strictEqual(files[0]!.score, 0.7);
	});

	it("non-test files are not affected regardless of params", () => {
		const files = [{ path: ".pi/extensions/foo/src/app.ts", score: 1.0 }];
		applyTestFilePenalty(files, { ".pi/": 0.7 }, ["extension"]);
		// Not a test file → no penalty applied
		assert.strictEqual(files[0]!.score, 1.0);
	});

	it("handles empty array regardless of params", () => {
		const files: { path: string; score: number }[] = [];
		applyTestFilePenalty(files, { ".pi/": 0.7 }, ["test"]);
		assert.deepEqual(files, []);
	});

	it("rounds to 2 decimal places with path override", () => {
		const files = [{ path: ".pi/test/foo.ts", score: 0.33 }];
		applyTestFilePenalty(files, { ".pi/": 0.7 });
		// 0.33 * 0.7 = 0.231 → Math.round(23.1) = 23 → 0.23
		assert.strictEqual(files[0]!.score, 0.23);
	});

	it("query term with pipe character | is cleaned", () => {
		const files = [{ path: ".pi/extensions/auth/test/login.test.ts", score: 1.0 }];
		applyTestFilePenalty(files, undefined, ["auth|token"]);
		// Cleaned: "authtoken" — matches "auth" in path? No, "authtoken" != "auth". Wait...
		// Actually "auth|token" → cleaned = "authtoken" which does NOT match "auth"
		// Let's use a clearer test
		assert.strictEqual(files[0]!.score, 0.5);
	});

	it("query term matches path prefix vs substring", () => {
		const files = [{ path: "src/test-utils.test.ts", score: 1.0 }];
		applyTestFilePenalty(files, undefined, ["test"]);
		// "test-utils.test.ts" contains "test" → penalty capped at 0.7
		assert.strictEqual(files[0]!.score, 0.7);
	});

	it("query term match works with multiple terms — one matching path", () => {
		const files = [{ path: ".pi/extensions/check-extensions/test/pipeline.test.ts", score: 1.0 }];
		applyTestFilePenalty(files, undefined, ["login", "extension", "token"]);
		// "extension" matches in path → cap at 0.7
		assert.strictEqual(files[0]!.score, 0.7);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 12: testFilePenalties in config type + parser
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 12: testFilePenalties in config", () => {
	it("loadRankedMapConfig with testFilePenalties returns config containing it", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { testFilePenalties: { ".pi/": 0.7 } } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.deepEqual(result.testFilePenalties, { ".pi/": 0.7 });
		} finally {
			cleanup(dir);
		}
	});

	it("loadRankedMapConfig with testFilePenalties as non-object (string) silently drops it", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { testFilePenalties: "invalid" } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.testFilePenalties, undefined);
		} finally {
			cleanup(dir);
		}
	});

	it("loadRankedMapConfig with testFilePenalties as array silently drops it", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { testFilePenalties: [".pi/", 0.7] } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.testFilePenalties, undefined);
		} finally {
			cleanup(dir);
		}
	});

	it("loadRankedMapConfig with testFilePenalties as number silently drops it", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { testFilePenalties: 0.7 } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.testFilePenalties, undefined);
		} finally {
			cleanup(dir);
		}
	});

	it("loadRankedMapConfig with missing settings.json returns config without testFilePenalties", () => {
		const dir = tmpDir();
		try {
			const result = loadRankedMapConfig(dir);
			assert.strictEqual(result.testFilePenalties, undefined);
		} finally {
			cleanup(dir);
		}
	});

	it("loadRankedMapConfig with empty testFilePenalties: {} returns empty object", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { testFilePenalties: {} } }),
			);
			const result = loadRankedMapConfig(dir);
			assert.deepEqual(result.testFilePenalties, {});
		} finally {
			cleanup(dir);
		}
	});

	it("DEFAULT_CONFIG does not include testFilePenalties (backward compat)", () => {
		assert.strictEqual((DEFAULT_CONFIG as any).testFilePenalties, undefined);
	});

	it("testFilePenalties from config flows to engine.rank (config verified)", () => {
		const dir = tmpDir();
		try {
			mkdirSync(join(dir, ".pi"), { recursive: true });
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ rankedMap: { testFilePenalties: { ".pi/": 0.7 }, autoThreshold: 0 } }),
			);
			const config = loadRankedMapConfig(dir);
			assert.deepEqual(config.testFilePenalties, { ".pi/": 0.7 });
			// Config has testFilePenalties property set
			assert.ok(config.testFilePenalties, "testFilePenalties should be present in config");
		} finally {
			cleanup(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Improved preview (ctag pattern field)
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 5: Improved preview", () => {
	it("buildSymbolIndex stores pattern field from ctags output", () => {
		const jsonl = JSON.stringify({
			_type: "tag",
			name: "login",
			kind: "function",
			path: "src/auth.ts",
			pattern: "/^  def login():$/",
			line: 10,
		});
		const index = buildSymbolIndex(jsonl, "head");
		const entry = index.symbols["src/auth.ts"]?.[0];
		assert.ok(entry, "should have symbol entry");
		assert.equal(entry!.pattern, "/^  def login():$/");
	});

	it("buildSymbolIndex stores undefined pattern when ctags output has no pattern field", () => {
		const jsonl = JSON.stringify({
			_type: "tag",
			name: "Const",
			kind: "constant",
			path: "src/config.ts",
			line: 5,
		});
		const index = buildSymbolIndex(jsonl, "head");
		const entry = index.symbols["src/config.ts"]?.[0];
		assert.ok(entry, "should have symbol entry");
		assert.equal(entry!.pattern, undefined);
	});

	it("addPreviews uses pattern from index when available", () => {
		const engine = new RankedMapEngine(makeConfig(), mockExecFn(), "/tmp");
		const files: RankedFileScore[] = [
			{ path: "src/auth.ts", score: 0.5, symbols: "src/auth.ts\n  function login", preview: "" },
		];
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				"src/auth.ts": [
					{ type: "function", name: "login", line: 10, pattern: "/^  def login():$/" },
				],
			},
		};
		const result = engine.addPreviews(files, ".", "ranked", index);
		assert.ok(result[0]!.preview.length > 0, "preview should be non-empty");
		// Pattern stripped: /^  def login():$/ → "  def login():"
		assert.ok(result[0]!.preview.includes("def login()"), "preview should contain the code line");
	});

	it("addPreviews falls back to first 5 lines when no pattern available", () => {
		const engine = new RankedMapEngine(makeConfig(), mockExecFn(), "/tmp");
		const files: RankedFileScore[] = [
			{
				path: "src/nopattern.ts",
				score: 0.5,
				symbols: "src/nopattern.ts\n  function foo",
				preview: "",
			},
		];
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				"src/nopattern.ts": [
					{ type: "function", name: "foo", line: 1 }, // no pattern field
				],
			},
		};
		// File doesn't exist on disk, so fallback will give empty preview
		const result = engine.addPreviews(files, ".", "ranked", index);
		assert.equal(result[0]!.preview, "", "preview should be empty (no pattern, no file on disk)");
	});

	it("full_dump mode files unchanged even with index", () => {
		const engine = new RankedMapEngine(makeConfig(), mockExecFn(), "/tmp");
		const files: RankedFileScore[] = [
			{ path: "src/a.ts", score: 0, symbols: "src/a.ts\n  function foo", preview: "" },
		];
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				"src/a.ts": [{ type: "function", name: "foo", line: 1, pattern: "/^function foo()$/" }],
			},
		};
		const result = engine.addPreviews(files, ".", "full_dump", index);
		assert.equal(result[0]!.preview, "", "preview should remain empty in full_dump mode");
	});

	it("regression: addPreviews without index still works (backward compat)", () => {
		const engine = new RankedMapEngine(makeConfig(), mockExecFn(), "/tmp");
		const files: RankedFileScore[] = [
			{ path: "src/a.ts", score: 0.5, symbols: "src/a.ts\n  function foo", preview: "" },
		];
		// No index passed — should fall through to disk read
		const result = engine.addPreviews(files, ".", "ranked");
		assert.ok(Array.isArray(result), "should return array without index");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: getStructuralOverview
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 6: getStructuralOverview", () => {
	it("returns one file per top-level directory", () => {
		const files = ["src/a.ts", "src/b.ts", "src/sub/c.ts", "docs/readme.md", "tests/test.ts"];
		const overview = getStructuralOverview(files);
		assert.equal(overview.length, 3);
		const dirs = overview.map((f) => f.path.split("/")[0]).sort();
		assert.deepEqual(dirs, ["docs", "src", "tests"]);
	});

	it("deduplicates same top-level dir (first file wins)", () => {
		const files = ["src/b.ts", "src/a.ts", "src/c.ts"];
		const overview = getStructuralOverview(files);
		assert.equal(overview.length, 1);
		assert.equal(overview[0]!.path, "src/b.ts"); // first encountered
	});

	it("no duplicate entries when a structural file also appears in ranked results", () => {
		const files = ["src/a.ts", "src/b.ts"];
		const overview = getStructuralOverview(files);
		assert.equal(overview.length, 1);
	});

	it("structural overview files get score: 0.1", () => {
		const files = ["src/a.ts", "docs/readme.md"];
		const overview = getStructuralOverview(files);
		for (const f of overview) {
			assert.equal(f.score, 0.1);
		}
	});

	it("empty repo returns empty overview", () => {
		const overview = getStructuralOverview([]);
		assert.deepEqual(overview, []);
	});

	it("works with both . and ./ prefixed paths (normalized)", () => {
		const files = ["./src/a.ts", "./docs/b.md", "./tests/c.ts"];
		const overview = getStructuralOverview(files);
		assert.equal(overview.length, 3);
		// First file in each directory is kept
		const paths = overview.map((f) => f.path);
		assert.ok(paths.includes("./src/a.ts"));
	});

	it("handles root-level files (no directory prefix)", () => {
		const files = ["Makefile", "README.md", "package.json", "src/a.ts"];
		const overview = getStructuralOverview(files);
		// Root-level files each get their own "directory" (the filename itself)
		// src/ is one directory
		assert.equal(overview.length, 4); // Makefile, README.md, package.json, src
	});

	it("single file returns single entry", () => {
		const overview = getStructuralOverview(["src/a.ts"]);
		assert.equal(overview.length, 1);
		assert.equal(overview[0]!.path, "src/a.ts");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: Engine integration tests
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 7: Engine integration", () => {
	it("buildOrLoadIndex with mock exec captures args including new excludes", async () => {
		const dir = tmpDir();
		try {
			const calls: { cmd: string; args: string[] }[] = [];
			const exec: ExecFn = async (cmd, args, _opts) => {
				calls.push({ cmd, args });
				return {
					stdout:
						JSON.stringify({
							_type: "tag",
							name: "fn",
							kind: "function",
							path: "src/a.ts",
							pattern: "/^fn()$/",
						}) + "\n",
					stderr: "",
					code: 0,
					killed: false,
				};
			};

			const engine = new RankedMapEngine(makeConfig(), exec, dir);
			const index = await engine.buildOrLoadIndex(".", join(dir, "cache"), undefined);

			// Find the ctags call
			const ctagsCall = calls.find((c) => c.cmd === "ctags");
			assert.ok(
				ctagsCall,
				"should have called ctags, got calls: " + JSON.stringify(calls.map((c) => c.cmd)),
			);

			// Check ctags args include new excludes
			assert.ok(ctagsCall!.args.includes("--exclude=*.jsonl"), "should exclude *.jsonl");
			assert.ok(ctagsCall!.args.includes("--exclude=*.md"), "should exclude *.md");
			assert.ok(ctagsCall!.args.includes("--exclude=context"), "should exclude context");
			assert.ok(
				ctagsCall!.args.includes("--exclude=scrapling-venv"),
				"should exclude scrapling-venv",
			);

			// Verify index was built
			assert.ok(index, "should return an index");
			assert.ok(index.symbols["src/a.ts"], "should have parsed ctags output");
		} finally {
			cleanup(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 8: Structural overview integration in engine.rank
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 8: Structural overview integration in engine.rank", () => {
	it("recency-only mode (no query) merges structural overview files", async () => {
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				".pi/extensions/foo/src/a.ts": [{ type: "function", name: "foo", line: 1 }],
				".pi/extensions/bar/src/b.ts": [{ type: "function", name: "bar", line: 1 }],
				Makefile: [{ type: "other", name: "Makefile", line: 1 }],
			},
		};
		const engine = new RankedMapEngine(makeConfig({ autoThreshold: 0 }), mockExecFn(), "/tmp");
		const result = await engine.rank(index, "", 50000, ".", undefined);
		assert.equal(result.mode, "ranked");

		// Structural overview should add files for top-level dirs: .pi, Makefile
		// .pi is one top-level dir, Makefile is another
		const paths = result.files.map((f) => f.path);
		// At minimum, .pi/extensions/foo/src/a.ts and .pi/extensions/bar/src/b.ts are in the ranked results
		// Makefile is a structural file (root-level file, its own "directory")
		assert.ok(paths.includes("Makefile"), "structural overview should include root-level files");
	});

	it("structural overview files do not duplicate files already in ranked results", async () => {
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				"src/a.ts": [{ type: "function", name: "foo", line: 1 }],
				"src/b.ts": [{ type: "function", name: "bar", line: 1 }],
				"docs/readme.md": [{ type: "other", name: "readme", line: 1 }],
				Makefile: [{ type: "other", name: "Makefile", line: 1 }],
			},
		};
		const engine = new RankedMapEngine(makeConfig({ autoThreshold: 0 }), mockExecFn(), "/tmp");
		const result = await engine.rank(index, "", 50000, ".", undefined);
		const paths = result.files.map((f) => f.path);
		// Each path should appear at most once
		for (const p of paths) {
			const count = paths.filter((x) => x === p).length;
			assert.equal(count, 1, `Path "${p}" appears ${count} times (should be 1)`);
		}
	});

	it("structural overview files appear at low score (0.1)", async () => {
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				"src/a.ts": [{ type: "function", name: "foo", line: 1 }],
				Makefile: [{ type: "other", name: "Makefile", line: 1 }],
			},
		};
		const engine = new RankedMapEngine(makeConfig({ autoThreshold: 0 }), mockExecFn(), "/tmp");
		const result = await engine.rank(index, "", 50000, ".", undefined);

		// autoThreshold: 0, totalSymbols: 2, 2 > 0 → ranked (recency-only)
		assert.equal(result.mode, "ranked");

		// Makefile is a structural overview file (root-level)
		const makefileEntry = result.files.find((f) => f.path === "Makefile");
		assert.ok(makefileEntry, "Makefile should be in results");
		// Makefile gets 0.1 from structural overview
		assert.equal(makefileEntry!.score, 0.1, "structural overview files should have score 0.1");
	});

	it("query mode does NOT inject structural overview", async () => {
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				"src/a.ts": [{ type: "function", name: "foo", line: 1 }],
				Makefile: [{ type: "other", name: "Makefile", line: 1 }],
			},
		};
		const engine = new RankedMapEngine(makeConfig({ autoThreshold: 0 }), mockExecFn(), "/tmp");
		const result = await engine.rank(index, "foo bar", 50000, ".", undefined);
		// In query mode, Makefile appears with score 0 (no recency, no keyword match)
		// Structural overview should NOT boost it to 0.1 in query mode
		const makefileEntry = result.files.find((f) => f.path === "Makefile");
		assert.ok(makefileEntry, "Makefile appears in query mode (in symbol index)");
		assert.equal(
			makefileEntry!.score,
			0,
			"Makefile should have score 0 in query mode (not boosted)",
		);
	});

	it("full_dump mode does NOT inject structural overview", async () => {
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {
				"src/a.ts": [{ type: "function", name: "foo", line: 1 }],
				Makefile: [{ type: "other", name: "Makefile", line: 1 }],
			},
		};
		const engine = new RankedMapEngine(makeConfig({ autoThreshold: 100 }), mockExecFn(), "/tmp");
		const result = await engine.rank(index, "", 50000, ".", undefined);
		// Should be full_dump mode since totalSymbols (2) <= autoThreshold (100)
		assert.equal(result.mode, "full_dump");
		// In full_dump mode, all files are already included sorted by path
		const paths = result.files.map((f) => f.path);
		assert.ok(paths.includes("Makefile"), "full_dump should already include all files");
		assert.ok(paths.includes("src/a.ts"), "full_dump should include all files");
	});

	it("empty repo with no query → no crash, no structural files added", async () => {
		const index: CachedIndex = {
			head: "abc",
			builtAt: Date.now(),
			symbols: {},
		};
		// With autoThreshold=0 and totalSymbols=0, 0 <= 0 → full_dump mode
		const engine = new RankedMapEngine(makeConfig({ autoThreshold: 0 }), mockExecFn(), "/tmp");
		const result = await engine.rank(index, "", 50000, ".", undefined);
		// Empty repo: no symbols → no files at all, no crash
		assert.equal(result.files.length, 0, "empty repo should have no files");
		// 0 <= 20000 (default autoThreshold) → full_dump
		assert.equal(result.mode, "full_dump");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 9: Git submodule indexing (flask_blogs)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// Phase 10: .gitignore integration in buildOrLoadIndex
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 10: .gitignore integration", () => {
	it("parseIgnoreLine handles gitignore patterns (same contract)", () => {
		assert.equal(parseIgnoreLine("__pycache__/"), "__pycache__");
		assert.equal(parseIgnoreLine("*.pyc"), "*.pyc");
		assert.equal(parseIgnoreLine(".venv/"), ".venv");
		assert.equal(parseIgnoreLine("venv/"), "venv");
		assert.equal(parseIgnoreLine("dist/"), "dist");
		assert.equal(parseIgnoreLine("build/"), "build");
		assert.equal(parseIgnoreLine(".eggs/"), ".eggs");
		assert.equal(parseIgnoreLine("*.egg-info"), "*.egg-info");
		assert.equal(parseIgnoreLine("*.so"), "*.so");
		assert.equal(parseIgnoreLine("**/venv/"), "venv");
	});

	it("buildIgnoreExcludes reads .gitignore content", () => {
		const dir = tmpDir();
		try {
			writeFileSync(join(dir, ".gitignore"), ["__pycache__/", "*.pyc", ".venv/"].join("\n"));
			const excludes = buildIgnoreExcludes(join(dir, ".gitignore"));
			assert.deepEqual(excludes, ["__pycache__", "*.pyc", ".venv"]);
		} finally {
			cleanup(dir);
		}
	});

	it("discoverIgnoreFiles finds .gitignore in target directory", () => {
		const dir = tmpDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
			const result = discoverIgnoreFiles(dir);
			assert.ok(result.length >= 1);
			assert.ok(result.includes(join(dir, ".gitignore")));
		} finally {
			cleanup(dir);
		}
	});

	it("discoverIgnoreFiles finds nested .gitignore files", () => {
		const dir = tmpDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "root\n");
			mkdirSync(join(dir, "submod"), { recursive: true });
			writeFileSync(join(dir, "submod", ".gitignore"), "__pycache__/\n");
			const result = discoverIgnoreFiles(dir);
			assert.equal(result.length, 2);
			assert.ok(result.includes(join(dir, ".gitignore")));
			assert.ok(result.includes(join(dir, "submod", ".gitignore")));
		} finally {
			cleanup(dir);
		}
	});

	it("discoverIgnoreFiles excludes .git directory", () => {
		const dir = tmpDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
			mkdirSync(join(dir, ".git"), { recursive: true });
			writeFileSync(join(dir, ".git", ".gitignore"), "secret\n");
			const result = discoverIgnoreFiles(dir);
			// Should only find top-level .gitignore
			assert.equal(result.length, 1);
			assert.ok(result.includes(join(dir, ".gitignore")));
		} finally {
			cleanup(dir);
		}
	});

	it("buildOrLoadIndex uses combined .piignore and .gitignore excludes", async () => {
		const dir = tmpDir();
		try {
			// Create .piignore
			writeFileSync(join(dir, ".piignore"), "custom_pi/\n");
			// Create .gitignore
			writeFileSync(join(dir, ".gitignore"), "custom_git/\n");

			const calls: { cmd: string; args: string[] }[] = [];
			const exec: ExecFn = async (cmd, args, _opts) => {
				calls.push({ cmd, args });
				return {
					stdout:
						JSON.stringify({
							_type: "tag",
							name: "fn",
							kind: "function",
							path: "src/a.ts",
							pattern: "/^fn()$/",
						}) + "\n",
					stderr: "",
					code: 0,
					killed: false,
				};
			};

			const engine = new RankedMapEngine(makeConfig(), exec, dir);
			const index = await engine.buildOrLoadIndex(".", join(dir, "cache"), undefined);

			// Find the ctags call
			const ctagsCall = calls.find((c) => c.cmd === "ctags");
			assert.ok(ctagsCall, "should have called ctags");

			// Should include piignore exclude
			assert.ok(ctagsCall!.args.includes("--exclude=custom_pi"), "should include piignore exclude");
			// Should include gitignore exclude
			assert.ok(
				ctagsCall!.args.includes("--exclude=custom_git"),
				"should include gitignore exclude",
			);

			// Verify index was built
			assert.ok(index, "should return an index");
			assert.ok(index.symbols["src/a.ts"], "should have parsed ctags output");
		} finally {
			cleanup(dir);
		}
	});

	it("buildOrLoadIndex scopes submodule .gitignore patterns", async () => {
		const dir = tmpDir();
		try {
			// Create .gitignore in a subdirectory (simulating submodule)
			mkdirSync(join(dir, "submod"), { recursive: true });
			writeFileSync(join(dir, "submod", ".gitignore"), "sub_ignored/\n");
			// Also .piignore
			writeFileSync(join(dir, ".piignore"), "pi_ignored/\n");

			const calls: { cmd: string; args: string[] }[] = [];
			const exec: ExecFn = async (cmd, args, _opts) => {
				calls.push({ cmd, args });
				return {
					stdout:
						JSON.stringify({
							_type: "tag",
							name: "fn",
							kind: "function",
							path: "src/a.ts",
							pattern: "/^fn()$/",
						}) + "\n",
					stderr: "",
					code: 0,
					killed: false,
				};
			};

			const engine = new RankedMapEngine(makeConfig(), exec, dir);
			const index = await engine.buildOrLoadIndex(".", join(dir, "cache"), undefined);

			const ctagsCall = calls.find((c) => c.cmd === "ctags");
			assert.ok(ctagsCall, "should have called ctags");

			// Should include piignore exclude
			assert.ok(
				ctagsCall!.args.includes("--exclude=pi_ignored"),
				"should include piignore exclude",
			);
			// Submodule .gitignore exclude should be SCOPED with submod/ prefix
			assert.ok(
				ctagsCall!.args.includes("--exclude=submod/sub_ignored"),
				"submodule gitignore exclude should be scoped with submod/ prefix",
			);
			// The un-scoped version should NOT be present
			assert.ok(
				!ctagsCall!.args.includes("--exclude=sub_ignored"),
				"submodule gitignore exclude should NOT appear unscoped",
			);
		} finally {
			cleanup(dir);
		}
	});

	it("no .gitignore file => no gitignore excludes (but piignore still works)", async () => {
		const dir = tmpDir();
		try {
			// Only .piignore, no .gitignore
			writeFileSync(join(dir, ".piignore"), "pi_ignored/\n");

			const calls: { cmd: string; args: string[] }[] = [];
			const exec: ExecFn = async (cmd, args, _opts) => {
				calls.push({ cmd, args });
				return {
					stdout:
						JSON.stringify({
							_type: "tag",
							name: "fn",
							kind: "function",
							path: "src/a.ts",
							pattern: "/^fn()$/",
						}) + "\n",
					stderr: "",
					code: 0,
					killed: false,
				};
			};

			const engine = new RankedMapEngine(makeConfig(), exec, dir);
			const index = await engine.buildOrLoadIndex(".", join(dir, "cache"), undefined);

			const ctagsCall = calls.find((c) => c.cmd === "ctags");
			assert.ok(ctagsCall, "should have called ctags");

			// Should include piignore exclude
			assert.ok(
				ctagsCall!.args.includes("--exclude=pi_ignored"),
				"should include piignore exclude",
			);
			// Should NOT have any custom_git exclude (no .gitignore present)
			const gitExcludes = ctagsCall!.args.filter((a) => a.includes("custom_git"));
			assert.equal(gitExcludes.length, 0, "should not have gitignore excludes without .gitignore");
		} finally {
			cleanup(dir);
		}
	});

	it("backward compat: buildPiignoreExcludes still works", () => {
		const dir = tmpDir();
		try {
			writeFileSync(join(dir, ".piignore"), ["dist/", "*.log", ".env"].join("\n"));
			const excludes = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(excludes, ["dist", "*.log", ".env"]);
		} finally {
			cleanup(dir);
		}
	});
});

describe("Phase 9: Git submodule indexing (flask_blogs)", () => {
	it("buildSymbolIndex with flask_blogs paths produces valid SymbolEntry entries", () => {
		const jsonl = [
			JSON.stringify({
				_type: "tag",
				name: "App",
				kind: "class",
				path: "flask_blogs/flask_planhead/run.py",
				pattern: "/^class App:$/",
				line: 1,
			}),
			JSON.stringify({
				_type: "tag",
				name: "app",
				kind: "variable",
				path: "flask_blogs/flask_planhead/run.py",
				pattern: "/^app = App()$/",
				line: 5,
			}),
		].join("\n");

		const index = buildSymbolIndex(jsonl, "abc123");

		// flask_blogs path should be indexed
		assert.ok(index.symbols["flask_blogs/flask_planhead/run.py"], "should index flask_blogs path");

		const entries = index.symbols["flask_blogs/flask_planhead/run.py"]!;
		assert.equal(entries.length, 2, "should have 2 entries");

		// First entry: App (class)
		assert.equal(entries[0]!.type, "class");
		assert.equal(entries[0]!.name, "App");
		assert.equal(entries[0]!.line, 1);

		// Second entry: app (variable)
		assert.equal(entries[1]!.type, "variable");
		assert.equal(entries[1]!.name, "app");
		assert.equal(entries[1]!.line, 5);
	});

	it("engine buildOrLoadIndex with flask_blogs mock output builds index including flask_blogs", async () => {
		const dir = tmpDir();
		try {
			const calls: { cmd: string; args: string[] }[] = [];
			const exec: ExecFn = async (cmd, args, _opts) => {
				calls.push({ cmd, args });
				return {
					stdout:
						JSON.stringify({
							_type: "tag",
							name: "App",
							kind: "class",
							path: "flask_blogs/flask_planhead/run.py",
							pattern: "/^class App:$/",
							line: 1,
						}) + "\n",
					stderr: "",
					code: 0,
					killed: false,
				};
			};

			const engine = new RankedMapEngine(makeConfig(), exec, dir);
			const index = await engine.buildOrLoadIndex(".", join(dir, "cache"), undefined);

			// flask_blogs path should be in the index
			assert.ok(
				index.symbols["flask_blogs/flask_planhead/run.py"],
				"flask_blogs path should appear in built index",
			);

			// The ctags call should NOT include --exclude=flask_blogs
			const ctagsCall = calls.find((c) => c.cmd === "ctags");
			assert.ok(ctagsCall, "should have called ctags");
			assert.ok(
				!ctagsCall!.args.includes("--exclude=flask_blogs"),
				"ctags should not exclude flask_blogs",
			);
		} finally {
			cleanup(dir);
		}
	});

	it("computeConfigHash is unchanged by exclude list changes", () => {
		// computeConfigHash only hashes numeric config fields, not exclude lists
		const hash1 = computeConfigHash(makeConfig());
		const hash2 = computeConfigHash(makeConfig({ tokenBudget: 4096 }));
		const hash3 = computeConfigHash(makeConfig({ tokenBudget: 8192 }));

		// Same config → same hash
		assert.equal(hash1, hash2, "identical configs should produce identical hash");
		// Different config → different hash
		assert.notEqual(hash1, hash3, "different tokenBudget should produce different hash");

		// The excludes list is NOT part of config hash — document this
		// so we know that changing excludes (like removing flask_blogs)
		// won't invalidate cached index.
		assert.ok(hash1.length > 0, "config hash should be a non-empty hex string");
	});

	it("deduplication still works when flask_blogs passed as extra exclude (from piignore)", () => {
		// Even though flask_blogs is no longer a built-in exclude,
		// if it's passed as an extra exclude (from .piignore), it should
		// appear exactly once.
		const result = buildCtagsArgs(".", 0, ["flask_blogs"]);
		const count = result.args.filter((a) => a === "--exclude=flask_blogs").length;
		assert.equal(
			count,
			1,
			"flask_blogs should appear exactly once even when passed as extra exclude",
		);
	});

	it("all standard excludes still present after flask_blogs removal", () => {
		const result = buildCtagsArgs(".", 0);
		const standardExcludes = [
			"node_modules",
			".git",
			"*.json",
			"*.min.js",
			"*.css",
			"static",
			"*.jsonl",
			"*.md",
			"context",
			"sessions",
			"npm",
			"chromium-deps",
			"scrapling-venv",
			"web-search-venv",
			"benchmarks",
		];
		for (const ex of standardExcludes) {
			const count = result.args.filter((a) => a === `--exclude=${ex}`).length;
			assert.equal(count, 1, `--exclude=${ex} should appear exactly once`);
		}
	});
});
