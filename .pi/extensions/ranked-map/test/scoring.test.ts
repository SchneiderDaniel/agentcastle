/**
 * Tests for rankFiles — key alignment between keywordScores and symbolEntries
 *
 * Phase 1 (Characterization): Documents the bug where ./-prefixed keys from
 * rg don't match unprefixed keys from ctags, causing split entries.
 *
 * Phase 2 (Fix verification): After path normalization in runKeywordSearch,
 * keys are consistent, producing single entries with both scores and symbols.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	rankFiles,
	computeKeywordScores,
	computeRecencyScores,
	computeFileSizeScores,
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
// Phase 1: Characterization — key mismatch bug
// ---------------------------------------------------------------------------

describe("rankFiles — Phase 1: key mismatch characterization", () => {
	it("mismatched ./ prefix keys produce two separate entries", () => {
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

		// Bug: two entries for what should be the same file
		const paths = result.files.map((f) => f.path);
		assert.ok(paths.includes("./src/foo.ts"), "should include ./src/foo.ts entry");
		assert.ok(paths.includes("src/foo.ts"), "should include src/foo.ts entry");

		// The ./src/foo.ts entry should have score but no symbols
		const prefixedEntry = result.files.find((f) => f.path === "./src/foo.ts");
		assert.equal(prefixedEntry?.score, 1.0);
		assert.ok(prefixedEntry?.symbols.includes("(no symbols)"), "prefixed entry has no symbols");

		// The src/foo.ts entry should have symbols but 0 score
		const unprefixedEntry = result.files.find((f) => f.path === "src/foo.ts");
		assert.equal(unprefixedEntry?.score, 0.0);
		assert.ok(unprefixedEntry?.symbols.includes("hello"), "unprefixed entry has symbols");
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

	it("multiple files with mixed key formats produce duplicate-like entries", () => {
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

		// Should be 5 entries (2 mismatched + 3 regular)
		assert.equal(result.files.length, 5);
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

	it("no symbolEntries — all entries come from keywordScores", () => {
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
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0]!.path, "./src/a.ts");
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

	it("computeKeywordScores works correctly", () => {
		const fileMatches = {
			"src/foo.ts": ["hello", "world"],
			"src/bar.ts": ["hello"],
		};
		const terms = ["hello", "world"];
		const scores = computeKeywordScores(fileMatches, terms);
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
// Phase 3: computeFileSizeScores
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
// Phase 4: rankFiles with fileSize weight
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
