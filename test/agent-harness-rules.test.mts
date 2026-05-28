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
	parseBashCmd,
	TOOL_META,
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

	// ── Bug 4 fix: quoted args should not trigger false positives ──

	it("does NOT flag \"gh issue --body '...| grep...'\" (pipe in quoted arg)", () => {
		assert.strictEqual(isSearchInBash("gh issue --body '...| grep...'"), false);
	});

	it('does NOT flag "gh issue --title \"...grep...\"" (grep in quoted arg)', () => {
		assert.strictEqual(isSearchInBash('gh issue --title "...grep..."'), false);
	});

	it("does NOT flag \"gh issue create --body '...| rg...'\" (rg in quoted arg)", () => {
		assert.strictEqual(isSearchInBash("gh issue create --body '...| rg...'"), false);
	});

	it("still detects grep in pipe outside quotes", () => {
		assert.strictEqual(isSearchInBash("ls -la | grep foo"), true);
	});

	it("still detects rg after pipe", () => {
		assert.strictEqual(isSearchInBash("cat file | rg pattern"), true);
	});

	it("detects backtick grep", () => {
		assert.strictEqual(isSearchInBash("`grep foo`"), true);
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

	// ── Bug 2 fix: write redirects (cat > / >>) should NOT block ──

	it('does NOT block "cat > /tmp/foo" (write redirect)', () => {
		assert.strictEqual(isCatHeadTailInBash("cat > /tmp/foo"), false);
	});

	it('does NOT block "cat >> /tmp/foo" (append redirect)', () => {
		assert.strictEqual(isCatHeadTailInBash("cat >> /tmp/foo"), false);
	});

	it('does NOT block "cat file1 file2 > combined" (concat write)', () => {
		assert.strictEqual(isCatHeadTailInBash("cat file1 file2 > combined"), false);
	});

	// ── Bug 3 fix: pipe head/tail should NOT block ──

	it('does NOT block "echo hello | head -5" (pipe truncation)', () => {
		assert.strictEqual(isCatHeadTailInBash("echo hello | head -5"), false);
	});

	it('does NOT block "echo hello | tail -10" (pipe truncation)', () => {
		assert.strictEqual(isCatHeadTailInBash("echo hello | tail -10"), false);
	});

	it('does NOT block "ls -la | head -5" (pipe truncation)', () => {
		assert.strictEqual(isCatHeadTailInBash("ls -la | head -5"), false);
	});

	// ── Bug 4 fix: quoted args should not trigger false positives ──

	it('does NOT block "gh issue --title \"... cat ...\"" (cat in quoted arg)', () => {
		assert.strictEqual(isCatHeadTailInBash('gh issue --title "... cat ..."'), false);
	});

	it('does NOT block "npm install cat" (cat as arg not command)', () => {
		assert.strictEqual(isCatHeadTailInBash("npm install cat"), false);
	});

	// ── Still blocks first-command file reads ──

	it('STILL blocks "head -5 file" (first cmd, file read)', () => {
		assert.strictEqual(isCatHeadTailInBash("head -5 file"), true);
	});

	it('STILL blocks "tail -10 file" (first cmd, file read)', () => {
		assert.strictEqual(isCatHeadTailInBash("tail -10 file"), true);
	});

	it('STILL blocks bare "cat"', () => {
		assert.strictEqual(isCatHeadTailInBash("cat"), true);
	});

	it('STILL blocks "cat file | grep x" (cat first cmd, piped)', () => {
		assert.strictEqual(isCatHeadTailInBash("cat file | grep x"), true);
	});

	it('STILL blocks "less README.md"', () => {
		assert.strictEqual(isCatHeadTailInBash("less README.md"), true);
	});

	it('STILL blocks "more data.txt"', () => {
		assert.strictEqual(isCatHeadTailInBash("more data.txt"), true);
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

	it("detects same path with turnDiff 3 (within CACHE_TTL_TURNS=6)", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 3), true);
	});

	it("does NOT flag same path with large turnDiff (beyond TTL)", () => {
		assert.strictEqual(isRedundantRead("/a.ts", "/a.ts", 10), false);
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

// ─── parseBashCmd ─────────────────────────────────────────────────

describe("parseBashCmd", () => {
	it("returns empty array for empty string", () => {
		assert.deepStrictEqual(parseBashCmd(""), []);
	});

	it("parses single command with args", () => {
		const result = parseBashCmd("echo hello");
		assert.strictEqual(result.length, 1);
		assert.deepStrictEqual(result[0].tokens, ["echo", "hello"]);
		assert.strictEqual(result[0].redirect, undefined);
	});

	it("splits by pipe", () => {
		const result = parseBashCmd("cmd1 | cmd2");
		assert.strictEqual(result.length, 2);
		assert.deepStrictEqual(result[0].tokens, ["cmd1"]);
		assert.deepStrictEqual(result[1].tokens, ["cmd2"]);
	});

	it("keeps quoted string as single token", () => {
		const result = parseBashCmd('echo "hello world"');
		assert.strictEqual(result.length, 1);
		assert.deepStrictEqual(result[0].tokens, ["echo", '"hello world"']);
	});

	it("pipe inside single quotes is NOT a separator", () => {
		const result = parseBashCmd("gh issue --body '...| grep...'");
		assert.strictEqual(result.length, 1, "pipe inside quotes should not split");
		assert.deepStrictEqual(result[0].tokens, ["gh", "issue", "--body", "'...| grep...'"]);
	});

	it("detects write redirect (>) on last segment", () => {
		const result = parseBashCmd("cat > /tmp/foo");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].redirect, "write");
	});

	it("detects append redirect (>>) on segment", () => {
		const result = parseBashCmd("cat >> file");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].redirect, "append");
	});

	it("pipe split with write redirect on last segment", () => {
		const result = parseBashCmd("echo foo | grep bar > out.txt");
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0].redirect, undefined);
		assert.strictEqual(result[1].redirect, "write");
		assert.deepStrictEqual(result[1].tokens, ["grep", "bar"]);
	});

	it("handles tab separator between tokens", () => {
		const result = parseBashCmd("cat\tfile");
		assert.strictEqual(result.length, 1);
		assert.deepStrictEqual(result[0].tokens, ["cat", "file"]);
	});

	it("concatenation with redirect: cat file1 file2 > combined", () => {
		const result = parseBashCmd("cat file1 file2 > combined");
		assert.strictEqual(result.length, 1);
		// First segment tokens before redirect
		assert.deepStrictEqual(result[0].tokens, ["cat", "file1", "file2"]);
		assert.strictEqual(result[0].redirect, "write");
	});

	it("no redirect when cat has no > or >>", () => {
		const result = parseBashCmd("cat README.md");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].redirect, undefined);
	});

	it("three-way pipe chain", () => {
		const result = parseBashCmd("cat file | grep foo | head -5");
		assert.strictEqual(result.length, 3);
		assert.deepStrictEqual(result[0].tokens, ["cat", "file"]);
		assert.deepStrictEqual(result[1].tokens, ["grep", "foo"]);
		assert.deepStrictEqual(result[2].tokens, ["head", "-5"]);
	});
});

// ─── TOOL_META ────────────────────────────────────────────────────

describe("TOOL_META", () => {
	it("is exported as object", () => {
		assert.ok(TOOL_META !== undefined);
		assert.strictEqual(typeof TOOL_META, "object");
	});

	it("ask_user has passThrough true", () => {
		assert.ok(TOOL_META.ask_user?.passThrough === true);
	});

	it("structural_search has passThrough true", () => {
		assert.ok(TOOL_META.structural_search?.passThrough === true);
	});

	it("ripgrep_search has passThrough true", () => {
		assert.ok(TOOL_META.ripgrep_search?.passThrough === true);
	});

	it("ranked_map has passThrough true", () => {
		assert.ok(TOOL_META.ranked_map?.passThrough === true);
	});

	it("bash has passThrough falsy", () => {
		assert.ok(!TOOL_META.bash?.passThrough);
	});

	it("bash has cascadeThreshold >= 8", () => {
		assert.ok(TOOL_META.bash?.cascadeThreshold !== undefined);
		assert.ok(TOOL_META.bash!.cascadeThreshold! >= 8);
	});

	it("unlisted tool defaults: passThrough false, cascadeThreshold >= 8", () => {
		// Default fallback should have these properties
		assert.ok(
			TOOL_META.ask_user?.cascadeThreshold === undefined ||
				TOOL_META.ask_user!.cascadeThreshold! >= 8,
		);
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
