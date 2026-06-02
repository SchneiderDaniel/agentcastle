/**
 * Tests for Ripgrep Search (ripgrep literal text search)
 *
 * Pure function tests import from .pi/extensions/ripgrep-search/ modules
 * instead of maintaining inline copies (avoids divergence risk).
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ripgrep-search/test/ripgrep-search.test.mts
 *
 * Integration test runs real rg against test/fixtures/ripgrep-sample/
 * (skipped if rg binary not installed).
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Imports from extension modules (replaces inline copies)
// ═══════════════════════════════════════════════════════════════════════

import type { RgMatch, RgResult, SearchConfig } from "../types.ts";
import { loadSearchConfig, resolveBackend, ripgrepAvailable } from "../config.ts";
import { buildRgArgs, buildGrepArgs } from "../args.ts";
import { parseVimgrepOutput, parseGrepOutput } from "../parse.ts";
import { validateQuery } from "../validate.ts";
import { registerTempDir, cleanupTrackedTempDirs, trackedTempDirs } from "../temp.ts";
import { buildSearchErrorText } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

/** Sample rg --vimgrep output simulating matches from a codebase search. */
const TWO_VALID_LINES = [
	"config/settings.py:4:16:TIMEOUT_MS = 5000",
	"docs/readme.md:88:5:Set timeout to 5000.",
].join("\n");

/** Empty output. */
const EMPTY_OUTPUT = "";

/** Output with one malformed line and one valid line. */
const MALFORMED_OUTPUT = [
	"just a string without colons",
	"src/app.ts:2:18:const TIMEOUT_MS = 5000;",
].join("\n");

/** Line with only two colons (missing column or text). */
const TWO_COLONS_LINE = "file:line";

/** Tab in filename edge case. */
const TAB_IN_FILENAME = "my\tfile.ts:10:5:const x = 1";

/** Text contains colons. */
const TEXT_WITH_COLONS = "file:1:1:ERROR: 5000: timeout";

/** Empty text after last colon. */
const EMPTY_TEXT_LINE = "file:1:1:";

/** Non-numeric line/column. */
const INVALID_NUMBERS = "file:abc:def:text";

/** Sample grep -rnH output. */
const GREP_TWO_LINES = [
	"src/app.ts:2:const TIMEOUT_MS = 5000;",
	"config/settings.py:4:TIMEOUT_MS = 5000",
].join("\n");

/** Grep output with colons in text. */
const GREP_TEXT_WITH_COLONS = "src/log.ts:10:ERROR: 5000: timeout";

/** Grep output empty. */
const GREP_EMPTY = "";

/** Grep malformed line. */
const GREP_MALFORMED = "no colons here";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("validateQuery", () => {
	it("rejects 'class User' (collision rule)", () => {
		const result = validateQuery("class User");
		assert.ok(result !== null, "Expected error for class definition pattern");
		assert.ok(result!.includes("ranked_map"), "Error should mention ranked_map");
	});

	it("rejects 'def verify_token' (collision rule)", () => {
		const result = validateQuery("def verify_token");
		assert.ok(result !== null);
		assert.ok(result!.includes("ranked_map"));
	});

	it("rejects 'function bootstrap' (collision rule)", () => {
		const result = validateQuery("function bootstrap");
		assert.ok(result !== null);
		assert.ok(result!.includes("ranked_map"));
	});

	it("rejects pattern with $ (structural syntax)", () => {
		const result = validateQuery("console.log($A)");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects pattern with { (structural syntax)", () => {
		const result = validateQuery("try { $$$BODY }");
		assert.ok(result !== null);
		assert.ok(result!.includes("structural_search"));
	});

	it("rejects empty string", () => {
		const result = validateQuery("");
		assert.ok(result !== null);
	});

	it("rejects whitespace-only string", () => {
		const result = validateQuery("   ");
		assert.ok(result !== null);
	});

	it("accepts plain literal 'TIMEOUT_MS = 5000'", () => {
		const result = validateQuery("TIMEOUT_MS = 5000");
		assert.strictEqual(result, null);
	});

	it("accepts single number '5000'", () => {
		const result = validateQuery("5000");
		assert.strictEqual(result, null);
	});

	it("accepts word 'error_log'", () => {
		const result = validateQuery("error_log");
		assert.strictEqual(result, null);
	});

	it("accepts regex 'TODO|FIXME'", () => {
		const result = validateQuery("TODO|FIXME");
		assert.strictEqual(result, null);
	});

	it("accepts dot-query 'user.id'", () => {
		const result = validateQuery("user.id");
		assert.strictEqual(result, null);
	});

	it("accepts natural text 'set timeout to 5000.'", () => {
		const result = validateQuery("set timeout to 5000.");
		assert.strictEqual(result, null);
	});

	it("accepts pattern with dots and parens 'verify_token()'", () => {
		const result = validateQuery("verify_token()");
		assert.strictEqual(result, null);
	});
});

describe("buildRgArgs", () => {
	it("builds default args with max_count=10, directory='.'", () => {
		const { command, args } = buildRgArgs("TIMEOUT_MS = 5000", ".", 10);
		assert.strictEqual(command, "rg");
		assert.ok(args.includes("--vimgrep"));
		assert.ok(args.includes("--max-columns=200"));
		assert.ok(args.includes("--max-count=10"));
		assert.ok(args.includes("--no-heading"));
		assert.ok(args.includes("-j1"));
		assert.ok(args.includes("TIMEOUT_MS = 5000"));
		assert.ok(args.includes("."));
	});

	it("uses custom max_count=5", () => {
		const { args } = buildRgArgs("query", ".", 5);
		assert.ok(args.includes("--max-count=5"));
	});

	it("uses custom directory='src/'", () => {
		const { args } = buildRgArgs("query", "src/", 10);
		assert.strictEqual(args[args.length - 1], "src/");
	});

	it("query with backticks passed as separate array element (not shell-escaped)", () => {
		const { args } = buildRgArgs("rm -rf /", ".", 10);
		const queryIndex = args.indexOf("rm -rf /");
		assert.ok(queryIndex >= 0, "Query should be a separate array element");
	});

	it("query with spaces is single array element", () => {
		const { args } = buildRgArgs("timeout = 5000", ".", 10);
		const queryIndex = args.indexOf("timeout = 5000");
		assert.ok(queryIndex >= 0, "Query with spaces should be a single array element");
	});

	it("all flags present in correct positions", () => {
		const { command, args } = buildRgArgs("test", ".", 10);
		assert.strictEqual(command, "rg");
		assert.strictEqual(args[0], "--vimgrep");
		assert.ok(args[1]!.startsWith("--max-columns="));
		assert.ok(args[2]!.startsWith("--max-count="));
		assert.strictEqual(args[3], "--no-heading");
		assert.strictEqual(args[4], "-j1");
	});

	it("respects custom maxLineLength", () => {
		const { args } = buildRgArgs("query", ".", 10, 150);
		assert.ok(args.includes("--max-columns=150"));
	});

	it("defaults maxLineLength to 200", () => {
		const { args } = buildRgArgs("query", ".", 10);
		assert.ok(args.includes("--max-columns=200"));
	});
});

describe("buildGrepArgs", () => {
	it("builds default grep args with max_count=10, directory='.'", () => {
		const { command, args } = buildGrepArgs("TIMEOUT_MS = 5000", ".", 10);
		assert.strictEqual(command, "grep");
		assert.ok(args.includes("-rnH"));
		assert.ok(args.includes("-m"));
		assert.ok(args.includes("10"));
		assert.ok(args.includes("--color=never"));
		assert.ok(args.includes("TIMEOUT_MS = 5000"));
		assert.ok(args.includes("."));
	});

	it("includes all --exclude-dir flags", () => {
		const { args } = buildGrepArgs("query", ".", 10);
		assert.ok(args.includes("--exclude-dir=.git"));
		assert.ok(args.includes("--exclude-dir=node_modules"));
		assert.ok(args.includes("--exclude-dir=venv"));
		assert.ok(args.includes("--exclude-dir=__pycache__"));
		assert.ok(args.includes("--exclude-dir=.mypy_cache"));
		assert.ok(args.includes("--exclude-dir=.pytest_cache"));
		assert.ok(args.includes("--exclude-dir=dist"));
		assert.ok(args.includes("--exclude-dir=build"));
	});

	it("excluded dirs appear before -e flag", () => {
		const { args } = buildGrepArgs("query", ".", 10);
		const excludeIdx = args.indexOf("--exclude-dir=.git");
		const eIdx = args.indexOf("-e");
		assert.ok(excludeIdx >= 0, "--exclude-dir=.git should be present");
		assert.ok(eIdx >= 0, "-e should be present");
		assert.ok(excludeIdx < eIdx, "--exclude-dir flags should appear before -e");
	});

	it("uses custom max_count=5", () => {
		const { args } = buildGrepArgs("query", ".", 5);
		const mIdx = args.indexOf("-m");
		assert.ok(mIdx >= 0);
		assert.strictEqual(args[mIdx + 1], "5");
	});

	it("uses custom directory='src/'", () => {
		const { args } = buildGrepArgs("query", "src/", 10);
		assert.strictEqual(args[args.length - 1], "src/");
	});

	it("query is separate array element (no shell injection)", () => {
		const { args } = buildGrepArgs("rm -rf /", ".", 10);
		const queryIndex = args.indexOf("rm -rf /");
		assert.ok(queryIndex >= 0, "Query should be a separate array element");
	});

	it("all flags in expected order", () => {
		const { command, args } = buildGrepArgs("test", ".", 10);
		assert.strictEqual(command, "grep");
		assert.strictEqual(args[0], "-rnH");
		assert.strictEqual(args[1], "-m");
		assert.strictEqual(args[2], "10");
		assert.strictEqual(args[3], "--color=never");
		// Then exclusion dirs
		const excludeStart = args.indexOf("--exclude-dir=.git");
		assert.ok(excludeStart >= 4, "--exclude-dir should start after --color=never");
		// -e comes after all --exclude-dir entries, then query, then directory
		const eIdx = args.indexOf("-e");
		assert.ok(eIdx > excludeStart, "-e should come after all --exclude-dir entries");
		assert.strictEqual(args[eIdx + 1], "test", "query follows -e");
		assert.strictEqual(args[args.length - 1], ".", "directory is last");
	});
});

describe("parseGrepOutput", () => {
	it("parses two valid grep lines", () => {
		const result = parseGrepOutput(GREP_TWO_LINES);
		assert.strictEqual(result.total_returned, 2);
		assert.strictEqual(result.results.length, 2);
		assert.strictEqual(result.results[0]!.file, "src/app.ts");
		assert.strictEqual(result.results[0]!.line, 2);
		assert.strictEqual(result.results[0]!.column, 1);
		assert.strictEqual(result.results[0]!.text, "const TIMEOUT_MS = 5000;");
		assert.strictEqual(result.results[1]!.file, "config/settings.py");
		assert.strictEqual(result.results[1]!.line, 4);
		assert.strictEqual(result.results[1]!.column, 1);
		assert.strictEqual(result.results[1]!.text, "TIMEOUT_MS = 5000");
	});

	it("returns empty result for empty string", () => {
		const result = parseGrepOutput("");
		assert.strictEqual(result.total_returned, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("returns empty result for null input", () => {
		const result = parseGrepOutput(null);
		assert.strictEqual(result.total_returned, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("returns empty result for undefined input", () => {
		const result = parseGrepOutput(undefined);
		assert.strictEqual(result.total_returned, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("sets column to 1 for all matches", () => {
		const result = parseGrepOutput(GREP_TWO_LINES);
		for (const r of result.results) {
			assert.strictEqual(r.column, 1);
		}
	});

	it("handles text with colons (greedy regex)", () => {
		const result = parseGrepOutput(GREP_TEXT_WITH_COLONS);
		assert.strictEqual(result.total_returned, 1);
		assert.strictEqual(result.results[0]!.file, "src/log.ts");
		assert.strictEqual(result.results[0]!.line, 10);
		assert.strictEqual(result.results[0]!.text, "ERROR: 5000: timeout");
	});

	it("skips malformed line (no colons)", () => {
		const result = parseGrepOutput(GREP_MALFORMED);
		assert.strictEqual(result.total_returned, 0);
	});

	it("skips lines with non-numeric line number", () => {
		const result = parseGrepOutput("file:abc:text");
		assert.strictEqual(result.total_returned, 0);
	});

	it("newline-separated input produces multiple results", () => {
		const input = "a:1:first\nb:2:second\nc:3:third";
		const result = parseGrepOutput(input);
		assert.strictEqual(result.total_returned, 3);
		assert.strictEqual(result.results[0]!.file, "a");
		assert.strictEqual(result.results[1]!.file, "b");
		assert.strictEqual(result.results[2]!.file, "c");
	});

	it("preserves original order from grep output", () => {
		const input = "z:3:last\na:1:first\nm:2:middle";
		const result = parseGrepOutput(input);
		assert.strictEqual(result.results[0]!.file, "z");
		assert.strictEqual(result.results[1]!.file, "a");
		assert.strictEqual(result.results[2]!.file, "m");
	});

	it("handles file paths with colons (Windows drive letter)", () => {
		const result = parseGrepOutput("C:/src/file.ts:5:const x = 1");
		assert.strictEqual(result.total_returned, 1);
		assert.strictEqual(result.results[0]!.file, "C:/src/file.ts");
	});
});

describe("parseVimgrepOutput", () => {
	it("parses two valid vimgrep lines", () => {
		const result = parseVimgrepOutput(TWO_VALID_LINES);
		assert.strictEqual(result.total_returned, 2);
		assert.strictEqual(result.results.length, 2);
		assert.strictEqual(result.results[0]!.file, "config/settings.py");
		assert.strictEqual(result.results[0]!.line, 4);
		assert.strictEqual(result.results[0]!.column, 16);
		assert.strictEqual(result.results[0]!.text, "TIMEOUT_MS = 5000");
		assert.strictEqual(result.results[1]!.file, "docs/readme.md");
		assert.strictEqual(result.results[1]!.line, 88);
		assert.strictEqual(result.results[1]!.column, 5);
		assert.strictEqual(result.results[1]!.text, "Set timeout to 5000.");
	});

	it("column parsed as number", () => {
		const result = parseVimgrepOutput(TWO_VALID_LINES);
		assert.ok(typeof result.results[0]!.column === "number");
		assert.strictEqual(result.results[0]!.column, 16);
	});

	it("line parsed as number", () => {
		const result = parseVimgrepOutput(TWO_VALID_LINES);
		assert.ok(typeof result.results[0]!.line === "number");
		assert.strictEqual(result.results[0]!.line, 4);
	});

	it("returns empty result for empty string", () => {
		const result = parseVimgrepOutput("");
		assert.strictEqual(result.total_returned, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("returns empty result for null input", () => {
		const result = parseVimgrepOutput(null);
		assert.strictEqual(result.total_returned, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("returns empty result for undefined input", () => {
		const result = parseVimgrepOutput(undefined);
		assert.strictEqual(result.total_returned, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("skips malformed line (missing colons)", () => {
		const result = parseVimgrepOutput(MALFORMED_OUTPUT);
		assert.strictEqual(result.total_returned, 1);
		assert.strictEqual(result.results.length, 1);
		assert.strictEqual(result.results[0]!.file, "src/app.ts");
	});

	it("skips line with only two colons", () => {
		const result = parseVimgrepOutput(TWO_COLONS_LINE);
		assert.strictEqual(result.total_returned, 0);
	});

	it("parses tab in filename (edge case)", () => {
		const result = parseVimgrepOutput(TAB_IN_FILENAME);
		assert.strictEqual(result.total_returned, 1);
		assert.strictEqual(result.results[0]!.file, "my\tfile.ts");
		assert.strictEqual(result.results[0]!.line, 10);
		assert.strictEqual(result.results[0]!.column, 5);
		assert.strictEqual(result.results[0]!.text, "const x = 1");
	});

	it("text contains colons — extracts everything after third colon", () => {
		const result = parseVimgrepOutput(TEXT_WITH_COLONS);
		assert.strictEqual(result.total_returned, 1);
		assert.strictEqual(result.results[0]!.file, "file");
		assert.strictEqual(result.results[0]!.line, 1);
		assert.strictEqual(result.results[0]!.column, 1);
		assert.strictEqual(result.results[0]!.text, "ERROR: 5000: timeout");
	});

	it("empty text after last colon", () => {
		const result = parseVimgrepOutput(EMPTY_TEXT_LINE);
		assert.strictEqual(result.total_returned, 1);
		assert.strictEqual(result.results[0]!.text, "");
	});

	it("newline-separated input produces multiple results", () => {
		const input = "a:1:1:first\nb:2:2:second\nc:3:3:third";
		const result = parseVimgrepOutput(input);
		assert.strictEqual(result.total_returned, 3);
		assert.strictEqual(result.results[0]!.file, "a");
		assert.strictEqual(result.results[1]!.file, "b");
		assert.strictEqual(result.results[2]!.file, "c");
	});

	it("preserves original order from vimgrep output", () => {
		const input = "z:3:3:last\na:1:1:first\nm:2:2:middle";
		const result = parseVimgrepOutput(input);
		assert.strictEqual(result.results[0]!.file, "z");
		assert.strictEqual(result.results[1]!.file, "a");
		assert.strictEqual(result.results[2]!.file, "m");
	});

	it("skips lines with non-numeric line or column", () => {
		const result = parseVimgrepOutput(INVALID_NUMBERS);
		assert.strictEqual(result.total_returned, 0);
	});
});

describe("loadSearchConfig", () => {
	// We manage temp dirs per test instead of using beforeEach/afterEach
	// since Node test runner doesn't support those in describe blocks directly.
	function setupTmpDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "ripgrep-test-"));
		// Create .pi directory
		const piDir = join(dir, ".pi");
		mkdirSync(piDir, { recursive: true });
		return dir;
	}

	function cleanupTmpDir(dir: string) {
		for (const d of [dir]) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}

	it("returns defaults when .pi/settings.json is missing entirely", () => {
		const noPiDir = mkdtempSync(join(tmpdir(), "ripgrep-test-nopi-"));
		try {
			const result = loadSearchConfig(noPiDir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(noPiDir);
		}
	});

	it("returns defaults when .pi/settings.json exists but has no search key", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ other: true }));
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("returns defaults when .pi/settings.json is malformed JSON", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(join(dir, ".pi", "settings.json"), "not json");
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses searchBackend: auto", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "auto" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses searchBackend: ripgrep", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "ripgrep" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "ripgrep");
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses searchBackend: grep", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "grep" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "grep");
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("falls back to auto for invalid searchBackend", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "invalid" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "auto");
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("parses maxLineLength: 100", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 100 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 100);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("rejects maxLineLength: 0 (must be positive)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 0 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("rejects maxLineLength: -50 (negative)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: -50 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("clamps maxLineLength: 5000 to 2000", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 5000 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 2000);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("rejects maxLineLength: 'abc' (non-numeric)", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: "abc" } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 200);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("accepts maxLineLength at upper bound: 2000", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { maxLineLength: 2000 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.maxLineLength, 2000);
		} finally {
			cleanupTmpDir(dir);
		}
	});

	it("handles both searchBackend and maxLineLength together", () => {
		const dir = setupTmpDir();
		try {
			writeFileSync(
				join(dir, ".pi", "settings.json"),
				JSON.stringify({ search: { searchBackend: "grep", maxLineLength: 150 } }),
			);
			const result = loadSearchConfig(dir);
			assert.strictEqual(result.searchBackend, "grep");
			assert.strictEqual(result.maxLineLength, 150);
		} finally {
			cleanupTmpDir(dir);
		}
	});
});

describe("resolveBackend", () => {
	it("auto + rg available → ripgrep", () => {
		const result = resolveBackend({ searchBackend: "auto", maxLineLength: 200 }, true);
		assert.strictEqual(result.backend, "ripgrep");
		assert.strictEqual(result.error, undefined);
	});

	it("auto + rg not available → grep", () => {
		const result = resolveBackend({ searchBackend: "auto", maxLineLength: 200 }, false);
		assert.strictEqual(result.backend, "grep");
		assert.strictEqual(result.error, undefined);
	});

	it("ripgrep + rg available → ripgrep", () => {
		const result = resolveBackend({ searchBackend: "ripgrep", maxLineLength: 200 }, true);
		assert.strictEqual(result.backend, "ripgrep");
		assert.strictEqual(result.error, undefined);
	});

	it("ripgrep + rg not available → error", () => {
		const result = resolveBackend({ searchBackend: "ripgrep", maxLineLength: 200 }, false);
		assert.strictEqual(result.backend, "ripgrep");
		assert.ok(result.error !== undefined, "Should return an error message");
		assert.ok(
			result.error!.includes("ripgrep not found"),
			"Error should mention ripgrep not found",
		);
	});

	it("grep + rg available → grep (skips detection)", () => {
		const result = resolveBackend({ searchBackend: "grep", maxLineLength: 200 }, true);
		assert.strictEqual(result.backend, "grep");
		assert.strictEqual(result.error, undefined);
	});

	it("grep + rg not available → grep (no error)", () => {
		const result = resolveBackend({ searchBackend: "grep", maxLineLength: 200 }, false);
		assert.strictEqual(result.backend, "grep");
		assert.strictEqual(result.error, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Temp directory tracking lifecycle (imported from temp.ts)
// ═══════════════════════════════════════════════════════════════════════

describe("temp dir tracking", () => {
	beforeEach(() => {
		trackedTempDirs.clear();
	});

	// ── Phase 1: Unit tests for tracking functions ──

	describe("registerTempDir", () => {
		it("adds path to set", () => {
			registerTempDir("/tmp/pi-ripgrep-abc123");
			assert.strictEqual(trackedTempDirs.size, 1);
			assert.ok(trackedTempDirs.has("/tmp/pi-ripgrep-abc123"));
		});

		it("same path twice is idempotent", () => {
			registerTempDir("/tmp/pi-ripgrep-abc123");
			registerTempDir("/tmp/pi-ripgrep-abc123");
			assert.strictEqual(trackedTempDirs.size, 1);
		});

		it("multiple dirs registered", () => {
			registerTempDir("/tmp/pi-ripgrep-001");
			registerTempDir("/tmp/pi-ripgrep-002");
			assert.strictEqual(trackedTempDirs.size, 2);
		});
	});

	describe("cleanupTrackedTempDirs", () => {
		it("calls rm for each tracked dir with recursive+force", async () => {
			const calls: Array<{ path: string; opts: unknown }> = [];
			const mockRm = async (path: string, opts?: { recursive?: boolean; force?: boolean }) => {
				calls.push({ path, opts });
			};

			registerTempDir("/tmp/dir1");
			registerTempDir("/tmp/dir2");
			await cleanupTrackedTempDirs(mockRm);

			assert.strictEqual(calls.length, 2);
			assert.strictEqual(calls[0]!.path, "/tmp/dir1");
			assert.deepStrictEqual(calls[0]!.opts, { recursive: true, force: true });
			assert.strictEqual(calls[1]!.path, "/tmp/dir2");
			assert.deepStrictEqual(calls[1]!.opts, { recursive: true, force: true });
		});

		it("clears set after cleanup", async () => {
			registerTempDir("/tmp/dir1");
			registerTempDir("/tmp/dir2");
			const mockRm = async () => {};
			await cleanupTrackedTempDirs(mockRm);
			assert.strictEqual(trackedTempDirs.size, 0);
		});

		it("empty set — no throw, no calls", async () => {
			let callCount = 0;
			const mockRm = async () => {
				callCount++;
			};
			await cleanupTrackedTempDirs(mockRm);
			assert.strictEqual(callCount, 0);
			assert.strictEqual(trackedTempDirs.size, 0);
		});

		it("rm with force:true suppresses ENOENT", async () => {
			registerTempDir("/tmp/nonexistent");
			const mockRm = async (_path: string, opts?: { force?: boolean }) => {
				if (!opts?.force) throw new Error("ENOENT: no such file");
				// force:true — rm suppresses error, resolve normally
			};
			// Should not reject
			await cleanupTrackedTempDirs(mockRm);
			assert.strictEqual(trackedTempDirs.size, 0);
		});

		it("multiple dirs — each correct path passed to rm", async () => {
			const removed: string[] = [];
			const mockRm = async (path: string) => {
				removed.push(path);
			};

			registerTempDir("/tmp/a");
			registerTempDir("/tmp/b");
			registerTempDir("/tmp/c");
			await cleanupTrackedTempDirs(mockRm);

			assert.strictEqual(removed.length, 3);
			assert.deepStrictEqual(removed.sort(), ["/tmp/a", "/tmp/b", "/tmp/c"]);
		});
	});

	// ── Phase 2: Mock-based lifecycle (tool executor-like) ──

	describe("full lifecycle (mock executor)", () => {
		it("temp dir created on truncation — fullOutputPath set", async () => {
			// Generate 600 lines to exceed MAX_TOTAL_RESULTS=500
			const lines: string[] = [];
			for (let i = 0; i < 600; i++) {
				lines.push(`file:${i + 1}:1:line ${i + 1}`);
			}
			const rawOutput = lines.join("\n");

			const searchResult = parseVimgrepOutput(rawOutput, 500);
			const resultsTruncated = searchResult.truncated ?? false;

			// Simulate the tool executor's temp dir creation
			let fullOutputPath: string | undefined;
			if (resultsTruncated) {
				const tempDir = mkdtempSync(join(tmpdir(), "pi-ripgrep-test-"));
				fullOutputPath = join(tempDir, "full-output.txt");
				writeFileSync(fullOutputPath, rawOutput, "utf8");
				registerTempDir(tempDir);
			}

			assert.ok(resultsTruncated, "Should be truncated (600 > 500)");
			assert.ok(fullOutputPath, "Should set fullOutputPath");
			assert.ok(fullOutputPath!.includes("pi-ripgrep-test-"), "Path should be in temp dir");

			// Verify file exists
			assert.ok(existsSync(fullOutputPath!), "Temp file should exist after tool call");
			const content = readFileSync(fullOutputPath!, "utf8");
			assert.strictEqual(content, rawOutput, "File should contain full raw stdout");

			// Verify dir is tracked
			assert.strictEqual(trackedTempDirs.size, 1);

			// Clean up test artifacts
			const parentDir = fullOutputPath!.replace("/full-output.txt", "");
			rmSync(parentDir, { recursive: true, force: true });
			trackedTempDirs.clear();
		});

		it("cleanup removes temp dir", async () => {
			// Create a real temp dir with a file
			const tempDir = mkdtempSync(join(tmpdir(), "pi-ripgrep-test-cleanup-"));
			const filePath = join(tempDir, "full-output.txt");
			writeFileSync(filePath, "test content", "utf8");
			registerTempDir(tempDir);

			assert.ok(existsSync(tempDir), "Temp dir should exist before cleanup");

			// Use real rm from test scope
			const { rm } = await import("node:fs/promises");
			await cleanupTrackedTempDirs(rm);

			assert.ok(!existsSync(tempDir), "Temp dir should be removed after cleanup");
			assert.strictEqual(trackedTempDirs.size, 0, "Set should be cleared");
		});

		it("no temp dir on non-truncated search", async () => {
			const rawOutput = "file:1:1:only one result";
			const searchResult = parseVimgrepOutput(rawOutput);
			const resultsTruncated = searchResult.truncated ?? false;

			assert.ok(!resultsTruncated, "Should not be truncated (1 result)");
			// This mimics the executor: no temp dir created when not truncated
			assert.strictEqual(trackedTempDirs.size, 0);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Integration test (requires rg binary installed)
// ═══════════════════════════════════════════════════════════════════════

describe("integration: rg binary", () => {
	const hasRg = (() => {
		try {
			execSync("rg --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();

	const skipMsg =
		"rg binary not installed — skip integration test (install with: apt install ripgrep or brew install ripgrep)";

	it(
		'searches "5000" on fixture dir and returns 2 results',
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve("test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error("test/fixtures/ripgrep-sample/ not found");
			}

			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 5000 .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			assert.strictEqual(
				result.total_returned,
				2,
				`Expected 2 results, got ${result.total_returned}`,
			);

			// Normalize file paths (rg may include ./ prefix when cwd matches search dir)
			const files = result.results.map((r) => r.file.replace(/^\.\//, "")).sort();
			assert.ok(files.includes("config/settings.py"), "Should find config/settings.py");
			assert.ok(files.includes("src/app.ts"), "Should find src/app.ts");

			// Each result has proper types
			for (const entry of result.results) {
				assert.ok(typeof entry.file === "string" && entry.file.length > 0);
				assert.ok(typeof entry.line === "number" && entry.line > 0);
				assert.ok(typeof entry.column === "number" && entry.column > 0);
				assert.ok(typeof entry.text === "string");
			}
		},
	);

	it(
		'searches "TODO" on fixture dir and returns 0 results',
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve("test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error("test/fixtures/ripgrep-sample/ not found");
			}

			// rg exits with code 1 when no matches found — execSync throws on non-zero
			// We catch the exception and parse stdout for empty result
			let stdout = "";
			try {
				stdout = execSync("rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 TODO .", {
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				});
			} catch (e: unknown) {
				const err = e as { stdout?: string; stderr?: string; status?: number };
				// rg exit code 1 = no matches — stdout should be empty
				stdout = err.stdout || "";
			}

			const result = parseVimgrepOutput(stdout);
			assert.strictEqual(
				result.total_returned,
				0,
				`Expected 0 results for TODO, got ${result.total_returned}`,
			);
		},
	);

	it(
		'searches "TIMEOUT_MS" with max_count=1 and respects per-file limit',
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve("test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error("test/fixtures/ripgrep-sample/ not found");
			}

			// TIMEOUT_MS appears once per file, so max_count=1 should still return 2
			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=1 --no-heading -j1 TIMEOUT_MS .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			assert.strictEqual(
				result.total_returned,
				2,
				`Expected 2 results for TIMEOUT_MS, got ${result.total_returned}`,
			);
		},
	);

	it(
		"column values are 1-indexed character positions",
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve("test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error("test/fixtures/ripgrep-sample/ not found");
			}

			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 5000 .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			for (const entry of result.results) {
				assert.ok(
					typeof entry.column === "number" && entry.column > 0,
					`Column should be positive number, got ${entry.column}`,
				);
			}
		},
	);

	it(
		"--max-columns=200 enforced (lines over 200 chars truncated)",
		{ skip: !hasRg ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve("test/fixtures/ripgrep-sample");
			if (!existsSync(sampleDir)) {
				throw new Error("test/fixtures/ripgrep-sample/ not found");
			}

			const stdout = execSync(
				"rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 '[\\s\\S]' .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseVimgrepOutput(stdout);
			for (const entry of result.results) {
				assert.ok(
					entry.text.length <= 200,
					`Text should be <= 200 chars with --max-columns=200, got ${entry.text.length}`,
				);
			}
		},
	);
});

// ═══════════════════════════════════════════════════════════════════════
// Error classification (buildSearchErrorText)
// ═══════════════════════════════════════════════════════════════════════

describe("buildSearchErrorText", () => {
	it("empty stderr with exit 137 (SIGKILL) — does NOT say 'Ensure installed'", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			137,
			false,
			"",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
		assert.ok(result.includes("exit 137"), "Should mention exit code");
		assert.ok(
			result.includes("no error output") || result.includes("killed"),
			"Should describe the situation (killed or no error output)",
		);
	});

	it("empty stderr with exit 139 (SIGSEGV) — does NOT say 'Ensure installed'", () => {
		const result = buildSearchErrorText("grep", 139, false, "", "grep", ".");
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
		assert.ok(result.includes("no error output"), "Should mention no error output");
	});

	it("killed=true with code=null, empty stderr — says 'process killed'", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			null,
			true,
			"",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("killed"), "Should mention process killed");
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
	});

	it("killed=true with code=null, non-empty stderr — says 'process killed' without Ensure", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			null,
			true,
			"out of memory",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("killed"), "Should mention process killed");
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
	});

	it("stderr contains 'command not found' — says 'Ensure installed'", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			127,
			false,
			"rg: command not found",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("Ensure"), "Should suggest checking installation");
		assert.ok(result.includes("ripgrep (\`rg --version\`)"), "Should mention the engine to check");
	});

	it("stderr contains 'not recognized' — says 'Ensure installed'", () => {
		const result = buildSearchErrorText("grep", 1, false, "'rg' is not recognized", "grep", ".");
		assert.ok(result.includes("Ensure"), "Should suggest checking installation");
	});

	it("stderr contains 'internal error' — says 'Ensure installed'", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			1,
			false,
			"internal error",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("Ensure"), "Should suggest checking installation");
	});

	it("stderr contains 'No such file' — says directory not found", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			2,
			false,
			"No such file or directory",
			"ripgrep (\`rg --version\`)",
			"foo/",
		);
		assert.ok(result.includes("not found"), "Should mention directory not found");
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
	});

	it("stderr contains 'ENOENT' — says directory not found", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			2,
			false,
			"ENOENT: no such file",
			"ripgrep (\`rg --version\`)",
			"foo/",
		);
		assert.ok(result.includes("not found"), "Should mention directory not found");
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
	});

	it("generic stderr with exit code — passes through stderr", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			2,
			false,
			"Permission denied",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("Permission denied"), "Should include stderr content");
		assert.ok(result.includes("exit 2"), "Should mention exit code");
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
	});

	it("non-empty stderr with exit code — passes through stderr", () => {
		const result = buildSearchErrorText(
			"ripgrep",
			2,
			false,
			"max-line-length (6) exceeded",
			"ripgrep (\`rg --version\`)",
			".",
		);
		assert.ok(result.includes("max-line-length"), "Should include stderr content");
		assert.ok(!result.includes("Ensure"), "Should not suggest checking installation");
	});
});
