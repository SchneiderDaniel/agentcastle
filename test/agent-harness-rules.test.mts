/**
 * Tests for harness-rules.ts — pure detection functions
 *
 * Phase 1: Domain layer unit tests.
 * No pi, no I/O, no state. Pure functions only.
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
	BASH_SEARCH_SIGNALS,
	READ_BASH_CMDS,
	SEARCH_TOOLS,
	grepLike,
} from "../.pi/lib/harness-rules.ts";

// ─── isSearchInBash ────────────────────────────────────────────────

describe("isSearchInBash", () => {
	it('detects "cat file | grep foo" as search in bash', () => {
		assert.strictEqual(isSearchInBash("cat file | grep foo"), true);
	});

	it('detects "ls -la | rg pattern" as search in bash', () => {
		assert.strictEqual(isSearchInBash("ls -la | rg pattern"), true);
	});

	it('does NOT flag "npm test"', () => {
		assert.strictEqual(isSearchInBash("npm test"), false);
	});

	it('does NOT flag "ls -la"', () => {
		assert.strictEqual(isSearchInBash("ls -la"), false);
	});

	it("does NOT crash on empty string", () => {
		assert.strictEqual(isSearchInBash(""), false);
	});

	it("does NOT crash on very long string (2000+ chars)", () => {
		const long = "a".repeat(2000);
		assert.strictEqual(isSearchInBash(long), false);
	});

	it("is synchronous and returns primitive", () => {
		const result = isSearchInBash("cat file | grep x");
		assert.strictEqual(typeof result, "boolean");
	});
});

// ─── isCatHeadTailInBash ───────────────────────────────────────────

describe("isCatHeadTailInBash", () => {
	it('detects "cat README.md"', () => {
		assert.strictEqual(isCatHeadTailInBash("cat README.md"), true);
	});

	it('detects "cat file | grep x" (cat detected even when piped)', () => {
		assert.strictEqual(isCatHeadTailInBash("cat file | grep x"), true);
	});

	it('does NOT flag "node build.js"', () => {
		assert.strictEqual(isCatHeadTailInBash("node build.js"), false);
	});

	it('does NOT flag "npm test"', () => {
		assert.strictEqual(isCatHeadTailInBash("npm test"), false);
	});

	it("does NOT crash on empty string", () => {
		assert.strictEqual(isCatHeadTailInBash(""), false);
	});
});

// ─── isLsInBash ────────────────────────────────────────────────────

describe("isLsInBash", () => {
	it('detects "ls -la"', () => {
		assert.strictEqual(isLsInBash("ls -la"), true);
	});

	it('detects plain "ls"', () => {
		assert.strictEqual(isLsInBash("ls"), true);
	});

	it('does NOT flag "npm ls"', () => {
		assert.strictEqual(isLsInBash("npm ls"), false);
	});

	it('does NOT flag "lsass" as ls', () => {
		assert.strictEqual(isLsInBash("lsass"), false);
	});

	it("does NOT crash on empty string", () => {
		assert.strictEqual(isLsInBash(""), false);
	});
});

// ─── shouldBlockRetry ──────────────────────────────────────────────

describe("shouldBlockRetry", () => {
	it("returns false when errorCount is 0", () => {
		assert.strictEqual(shouldBlockRetry(0), false);
	});

	it("returns false when errorCount is 1", () => {
		assert.strictEqual(shouldBlockRetry(1), false);
	});

	it("returns true when errorCount is 2", () => {
		assert.strictEqual(shouldBlockRetry(2), true);
	});

	it("returns true when errorCount is 3", () => {
		assert.strictEqual(shouldBlockRetry(3), true);
	});

	it("returns true when errorCount is 5", () => {
		assert.strictEqual(shouldBlockRetry(5), true);
	});

	it("returns false for negative count", () => {
		assert.strictEqual(shouldBlockRetry(-1), false);
	});
});

// ─── isRedundantRead ───────────────────────────────────────────────

describe("isRedundantRead", () => {
	it("detects same path with turnDiff 0", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 0), true);
	});

	it("does NOT flag different paths with turnDiff 0", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/b.ts", 0), false);
	});

	it("does NOT flag same path with turnDiff 3", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 3), false);
	});

	it("detects same path with turnDiff 1", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 1), true);
	});

	it("detects same path with turnDiff 2", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 2), true);
	});
});

// ─── isCodeFilePath ────────────────────────────────────────────────

describe("isCodeFilePath", () => {
	it("detects .ts file", () => {
		assert.strictEqual(isCodeFilePath("src/app.ts"), true);
	});

	it("detects .py file", () => {
		assert.strictEqual(isCodeFilePath("script.py"), true);
	});

	it("detects .js file", () => {
		assert.strictEqual(isCodeFilePath("index.js"), true);
	});

	it("detects .tsx file", () => {
		assert.strictEqual(isCodeFilePath("component.tsx"), true);
	});

	it("detects .jsx file", () => {
		assert.strictEqual(isCodeFilePath("component.jsx"), true);
	});

	it("detects .rs file", () => {
		assert.strictEqual(isCodeFilePath("module.rs"), true);
	});

	it("detects .go file", () => {
		assert.strictEqual(isCodeFilePath("main.go"), true);
	});

	it("does NOT flag README.md", () => {
		assert.strictEqual(isCodeFilePath("README.md"), false);
	});

	it("does NOT flag .json file", () => {
		assert.strictEqual(isCodeFilePath("package.json"), false);
	});

	it("does NOT flag empty string", () => {
		assert.strictEqual(isCodeFilePath(""), false);
	});
});

// ─── detectMismatchAndSuggest ─────────────────────────────────────

describe("detectMismatchAndSuggest", () => {
	it('detects "cat f | rg x" as tool-mismatch', () => {
		const result = detectMismatchAndSuggest("cat f | rg x");
		assert.ok(result !== null);
		assert.strictEqual(result.category, "tool-mismatch");
		assert.ok(result.suggestion.includes("ripgrep_search"));
	});

	it('detects "cat f | grep x" as tool-mismatch', () => {
		const result = detectMismatchAndSuggest("cat f | grep x");
		assert.ok(result !== null);
		assert.strictEqual(result.category, "tool-mismatch");
		assert.ok(result.suggestion.includes("ripgrep_search"));
	});

	it('detects "cat README.md" as cat-mismatch', () => {
		const result = detectMismatchAndSuggest("cat README.md");
		assert.ok(result !== null, "should detect cat command");
	});

	it('returns null for "npm run build"', () => {
		const result = detectMismatchAndSuggest("npm run build");
		assert.strictEqual(result, null);
	});

	it("returns null for empty string", () => {
		const result = detectMismatchAndSuggest("");
		assert.strictEqual(result, null);
	});

	it("returns null for very long non-matching string", () => {
		const result = detectMismatchAndSuggest("a".repeat(2000));
		assert.strictEqual(result, null);
	});
});

// ─── suggestRedirection ───────────────────────────────────────────

describe("suggestRedirection", () => {
	it('returns redirect suggestion for "bash cat f | grep x"', () => {
		const result = suggestRedirection("bash cat f | grep x");
		assert.ok(result !== null, "should suggest redirection");
		assert.ok(typeof result === "string", "should be string");
	});

	it('returns null for "npm test"', () => {
		const result = suggestRedirection("npm test");
		assert.strictEqual(result, null);
	});

	it("returns null for empty string", () => {
		const result = suggestRedirection("");
		assert.strictEqual(result, null);
	});
});

// ─── Exported constants ───────────────────────────────────────────

describe("exported constants", () => {
	it("BASH_SEARCH_SIGNALS is a non-empty array", () => {
		assert.ok(Array.isArray(BASH_SEARCH_SIGNALS));
		assert.ok(BASH_SEARCH_SIGNALS.length > 0);
	});

	it("READ_BASH_CMDS is a non-empty array with cat, head, tail", () => {
		assert.ok(Array.isArray(READ_BASH_CMDS));
		assert.ok(READ_BASH_CMDS.includes("cat"));
		assert.ok(READ_BASH_CMDS.includes("head"));
		assert.ok(READ_BASH_CMDS.includes("tail"));
	});

	it("SEARCH_TOOLS is a Set with ripgrep_search and structural_search", () => {
		assert.ok(SEARCH_TOOLS instanceof Set);
		assert.ok(SEARCH_TOOLS.has("ripgrep_search"));
		assert.ok(SEARCH_TOOLS.has("structural_search"));
	});
});

// ─── grepLike ─────────────────────────────────────────────────────

describe("grepLike", () => {
	it('detects "grep" in string', () => {
		assert.strictEqual(grepLike("cat file | grep foo"), true);
	});

	it('detects "| rg" in string', () => {
		assert.strictEqual(grepLike("cat file | rg pattern"), true);
	});

	it('does NOT flag "npm install"', () => {
		assert.strictEqual(grepLike("npm install"), false);
	});

	it("does NOT crash on empty string", () => {
		assert.strictEqual(grepLike(""), false);
	});
});
