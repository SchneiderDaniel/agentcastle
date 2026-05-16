/**
 * Tests for Ripgrep Search (ripgrep literal text search)
 *
 * Pure function tests for validateQuery(), buildRgArgs(), parseVimgrepOutput().
 * Local copies match source at .pi/extensions/ripgrep-search.ts exactly.
 *
 * Run with:
 *   node --experimental-strip-types --test test/ripgrep-search.test.mts
 *
 * Integration test runs real rg against test/fixtures/ripgrep-sample/
 * (skipped if rg binary not installed).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/ripgrep-search.ts)
// ═══════════════════════════════════════════════════════════════════════

/** Single parsed vimgrep result entry. */
interface RgMatch {
	file: string;
	line: number;
	column: number;
	text: string;
}

/** Shaped output for tool result. */
interface RgResult {
	total_returned: number;
	results: RgMatch[];
}

// ═══════════════════════════════════════════════════════════════════════
// Pure functions under test (match source exactly)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate that a query is suitable for ripgrep (literal/regex text search)
 * rather than structural/syntax-aware search.
 */
function validateQuery(query: string): string | null {
	if (!query || typeof query !== "string") {
		return "Query must be a non-empty string";
	}

	const trimmed = query.trim();
	if (!trimmed) {
		return "Query must be a non-empty string";
	}

	// Reject patterns that look like structural/symbol searches
	if (trimmed.startsWith("class ")) {
		return `Query "${trimmed}" looks like a class definition search. Use map_codebase (ctags) to find class definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("def ")) {
		return `Query "${trimmed}" looks like a function definition search. Use map_codebase (ctags) to find function definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("function ")) {
		return `Query "${trimmed}" looks like a function definition search. Use map_codebase (ctags) to find function definitions, not ripgrep_search.`;
	}

	// Reject patterns with structural AST syntax ($ or {)
	if (trimmed.includes("$") || trimmed.includes("{")) {
		return `Query "${trimmed}" contains structural syntax ($ or {). Use structural_search (ast-grep) for structural code pattern matching, not ripgrep_search.`;
	}

	return null;
}

/**
 * Build ripgrep command arguments for a text search.
 */
function buildRgArgs(
	query: string,
	directory: string,
	maxCount: number,
): { command: string; args: string[] } {
	const args = [
		"--vimgrep",
		"--max-columns=200",
		`--max-count=${maxCount}`,
		"--no-heading",
		"-j1",
		query,
		directory,
	];
	return { command: "rg", args };
}

/**
 * Parse raw ripgrep --vimgrep output into RgResult.
 */
function parseVimgrepOutput(raw: string | null | undefined): RgResult {
	if (!raw) {
		return { total_returned: 0, results: [] };
	}

	const lines = raw.split("\n");
	const results: RgMatch[] = [];

	const vimgrepRegex = /^(.+?):(\d+):(\d+):(.*)$/;

	for (const line of lines) {
		if (!line.trim()) continue;

		const match = line.match(vimgrepRegex);
		if (!match) continue;

		const file = match[1]!;
		const lineNum = parseInt(match[2]!, 10);
		const column = parseInt(match[3]!, 10);
		const text = match[4]!;

		if (isNaN(lineNum) || isNaN(column)) continue;

		results.push({
			file,
			line: lineNum,
			column,
			text,
		});
	}

	return {
		total_returned: results.length,
		results,
	};
}

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

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("validateQuery", () => {
	it("rejects 'class User' (collision rule)", () => {
		const result = validateQuery("class User");
		assert.ok(result !== null, "Expected error for class definition pattern");
		assert.ok(result!.includes("map_codebase"), "Error should mention map_codebase");
	});

	it("rejects 'def verify_token' (collision rule)", () => {
		const result = validateQuery("def verify_token");
		assert.ok(result !== null);
		assert.ok(result!.includes("map_codebase"));
	});

	it("rejects 'function bootstrap' (collision rule)", () => {
		const result = validateQuery("function bootstrap");
		assert.ok(result !== null);
		assert.ok(result!.includes("map_codebase"));
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
		// The query is its own array element
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
		assert.strictEqual(args[1], "--max-columns=200");
		assert.ok(args[2]!.startsWith("--max-count="));
		assert.strictEqual(args[3], "--no-heading");
		assert.strictEqual(args[4], "-j1");
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

	const skipMsg = "rg binary not installed — skip integration test (install with: apt install ripgrep or brew install ripgrep)";

it('searches "5000" on fixture dir and returns 2 results', { skip: !hasRg ? skipMsg : false, timeout: 15_000 }, () => {
		const sampleDir = resolve("test/fixtures/ripgrep-sample");
		if (!existsSync(sampleDir)) {
			throw new Error("test/fixtures/ripgrep-sample/ not found");
		}

		const stdout = execSync("rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 5000 .", {
			cwd: sampleDir,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 10_000,
		});

		const result = parseVimgrepOutput(stdout);
		assert.strictEqual(result.total_returned, 2, `Expected 2 results, got ${result.total_returned}`);

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
	});

	it('searches "TODO" on fixture dir and returns 0 results', { skip: !hasRg ? skipMsg : false, timeout: 15_000 }, () => {
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
		assert.strictEqual(result.total_returned, 0, `Expected 0 results for TODO, got ${result.total_returned}`);
	});

	it('searches "TIMEOUT_MS" with max_count=1 and respects per-file limit', { skip: !hasRg ? skipMsg : false, timeout: 15_000 }, () => {
		const sampleDir = resolve("test/fixtures/ripgrep-sample");
		if (!existsSync(sampleDir)) {
			throw new Error("test/fixtures/ripgrep-sample/ not found");
		}

		// TIMEOUT_MS appears once per file, so max_count=1 should still return 2
		const stdout = execSync("rg --vimgrep --max-columns=200 --max-count=1 --no-heading -j1 TIMEOUT_MS .", {
			cwd: sampleDir,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 10_000,
		});

		const result = parseVimgrepOutput(stdout);
		assert.strictEqual(result.total_returned, 2, `Expected 2 results for TIMEOUT_MS, got ${result.total_returned}`);
	});

	it("column values are 1-indexed character positions", { skip: !hasRg ? skipMsg : false, timeout: 15_000 }, () => {
		const sampleDir = resolve("test/fixtures/ripgrep-sample");
		if (!existsSync(sampleDir)) {
			throw new Error("test/fixtures/ripgrep-sample/ not found");
		}

		const stdout = execSync("rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 5000 .", {
			cwd: sampleDir,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 10_000,
		});

		const result = parseVimgrepOutput(stdout);
		for (const entry of result.results) {
			assert.ok(typeof entry.column === "number" && entry.column > 0, `Column should be positive number, got ${entry.column}`);
		}
	});

	it("--max-columns=200 enforced (lines over 200 chars truncated)", { skip: !hasRg ? skipMsg : false, timeout: 15_000 }, () => {
		const sampleDir = resolve("test/fixtures/ripgrep-sample");
		if (!existsSync(sampleDir)) {
			throw new Error("test/fixtures/ripgrep-sample/ not found");
		}

		const stdout = execSync("rg --vimgrep --max-columns=200 --max-count=10 --no-heading -j1 '[\\s\\S]' .", {
			cwd: sampleDir,
			encoding: "utf-8",
			stdio: "pipe",
			timeout: 10_000,
		});

		const result = parseVimgrepOutput(stdout);
		for (const entry of result.results) {
			assert.ok(entry.text.length <= 200, `Text should be <= 200 chars with --max-columns=200, got ${entry.text.length}`);
		}
	});
});
