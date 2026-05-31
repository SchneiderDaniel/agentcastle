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
import { rankFiles, computeKeywordScores, computeRecencyScores } from "../scoring.ts";
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
