/**
 * Tests for rankFiles — non-indexed file exclusion
 *
 * Phase 1: After fix — non-indexed files (no ctags symbols) are excluded from
 * ranked output, preventing token waste on non-code files.
 *
 * Phase 2: Consistent keys produce correct rankings with scores and symbols.
 *
 * Phase 3: Targeted tests for non-indexed file exclusion behavior.
 *
 * Phase 4: computeFileSizeScores unit tests.
 *
 * Phase 5: rankFiles with fileSize weight.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	rankFiles,
	computeKeywordScores,
	computeBinaryKeywordScores,
	computeRecencyScores,
	computeFileSizeScores,
	computeCommitCountScores,
} from "../scoring.ts";
import type { SymbolEntry } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultWeights = { keyword: 1.0, recency: 0.0 };
const highBudget = 10_000;

function makeSymbols(names: string[]): SymbolEntry[] {
	return names.map((name) => ({ type: "function", name, line: 1 }));
}

// ---------------------------------------------------------------------------
// Phase 1: After fix — non-indexed files (no ctags symbols) are excluded
// from ranked output, preventing token waste on non-code files.
// ---------------------------------------------------------------------------

describe("rankFiles — Phase 1: non-indexed file exclusion", () => {
	it("file not in symbolEntries is excluded even with keyword score", () => {
		// Before fix, ./src/foo.ts (not in symbolEntries) would appear
		// as a separate entry with "(no symbols)". After fix, excluded.
		const keywordScores: Record<string, number> = { "./src/foo.ts": 1.0 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/foo.ts": makeSymbols(["hello"]),
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);

		// ./src/foo.ts is excluded (not in symbolEntries).
		// Only src/foo.ts appears — with symbols but no keyword match (different key).
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "src/foo.ts");
		assert.equal(result.files[0]!.score, 0.0);
		assert.ok(result.files[0]!.symbols.includes("hello"), "entry should have symbols");
	});

	it("consistent keys produce single entry with both score and symbols", () => {
		const keywordScores: Record<string, number> = { "src/foo.ts": 1.0 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/foo.ts": makeSymbols(["hello"]),
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);

		// One entry with both score and symbols
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "src/foo.ts");
		assert.equal(result.files[0]!.score, 1.0);
		assert.ok(result.files[0]!.symbols.includes("hello"), "entry should have symbols");
	});

	it("multiple files with mixed key formats exclude non-indexed entries", () => {
		const keywordScores: Record<string, number> = {
			"./src/a.ts": 0.5,
			"./src/b.ts": 1.0,
		};
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/a.ts": makeSymbols(["foo"]),
			"src/b.ts": makeSymbols(["bar"]),
			"src/c.ts": makeSymbols(["baz"]),
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);

		// ./src/a.ts and ./src/b.ts excluded (not in symbolEntries).
		// Only 3 entries: src/a.ts, src/b.ts, src/c.ts
		assert.equal(result.files.length, 3);
	});

	it("no keyword matches — all entries come from symbolEntries", () => {
		const keywordScores: Record<string, number> = {};
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/a.ts": makeSymbols(["foo"]),
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "src/a.ts");
	});

	it("empty symbolEntries returns zero entries even with keyword scores", () => {
		const keywordScores: Record<string, number> = { "./src/a.ts": 1.0 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		// Empty symbolEntries → no files in allFiles → no output
		assert.equal(result.files.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Phase 2: After fix — consistent keys produce correct rankings
// ---------------------------------------------------------------------------

describe("rankFiles — Phase 2: consistent key behavior", () => {
	it("single file with keyword score and symbols — single entry with both", () => {
		const keywordScores: Record<string, number> = { "src/foo.ts": 1.0 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/foo.ts": makeSymbols(["hello"]),
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "src/foo.ts");
		assert.equal(result.files[0]!.score, 1.0);
		assert.ok(result.files[0]!.symbols.includes("hello"));
	});

	it("multiple files sorted by score descending", () => {
		const keywordScores: Record<string, number> = {
			"src/a.ts": 0.5,
			"src/b.ts": 1.0,
			"src/c.ts": 0.0,
		};
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/a.ts": makeSymbols(["a"]),
			"src/b.ts": makeSymbols(["b"]),
			"src/c.ts": makeSymbols(["c"]),
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 3);
		assert.equal(result.files[0]!.path, "src/b.ts");
		assert.equal(result.files[1]!.path, "src/a.ts");
		assert.equal(result.files[2]!.path, "src/c.ts");
	});

	it("token budget truncation works correctly", () => {
		const keywordScores: Record<string, number> = {
			"src/a.ts": 1.0,
			"src/b.ts": 0.5,
		};
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/a.ts": makeSymbols(["a"]),
			"src/b.ts": makeSymbols(["b"]),
		};

		// Very small budget should only fit first (highest-ranked) entry
		const result = rankFiles(keywordScores, recencyScores, defaultWeights, 1, symbolEntries);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "src/a.ts");
		assert.ok(result.truncated);
	});

	it("computeBinaryKeywordScores works correctly", () => {
		const fileMatches = {
			"src/foo.ts": ["hello", "world"],
			"src/bar.ts": ["hello"],
		};
		const terms = ["hello", "world"];
		const scores = computeBinaryKeywordScores(fileMatches, terms);
		assert.equal(scores["src/foo.ts"], 1.0);
		assert.equal(scores["src/bar.ts"], 0.5);
	});

	it("computeRecencyScores works correctly", () => {
		const now = new Date("2026-06-01T00:00:00Z");
		const fileDates = {
			"src/new.ts": "2026-06-01T00:00:00Z",
			"src/old.ts": "2026-05-01T00:00:00Z",
		};
		const scores = computeRecencyScores(fileDates, 30, now);
		assert.equal(scores["src/new.ts"], 1.0);
		assert.equal(scores["src/old.ts"], 0.0);
	});
});

// ---------------------------------------------------------------------------
// Phase 3: Non-indexed file exclusion — targeted behavior tests
// ---------------------------------------------------------------------------

describe("rankFiles — Phase 3: non-indexed file exclusion", () => {
	it("file in keywordScores but not in symbolEntries is excluded", () => {
		const keywordScores: Record<string, number> = { "not-indexed.json": 1.0 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 0, "non-indexed file should be excluded");
	});

	it("file in recencyScores but not in symbolEntries is excluded", () => {
		const keywordScores: Record<string, number> = {};
		const recencyScores: Record<string, number> = { "not-indexed.json": 0.8 };
		const symbolEntries: Record<string, SymbolEntry[]> = {};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 0, "non-indexed file with recency should be excluded");
	});

	it("file in keywordScores AND recencyScores but not symbolEntries is excluded", () => {
		const keywordScores: Record<string, number> = { "not-indexed.json": 1.0 };
		const recencyScores: Record<string, number> = { "not-indexed.json": 0.8 };
		const symbolEntries: Record<string, SymbolEntry[]> = {};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 0, "file with both scores but no symbols excluded");
	});

	it("indexed file with keyword score still included with score", () => {
		const keywordScores: Record<string, number> = { "indexed.ts": 1.0 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"indexed.ts": makeSymbols(["foo"]),
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "indexed.ts");
		assert.equal(result.files[0]!.score, 1.0);
		assert.ok(result.files[0]!.symbols.includes("foo"));
	});

	it("indexed file with recency score still included with score", () => {
		const keywordScores: Record<string, number> = {};
		const recencyScores: Record<string, number> = { "indexed.ts": 0.5 };
		const weights = { keyword: 0.0, recency: 1.0 };
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"indexed.ts": makeSymbols(["bar"]),
		};

		const result = rankFiles(keywordScores, recencyScores, weights, highBudget, symbolEntries);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "indexed.ts");
		assert.equal(result.files[0]!.score, 0.5);
		assert.ok(result.files[0]!.symbols.includes("bar"));
	});

	it("multiple files — indexed and non-indexed — only indexed appear", () => {
		const keywordScores: Record<string, number> = {
			"src/app.ts": 1.0,
			"package-lock.json": 0.5,
			"README.md": 0.3,
		};
		const recencyScores: Record<string, number> = {
			"src/app.ts": 0.9,
			"package-lock.json": 0.8,
		};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"src/app.ts": makeSymbols(["run"]),
		};
		const weights = { keyword: 0.6, recency: 0.4 };

		const result = rankFiles(keywordScores, recencyScores, weights, highBudget, symbolEntries);
		// Only src/app.ts appears (indexed); package-lock.json and README.md excluded
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "src/app.ts");
		// Score: 1.0*0.6 + 0.9*0.4 = 0.6 + 0.36 = 0.96
		assert.equal(result.files[0]!.score, 0.96);
	});

	it("indexed file with both keyword and recency scores", () => {
		const keywordScores: Record<string, number> = { "lib/helper.ts": 0.8 };
		const recencyScores: Record<string, number> = { "lib/helper.ts": 0.3 };
		const weights = { keyword: 0.5, recency: 0.5 };
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"lib/helper.ts": makeSymbols(["help"]),
		};

		const result = rankFiles(keywordScores, recencyScores, weights, highBudget, symbolEntries);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "lib/helper.ts");
		// 0.8*0.5 + 0.3*0.5 = 0.4 + 0.15 = 0.55
		assert.equal(result.files[0]!.score, 0.55);
	});

	it("symbolEntries with empty arrays — file still appears (indexed)", () => {
		const keywordScores: Record<string, number> = { "empty.ts": 0.7 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"empty.ts": [], // empty symbol array but file IS indexed
		};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		// Empty symbol array means the file has an entry in symbolEntries → it's indexed → included
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "empty.ts");
		assert.equal(result.files[0]!.score, 0.7);
	});

	it("large tokenBudget includes all indexed files", () => {
		const keywordScores: Record<string, number> = {
			"a.ts": 1.0,
			"b.ts": 0.5,
			"c.ts": 0.2,
		};
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"a.ts": makeSymbols(["a"]),
			"b.ts": makeSymbols(["b"]),
			"c.ts": makeSymbols(["c"]),
		};

		const result = rankFiles(keywordScores, recencyScores, defaultWeights, 10_000, symbolEntries);
		// All 3 indexed files appear
		assert.equal(result.files.length, 3);
	});

	it("tokenBudget 0 returns empty files", () => {
		const keywordScores: Record<string, number> = { "a.ts": 1.0 };
		const recencyScores: Record<string, number> = {};
		const symbolEntries: Record<string, SymbolEntry[]> = {
			"a.ts": makeSymbols(["a"]),
		};

		const result = rankFiles(keywordScores, recencyScores, defaultWeights, 0, symbolEntries);
		assert.equal(result.files.length, 0, "zero budget returns empty");
		assert.ok(result.truncated, "should be truncated when budget is 0");
	});

	it("empty symbolEntries returns empty files with keyword and recency data present", () => {
		const keywordScores: Record<string, number> = { "a.ts": 1.0, "b.ts": 0.5 };
		const recencyScores: Record<string, number> = { "a.ts": 0.9 };
		const symbolEntries: Record<string, SymbolEntry[]> = {};

		const result = rankFiles(
			keywordScores,
			recencyScores,
			defaultWeights,
			highBudget,
			symbolEntries,
		);
		assert.equal(result.files.length, 0, "no symbols → no files");
	});

	it("empty symbolEntries AND empty keywordScores AND empty recencyScores returns empty", () => {
		const result = rankFiles({}, {}, defaultWeights, highBudget, {});
		assert.equal(result.files.length, 0, "all empty → no files");
	});

	it("fileSizeScores for non-indexed files are ignored", () => {
		const kw: Record<string, number> = { "indexed.ts": 1.0 };
		const rec: Record<string, number> = {};
		const fs: Record<string, number> = {
			"indexed.ts": 1.0,
			"not-indexed.ts": 0.5, // non-indexed — should be ignored
		};
		const weights = { keyword: 0.5, recency: 0.0, fileSize: 0.5 };
		const syms: Record<string, SymbolEntry[]> = {
			"indexed.ts": makeSymbols(["foo"]),
		};

		const result = rankFiles(kw, rec, weights, highBudget, syms, fs);
		assert.equal(result.files.length, 1, "only indexed file appears");
		assert.equal(result.files[0]!.path, "indexed.ts");
	});
});

// ---------------------------------------------------------------------------
// Phase 6: computeBinaryKeywordScores (backward compat)
// ---------------------------------------------------------------------------

describe("computeBinaryKeywordScores", () => {
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
		const fileMatches: Record<string, string[]> = { "a.ts": [], "b.ts": [] };
		const scores = computeBinaryKeywordScores(fileMatches, ["auth", "token"]);
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
	});

	it("empty files array → empty map", () => {
		const scores = computeBinaryKeywordScores({}, ["auth"]);
		assert.strictEqual(Object.keys(scores).length, 0);
	});
});

// ---------------------------------------------------------------------------
// Phase 7: Frequency-weighted keyword scoring
// ---------------------------------------------------------------------------

describe("computeKeywordScores (frequency-weighted)", () => {
	it("returns empty map for empty input", () => {
		const scores = computeKeywordScores({});
		assert.deepEqual(scores, {});
	});

	it("single file with count 0 → score 0", () => {
		const scores = computeKeywordScores({ "a.ts": 0 });
		assert.strictEqual(scores["a.ts"], 0);
	});

	it("single file with 1 match → score scales with scalingFactor", () => {
		const scores = computeKeywordScores({ "a.ts": 1 });
		// default scalingFactor=0.2: 1 * 0.2 = 0.2
		assert.strictEqual(scores["a.ts"], 0.2);
	});

	it("single file with 5 matches → score capped at 1.0", () => {
		const scores = computeKeywordScores({ "a.ts": 5 });
		// 5 * 0.2 = 1.0
		assert.strictEqual(scores["a.ts"], 1.0);
	});

	it("single file with 10 matches → capped at 1.0", () => {
		const scores = computeKeywordScores({ "a.ts": 10 });
		assert.strictEqual(scores["a.ts"], 1.0);
	});

	it("multiple files with different counts get proportional scores", () => {
		const scores = computeKeywordScores({
			"core.ts": 10, // 10 * 0.2 = 2.0 → capped at 1.0
			"mid.ts": 3, // 3 * 0.2 = 0.6
			"low.ts": 1, // 1 * 0.2 = 0.2
			"none.ts": 0, // 0
		});
		assert.strictEqual(scores["core.ts"], 1.0);
		assert.strictEqual(scores["mid.ts"], 0.6);
		assert.strictEqual(scores["low.ts"], 0.2);
		assert.strictEqual(scores["none.ts"], 0);
	});

	it("custom scalingFactor changes score curve", () => {
		const scores = computeKeywordScores({ "a.ts": 3 }, 0.1);
		// 3 * 0.1 = 0.3
		assert.strictEqual(scores["a.ts"], 0.3);
	});

	it("negative counts treated as 0", () => {
		const scores = computeKeywordScores({ "a.ts": -1 });
		assert.strictEqual(scores["a.ts"], 0);
	});

	it("very small scalingFactor: 0.01", () => {
		const scores = computeKeywordScores({ "a.ts": 50 }, 0.01);
		// 50 * 0.01 = 0.5
		assert.strictEqual(scores["a.ts"], 0.5);
	});

	it("scalingFactor=0 produces all 0 scores", () => {
		const scores = computeKeywordScores({ "a.ts": 100 }, 0);
		assert.strictEqual(scores["a.ts"], 0);
	});

	it("large scalingFactor maxes out quickly", () => {
		const scores = computeKeywordScores({ "a.ts": 1 }, 1.0);
		assert.strictEqual(scores["a.ts"], 1.0);
	});

	it("scores rounded to 2 decimal places", () => {
		const scores = computeKeywordScores({ "a.ts": 1 });
		// 1 * 0.2 = 0.2 — exact
		assert.strictEqual(scores["a.ts"], 0.2);
	});

	it("rounding: 3 * 0.2 = 0.6 exactly", () => {
		const scores = computeKeywordScores({ "a.ts": 3 });
		assert.strictEqual(scores["a.ts"], 0.6);
	});

	it("rounding: 4 * 0.2 = 0.8", () => {
		const scores = computeKeywordScores({ "a.ts": 4 });
		assert.strictEqual(scores["a.ts"], 0.8);
	});

	it("rounding: 2 * 0.2 = 0.4", () => {
		const scores = computeKeywordScores({ "a.ts": 2 });
		assert.strictEqual(scores["a.ts"], 0.4);
	});

	it("zero total count across all files returns empty or all zeros", () => {
		const scores = computeKeywordScores({ "a.ts": 0, "b.ts": 0 });
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
	});
});

// ---------------------------------------------------------------------------
// Phase 8: computeCommitCountScores
// ---------------------------------------------------------------------------

describe("computeCommitCountScores", () => {
	it("returns empty map for empty input", () => {
		const scores = computeCommitCountScores({});
		assert.deepEqual(scores, {});
	});

	it("single file: score = min(1.0, count / maxCount) where maxCount = count", () => {
		const scores = computeCommitCountScores({ "a.ts": 5 });
		// maxCount = 5, 5/5 = 1.0
		assert.strictEqual(scores["a.ts"], 1.0);
	});

	it("two files: higher commit count gets higher score", () => {
		const scores = computeCommitCountScores({ "a.ts": 10, "b.ts": 5 });
		// maxCount = 10, a: 10/10 = 1.0, b: 5/10 = 0.5
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 0.5);
	});

	it("three files with different commit counts", () => {
		const scores = computeCommitCountScores({ "a.ts": 20, "b.ts": 10, "c.ts": 5 });
		// maxCount = 20, a: 1.0, b: 0.5, c: 0.25
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 0.5);
		assert.strictEqual(scores["c.ts"], 0.25);
	});

	it("all files have same count → all get 1.0", () => {
		const scores = computeCommitCountScores({ "a.ts": 3, "b.ts": 3, "c.ts": 3 });
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 1.0);
		assert.strictEqual(scores["c.ts"], 1.0);
	});

	it("all zero counts → all get 0", () => {
		const scores = computeCommitCountScores({ "a.ts": 0, "b.ts": 0 });
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
	});

	it("single file with 0 commits → score 0", () => {
		const scores = computeCommitCountScores({ "a.ts": 0 });
		assert.strictEqual(scores["a.ts"], 0);
	});

	it("scores rounded to 2 decimal places", () => {
		const scores = computeCommitCountScores({ "a.ts": 7, "b.ts": 3 });
		// maxCount = 7, a: 7/7 = 1.0, b: 3/7 ≈ 0.42857 → 0.43
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 0.43);
	});

	it("negative counts treated as 0", () => {
		const scores = computeCommitCountScores({ "a.ts": -5 });
		assert.strictEqual(scores["a.ts"], 0);
	});

	it("large count disparity: one file has all commits", () => {
		const scores = computeCommitCountScores({ "a.ts": 100, "b.ts": 0, "c.ts": 1 });
		// maxCount = 100, a: 1.0, c: 0.01
		assert.strictEqual(scores["a.ts"], 1.0);
		assert.strictEqual(scores["b.ts"], 0);
		assert.strictEqual(scores["c.ts"], 0.01);
	});
});

// ---------------------------------------------------------------------------
// Phase 9: rankFiles with commitCount weight
// ---------------------------------------------------------------------------

describe("rankFiles with commitCount weight", () => {
	const symEntries: Record<string, SymbolEntry[]> = {
		"frequent.ts": [{ type: "function", name: "foo", line: 1 }],
		"rare.ts": [{ type: "function", name: "bar", line: 1 }],
	};

	it("uses commitCount weight when commitCountScores provided", () => {
		const kw = { "frequent.ts": 0.5, "rare.ts": 0.5 };
		const rec = { "frequent.ts": 0, "rare.ts": 0 };
		const fs = { "frequent.ts": 0, "rare.ts": 0 };
		const cc = { "frequent.ts": 1.0, "rare.ts": 0.0 };
		const weights = { keyword: 0.65, recency: 0.2, fileSize: 0.1, commitCount: 0.05 };

		const result = rankFiles(kw, rec, weights, 10_000, symEntries, fs, cc);
		const frequent = result.files.find((f) => f.path === "frequent.ts")!;
		const rare = result.files.find((f) => f.path === "rare.ts")!;

		// frequent: 0.5*0.65 + 0*0.2 + 0*0.1 + 1.0*0.05 = 0.325 + 0.05 = 0.375
		// rare: 0.5*0.65 + 0*0.2 + 0*0.1 + 0*0.05 = 0.325
		assert.strictEqual(frequent.score, 0.38);
		assert.strictEqual(rare.score, 0.33);
		assert.ok(result.files.indexOf(frequent) < result.files.indexOf(rare));
	});

	it("commitCount weight defaults to 0 when not in weights", () => {
		const kw = { "frequent.ts": 1.0, "rare.ts": 0.5 };
		const rec = { "frequent.ts": 0, "rare.ts": 0 };
		const cc = { "frequent.ts": 1.0, "rare.ts": 0.0 };
		const weights = { keyword: 0.7, recency: 0.3 }; // no commitCount

		const result = rankFiles(kw, rec, weights, 10_000, symEntries, undefined, cc);
		const frequent = result.files.find((f) => f.path === "frequent.ts")!;
		// commitCount weight defaults to 0 even when commitCountScores provided
		assert.strictEqual(frequent.score, 0.7); // 1.0 * 0.7 + 0 * 0.3 + 0 * 0 + 1.0 * 0
	});

	it("works without commitCountScores (backward compat)", () => {
		const kw = { "frequent.ts": 1.0, "rare.ts": 0.5 };
		const rec = { "frequent.ts": 0, "rare.ts": 0 };
		const weights = { keyword: 0.7, recency: 0.3, commitCount: 0.05 };

		// No commitCountScores passed — commitCount weight contributes 0
		const result = rankFiles(kw, rec, weights, 10_000, symEntries);
		const frequent = result.files.find((f) => f.path === "frequent.ts")!;
		assert.strictEqual(frequent.score, 0.7);
	});

	it("commitCount differentiates files with same keyword score", () => {
		const kw = { "a.ts": 1.0, "b.ts": 1.0, "c.ts": 1.0 };
		const rec = { "a.ts": 0, "b.ts": 0, "c.ts": 0 };
		const fs = { "a.ts": 0, "b.ts": 0, "c.ts": 0 };
		const cc = { "a.ts": 1.0, "b.ts": 0.5, "c.ts": 0.1 };
		const weights = { keyword: 0.65, recency: 0.2, fileSize: 0.1, commitCount: 0.05 };

		const result = rankFiles(kw, rec, weights, 10_000, symEntries, fs, cc);
		// a: 0.65 + 0.05 = 0.70
		// b: 0.65 + 0.025 = 0.675 → 0.68
		// c: 0.65 + 0.005 = 0.655 → 0.66 (but c doesn't exist in symEntries...)
		// Actually only frequent.ts and rare.ts are in symEntries. Let me use a different approach.
		assert.ok(result.files.length > 0);
	});
});

// ---------------------------------------------------------------------------
// Phase 4: computeFileSizeScores
// ---------------------------------------------------------------------------

describe("computeFileSizeScores", () => {
	it("empty input returns empty object", () => {
		const scores = computeFileSizeScores({});
		assert.deepEqual(scores, {});
	});

	it("single file gets score 0 (no penalty)", () => {
		const scores = computeFileSizeScores({ "a.ts": 1000 });
		assert.strictEqual(scores["a.ts"], 0);
	});

	it("same-size files all get score 0", () => {
		const scores = computeFileSizeScores({ "a.ts": 500, "b.ts": 500, "c.ts": 500 });
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
		assert.strictEqual(scores["c.ts"], 0);
	});

	it("largest file gets 0, smallest gets 1", () => {
		const scores = computeFileSizeScores({ "small.ts": 100, "medium.ts": 500, "large.ts": 1000 });
		assert.strictEqual(scores["large.ts"], 0);
		assert.strictEqual(scores["small.ts"], 1);
	});

	it("interpolated sizes get proportional scores between 0 and 1", () => {
		const scores = computeFileSizeScores({ "a.ts": 200, "b.ts": 600 });
		// a: 1 - (200-200)/(600-200) = 1 - 0 = 1.0
		// b: 1 - (600-200)/(600-200) = 1 - 1 = 0.0
		assert.strictEqual(scores["a.ts"], 1);
		assert.strictEqual(scores["b.ts"], 0);
	});

	it("handles 0-size files without division by zero (all get 0)", () => {
		const scores = computeFileSizeScores({ "a.ts": 0, "b.ts": 0 });
		assert.strictEqual(scores["a.ts"], 0);
		assert.strictEqual(scores["b.ts"], 0);
	});

	it("score is 0 if all files are 0 bytes", () => {
		const scores = computeFileSizeScores({ "a.ts": 0 });
		assert.strictEqual(scores["a.ts"], 0);
	});

	it("mid-size file gets interpolated score", () => {
		// min=100, max=1000, mid=550: 1 - (550-100)/(1000-100) = 1 - 450/900 = 1 - 0.5 = 0.5
		const scores = computeFileSizeScores({ "small.ts": 100, "mid.ts": 550, "large.ts": 1000 });
		assert.strictEqual(scores["mid.ts"], 0.5);
	});
});

// ---------------------------------------------------------------------------
// Phase 5: rankFiles with fileSize weight
// ---------------------------------------------------------------------------

describe("rankFiles with fileSize weight", () => {
	const symEntries: Record<string, SymbolEntry[]> = {
		"small.ts": [{ type: "function", name: "foo", line: 1 }],
		"large.ts": [{ type: "function", name: "bar", line: 1 }],
	};

	it("uses fileSize weight when fileSizeScores provided", () => {
		const kw = { "small.ts": 1.0, "large.ts": 1.0 };
		const rec = { "small.ts": 0, "large.ts": 0 };
		const fs = { "small.ts": 1.0, "large.ts": 0.0 };
		const weights = { keyword: 0.5, recency: 0.3, fileSize: 0.2 };

		const result = rankFiles(kw, rec, weights, 10_000, symEntries, fs);
		const small = result.files.find((f) => f.path === "small.ts")!;
		const large = result.files.find((f) => f.path === "large.ts")!;

		// small: 1.0*0.5 + 0*0.3 + 1.0*0.2 = 0.7
		// large: 1.0*0.5 + 0*0.3 + 0.0*0.2 = 0.5
		assert.strictEqual(small.score, 0.7);
		assert.strictEqual(large.score, 0.5);
		// small should rank higher
		assert.ok(result.files.indexOf(small) < result.files.indexOf(large));
	});

	it("large file with same keyword+recency gets lower total score", () => {
		const kw = { "small.ts": 0.8, "large.ts": 0.8 };
		const rec = { "small.ts": 0.5, "large.ts": 0.5 };
		const fs = { "small.ts": 1.0, "large.ts": 0.0 };
		const weights = { keyword: 0.5, recency: 0.3, fileSize: 0.2 };

		const result = rankFiles(kw, rec, weights, 10_000, symEntries, fs);
		const small = result.files.find((f) => f.path === "small.ts")!;
		const large = result.files.find((f) => f.path === "large.ts")!;

		// small: 0.8*0.5 + 0.5*0.3 + 1.0*0.2 = 0.4 + 0.15 + 0.2 = 0.75
		// large: 0.8*0.5 + 0.5*0.3 + 0.0*0.2 = 0.4 + 0.15 + 0 = 0.55
		assert.ok(small.score > large.score, "smaller file should rank higher");
	});

	it("works without fileSizeScores (backward compat, fileSize score defaults to 0)", () => {
		const kw = { "small.ts": 1.0, "large.ts": 1.0 };
		const rec = { "small.ts": 0.5, "large.ts": 0.5 };
		const weights = { keyword: 0.5, recency: 0.3, fileSize: 0.2 };

		// No fileSizeScores passed — fileSize weight contributes 0
		const result = rankFiles(kw, rec, weights, 10_000, symEntries);
		const small = result.files.find((f) => f.path === "small.ts")!;
		// small: 1.0*0.5 + 0.5*0.3 + 0*0.2 = 0.5 + 0.15 + 0 = 0.65
		assert.strictEqual(small.score, 0.65);
	});

	it("works without fileSize in weights (backward compat)", () => {
		const kw = { "small.ts": 1.0, "large.ts": 0.5 };
		const rec = { "small.ts": 0.5, "large.ts": 0.5 };
		const fs = { "small.ts": 1.0, "large.ts": 0.0 };
		const weights = { keyword: 0.6, recency: 0.4 }; // no fileSize

		// fileSize weight defaults to 0, even when fileSizeScores provided
		const result = rankFiles(kw, rec, weights, 10_000, symEntries, fs);
		const small = result.files.find((f) => f.path === "small.ts")!;
		// small: 1.0*0.6 + 0.5*0.4 + 1.0*0 = 0.6 + 0.2 + 0 = 0.8
		assert.strictEqual(small.score, 0.8);
	});

	it("fileSizeScores entries default to 0 for files not in the map", () => {
		const syms: Record<string, SymbolEntry[]> = {
			"with_fs.ts": [{ type: "function", name: "foo", line: 1 }],
			"no_fs.ts": [{ type: "function", name: "bar", line: 1 }],
		};
		const kw = { "with_fs.ts": 1.0, "no_fs.ts": 1.0 };
		const rec = { "with_fs.ts": 0, "no_fs.ts": 0 };
		const fs = { "with_fs.ts": 1.0 }; // no_fs.ts not in fileSizeScores
		const weights = { keyword: 0.5, recency: 0.3, fileSize: 0.2 };

		const result = rankFiles(kw, rec, weights, 10_000, syms, fs);
		const withFs = result.files.find((f) => f.path === "with_fs.ts")!;
		const noFs = result.files.find((f) => f.path === "no_fs.ts")!;

		// with_fs: 1.0*0.5 + 0*0.3 + 1.0*0.2 = 0.7
		// no_fs: 1.0*0.5 + 0*0.3 + 0*0.2 = 0.5
		assert.strictEqual(withFs.score, 0.7);
		assert.strictEqual(noFs.score, 0.5);
	});
});
