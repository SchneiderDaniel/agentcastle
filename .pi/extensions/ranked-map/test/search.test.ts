/**
 * Tests for runKeywordSearch — path normalization from rg output
 *
 * Phase 1 (Characterization): Documents current bug where rg ./ prefix
 * creates key mismatch with ctags/symbol entries.
 *
 * Phase 2 (Fix verification): After normalization in runKeywordSearch,
 * path keys are consistent regardless of rg directory argument.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runKeywordSearch } from "../search.ts";

// ---------------------------------------------------------------------------
// Mock exec helper
// ---------------------------------------------------------------------------

function mockExec(stdout: string, code = 0) {
	return async () => ({
		stdout,
		stderr: "",
		code,
		killed: false,
	});
}

// ---------------------------------------------------------------------------
// Phase 1: Characterization — prove the mismatch
// ---------------------------------------------------------------------------

describe("runKeywordSearch — Phase 1: characterization (current bug)", () => {
	it("rg with directory '.' returns normalized paths (no ./ prefix)", async () => {
		// When rg target directory is '.', paths come back with './' prefix.
		// After fix: normalized to remove ./ prefix for key consistency.
		const exec = mockExec("./src/foo.ts\n./api/routes.py\n");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		assert.deepEqual(Object.keys(result.fileMatches).sort(), ["api/routes.py", "src/foo.ts"]);
	});

	it("rg with explicit src/ dir returns paths without ./ prefix", async () => {
		const exec = mockExec("src/foo.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", "src", "/tmp");
		assert.deepEqual(Object.keys(result.fileMatches), ["src/foo.ts"]);
	});

	it("rg returns non-zero exit when no matches — returns empty fileMatches", async () => {
		const exec = mockExec("", 1);
		const result = await runKeywordSearch(exec as any, "nonexistent", ".", "/tmp");
		assert.deepEqual(result.fileMatches, {});
	});

	it("empty query returns empty terms and fileMatches", async () => {
		const exec = mockExec("");
		const result = await runKeywordSearch(exec as any, "", ".", "/tmp");
		assert.deepEqual(result.terms, []);
		assert.deepEqual(result.fileMatches, {});
	});

	it("whitespace-only query returns empty terms and fileMatches", async () => {
		const exec = mockExec("");
		const result = await runKeywordSearch(exec as any, "   ", ".", "/tmp");
		assert.deepEqual(result.terms, []);
		assert.deepEqual(result.fileMatches, {});
	});

	it("matched file has the correct terms associated", async () => {
		const exec = mockExec("src/foo.ts\n");
		const result = await runKeywordSearch(exec as any, "hello world", ".", "/tmp");
		// Only first term matched (rg mock returns same stdout for both calls)
		assert.deepEqual(result.terms, ["hello", "world"]);
		// Both terms call rg, so src/foo.ts appears twice
		assert.deepEqual(result.fileMatches["src/foo.ts"], ["hello", "world"]);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: After fix — path normalization
// ---------------------------------------------------------------------------

describe("runKeywordSearch — Phase 2: path normalization (desired behavior)", () => {
	it("strips ./ prefix from rg output paths", async () => {
		const exec = mockExec("./src/foo.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		assert.ok(Object.keys(result.fileMatches).includes("src/foo.ts"));
	});

	it("resolves .. segments via path.normalize", async () => {
		const exec = mockExec("./bar/baz/../qux.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		assert.ok(Object.keys(result.fileMatches).includes("bar/qux.ts"));
	});

	it("leaves paths without ./ prefix unchanged", async () => {
		const exec = mockExec("src/foo.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", "src", "/tmp");
		assert.deepEqual(Object.keys(result.fileMatches), ["src/foo.ts"]);
	});

	it("normalizes mixed ./ and bare paths consistently", async () => {
		const exec = mockExec("./src/foo.ts\n./src/bar.ts\nsrc/baz.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		const keys = Object.keys(result.fileMatches).sort();
		assert.deepEqual(keys, ["src/bar.ts", "src/baz.ts", "src/foo.ts"]);
	});

	it("handles empty stdout (no matches)", async () => {
		const exec = mockExec("");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		assert.deepEqual(result.fileMatches, {});
	});

	it("handles single ./ path", async () => {
		const exec = mockExec("./single.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		assert.deepEqual(Object.keys(result.fileMatches), ["single.ts"]);
	});

	it("handles paths with multiple ./ prefix occurrences (rg output edge case)", async () => {
		const exec = mockExec("./src/./foo.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		// path.normalize resolves ./ in the middle too
		assert.ok(Object.keys(result.fileMatches).includes("src/foo.ts"));
	});

	it("handles deeply nested ./ prefix", async () => {
		const exec = mockExec("./a/b/c/d/e.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", ".", "/tmp");
		assert.deepEqual(Object.keys(result.fileMatches), ["a/b/c/d/e.ts"]);
	});

	it("does not strip non-leading ./ (e.g. ../foo.ts should remain ../foo.ts)", async () => {
		const exec = mockExec("../foo.ts\n");
		const result = await runKeywordSearch(exec as any, "hello", "..", "/tmp");
		// ../foo.ts doesn't start with ./ so it should remain as-is
		// But path.normalize will keep it as ../foo.ts
		assert.ok(Object.keys(result.fileMatches).includes("../foo.ts"));
	});

	it("handles all terms matched correctly after normalization", async () => {
		const exec = mockExec("./file.ts\n");
		const result = await runKeywordSearch(exec as any, "hello world", ".", "/tmp");
		assert.deepEqual(result.fileMatches["file.ts"], ["hello", "world"]);
	});
});
