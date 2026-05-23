/**
 * Tests for harness-rules.ts — pure detection functions.
 *
 * Phase 1: Domain layer. No pi, no I/O, no state.
 * Pure functions only.
 *
 * Run with:
 *   node --experimental-strip-types --test test/agent-harness-rules.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	isSearchInBash,
	isCatHeadTailInBash,
	isLsInBash,
	shouldBlockRetry,
	isRedundantRead,
	isCodeFilePath,
	detectMismatchAndSuggest,
	suggestRedirection,
} from "../src/harness-rules.ts";

// ---------------------------------------------------------------------------
// isSearchInBash
// ---------------------------------------------------------------------------

describe("isSearchInBash", () => {
	it("returns true for `cat file | grep foo`", () => {
		assert.strictEqual(isSearchInBash("cat file | grep foo"), true);
	});

	it("returns true for `ls -la | rg pattern`", () => {
		assert.strictEqual(isSearchInBash("ls -la | rg pattern"), true);
	});

	it("returns false for `ls -la` (no pipe)", () => {
		assert.strictEqual(isSearchInBash("ls -la"), false);
	});

	it("returns false for `npm test`", () => {
		assert.strictEqual(isSearchInBash("npm test"), false);
	});

	it("returns true for `cat file | rg foo`", () => {
		assert.strictEqual(isSearchInBash("cat file | rg foo"), true);
	});

	it("returns false for empty string", () => {
		assert.strictEqual(isSearchInBash(""), false);
	});

	it("processes very long command string (2000+ chars) without OOM", () => {
		const long = "a".repeat(2000) + " | grep foo";
		assert.strictEqual(isSearchInBash(long), true);
	});

	it("returns true for backtick grep like `grep foo`", () => {
		assert.strictEqual(isSearchInBash("`grep foo`"), true);
	});

	it("returns true for backtick rg like `rg pattern`", () => {
		assert.strictEqual(isSearchInBash("`rg pattern`"), true);
	});
});

// ---------------------------------------------------------------------------
// isCatHeadTailInBash
// ---------------------------------------------------------------------------

describe("isCatHeadTailInBash", () => {
	it("returns true for `cat README.md`", () => {
		assert.strictEqual(isCatHeadTailInBash("cat README.md"), true);
	});

	it("returns true for `head -5 file.txt`", () => {
		assert.strictEqual(isCatHeadTailInBash("head -5 file.txt"), true);
	});

	it("returns true for `tail -f log.txt`", () => {
		assert.strictEqual(isCatHeadTailInBash("tail -f log.txt"), true);
	});

	it("returns false for `npm test`", () => {
		assert.strictEqual(isCatHeadTailInBash("npm test"), false);
	});

	it("returns false for `node build.js`", () => {
		assert.strictEqual(isCatHeadTailInBash("node build.js"), false);
	});

	it("returns true for `cat file | grep x` (cat detected even when piped)", () => {
		assert.strictEqual(isCatHeadTailInBash("cat file | grep x"), true);
	});

	it("returns true for `cat` alone (bare command)", () => {
		assert.strictEqual(isCatHeadTailInBash("cat"), true);
	});

	it("returns false for empty string", () => {
		assert.strictEqual(isCatHeadTailInBash(""), false);
	});
});

// ---------------------------------------------------------------------------
// isLsInBash
// ---------------------------------------------------------------------------

describe("isLsInBash", () => {
	it("returns true for `ls`", () => {
		assert.strictEqual(isLsInBash("ls"), true);
	});

	it("returns true for `ls -la`", () => {
		assert.strictEqual(isLsInBash("ls -la"), true);
	});

	it("returns false for `npm ls`", () => {
		assert.strictEqual(isLsInBash("npm ls"), false);
	});

	it("returns false for empty string", () => {
		assert.strictEqual(isLsInBash(""), false);
	});

	it("returns true for `ls src/`", () => {
		assert.strictEqual(isLsInBash("ls src/"), true);
	});
});

// ---------------------------------------------------------------------------
// shouldBlockRetry
// ---------------------------------------------------------------------------

describe("shouldBlockRetry", () => {
	it("returns false for errorCount=0", () => {
		assert.strictEqual(shouldBlockRetry(0), false);
	});

	it("returns false for errorCount=1", () => {
		assert.strictEqual(shouldBlockRetry(1), false);
	});

	it("returns true for errorCount=2", () => {
		assert.strictEqual(shouldBlockRetry(2), true);
	});

	it("returns true for errorCount=3", () => {
		assert.strictEqual(shouldBlockRetry(3), true);
	});
});

// ---------------------------------------------------------------------------
// isRedundantRead
// ---------------------------------------------------------------------------

describe("isRedundantRead", () => {
	it("returns true for same path within 0 turns", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 0), true);
	});

	it("returns false for different paths within same turn", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/b.ts", 0), false);
	});

	it("returns false for same path 3 turns apart", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 3), false);
	});

	it("returns true for same path within 2 turns", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 1), true);
	});

	it("returns true for same path within 2 turns (edge case diff=2)", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 2), true);
	});

	it("returns false for same path diff=3", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 3), false);
	});
});

// ---------------------------------------------------------------------------
// isCodeFilePath
// ---------------------------------------------------------------------------

describe("isCodeFilePath", () => {
	it("returns true for `.ts` file", () => {
		assert.strictEqual(isCodeFilePath("src/app.ts"), true);
	});

	it("returns true for `.py` file", () => {
		assert.strictEqual(isCodeFilePath("script.py"), true);
	});

	it("returns true for `.js` file", () => {
		assert.strictEqual(isCodeFilePath("index.js"), true);
	});

	it("returns false for `.md` file", () => {
		assert.strictEqual(isCodeFilePath("README.md"), false);
	});

	it("returns false for `.json` file", () => {
		assert.strictEqual(isCodeFilePath("package.json"), false);
	});

	it("returns true for `.tsx` file", () => {
		assert.strictEqual(isCodeFilePath("component.tsx"), true);
	});

	it("returns false for empty string", () => {
		assert.strictEqual(isCodeFilePath(""), false);
	});
});

// ---------------------------------------------------------------------------
// detectMismatchAndSuggest
// ---------------------------------------------------------------------------

describe("detectMismatchAndSuggest", () => {
	it("returns category + suggestion for `cat f | rg x`", () => {
		const result = detectMismatchAndSuggest("cat f | rg x");
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("returns category + suggestion for `ls -la`", () => {
		const result = detectMismatchAndSuggest("ls -la");
		assert.notStrictEqual(result, null);
		assert.strictEqual(result!.category, "tool-mismatch");
	});

	it("returns null for `npm run build`", () => {
		const result = detectMismatchAndSuggest("npm run build");
		assert.strictEqual(result, null);
	});

	it("returns null for empty string", () => {
		assert.strictEqual(detectMismatchAndSuggest(""), null);
	});

	it("returns suggestion for `cat file | grep x`", () => {
		const result = detectMismatchAndSuggest("cat file | grep x");
		assert.notStrictEqual(result, null);
		assert.ok(result!.suggestion.includes("ripgrep_search") || result!.suggestion.includes("read"));
	});
});

// ---------------------------------------------------------------------------
// suggestRedirection
// ---------------------------------------------------------------------------

describe("suggestRedirection", () => {
	it("returns redirect string for `bash cat file | grep x`", () => {
		const result = suggestRedirection("bash cat file | grep x");
		assert.notStrictEqual(result, null);
		assert.strictEqual(typeof result, "string");
	});

	it("returns null for `npm test`", () => {
		const result = suggestRedirection("npm test");
		assert.strictEqual(result, null);
	});

	it("returns redirect string for `ls`", () => {
		const result = suggestRedirection("ls");
		assert.notStrictEqual(result, null);
	});

	it("returns redirect string for `cat README.md`", () => {
		const result = suggestRedirection("cat README.md");
		assert.notStrictEqual(result, null);
	});

	it("returns null for empty string", () => {
		assert.strictEqual(suggestRedirection(""), null);
	});
});
