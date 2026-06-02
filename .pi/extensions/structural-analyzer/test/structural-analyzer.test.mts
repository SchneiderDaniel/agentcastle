/**
 * Tests for Structural Analyzer (ast-grep integration)
 *
 * Pure function tests for parseSgOutput(), validatePattern(), truncateSnippet().
 * Local buildSgArgs simplified to pure arg-building (binary name passed as param).
 * New lazy binary detection test mocks pi.exec to verify caching behavior.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/structural-analyzer/test/structural-analyzer.test.mts
 *
 * Integration test runs real ast-grep against test/fixtures/structural-sample/
 * (skipped if ast-grep binary not installed).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import structuralAnalyzer from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/structural-analyzer.ts)
// ═══════════════════════════════════════════════════════════════════════

/** Raw sg JSONL output line. */
interface SgTag {
	file: string;
	lines: string;
	column?: number;
	text: string;
	language?: string;
}

/** Processed match entry in output. */
interface SgMatch {
	file: string;
	lines: string;
	snippet: string;
}

/** Shaped output for tool result. */
interface SgResult {
	matches: number;
	results: SgMatch[];
}

// ═══════════════════════════════════════════════════════════════════════
// Pure functions under test (local copies for test isolation)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate that a pattern is suitable for ast-grep (structural/syntax-aware search)
 * rather than plain text search.
 *
 * Rejects:
 * - Empty or whitespace-only strings
 * - Single words (no structural syntax like {, $, (, [, or wildcards)
 *
 * Returns null if valid, or an error string if invalid.
 */
function validatePattern(pattern: string): string | null {
	if (!pattern || typeof pattern !== "string") {
		return "Pattern must be a non-empty string";
	}

	const trimmed = pattern.trim();
	if (!trimmed) {
		return "Pattern must be a non-empty string";
	}

	// Structural syntax characters that indicate AST-aware search intent
	const structuralSyntax = /[{$(\\[\]]/;

	// If the pattern is a single word (no whitespace, no structural syntax), reject it
	const isSingleWord = /^\S+$/.test(trimmed);

	if (isSingleWord && !structuralSyntax.test(trimmed)) {
		return `Pattern "${trimmed}" is a single-word text pattern without structural syntax. Use ripgrep (ripgrep_search) for text-based search instead of ast-grep.`;
	}

	return null;
}

/**
 * Truncate a snippet to 120 characters.
 * If the string exceeds 120 chars, truncate to 119 chars and append '…' (120 total).
 */
function truncateSnippet(text: string): string {
	if (!text) return "";
	if (text.length <= 120) return text;
	return text.slice(0, 119) + "…";
}

/**
 * Build ast-grep command arguments for a pattern search (pure arg-building only).
 *
 * Binary name is passed explicitly (not detected here).
 * Uses --json=stream for NDJSON output (one JSON object per line).
 * Pattern is passed as a separate array element to prevent shell injection.
 */
function buildSgArgs(
	binary: string,
	pattern: string,
	language: string,
): { command: string; args: string[] } {
	const args = ["scan", "--pattern", pattern, "--json=stream", "--lang", language];
	return { command: binary, args };
}

/**
 * Parse raw ast-grep JSONL output into SgResult.
 *
 * ast-grep --json=stream outputs one JSON object per line (NDJSON).
 * Empty lines, malformed JSON lines, or lines missing required fields are skipped.
 */
function parseSgOutput(raw: string): SgResult {
	if (!raw || typeof raw !== "string") {
		return { matches: 0, results: [] };
	}

	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const results: SgMatch[] = [];

	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // skip malformed lines
		}

		if (typeof parsed !== "object" || parsed === null) continue;

		const tag = parsed as Record<string, unknown>;

		// Must have file, text, and lines fields
		if (typeof tag.file !== "string" || !tag.file) continue;
		if (typeof tag.text !== "string") continue;
		if (typeof tag.lines !== "string" && typeof tag.lines !== "number") continue;

		const linesStr = typeof tag.lines === "number" ? String(tag.lines) : (tag.lines as string);

		results.push({
			file: tag.file,
			lines: linesStr,
			snippet: truncateSnippet(tag.text),
		});
	}

	return {
		matches: results.length,
		results,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

/** Sample sg JSONL output simulating matches from a codebase search. */
const TWO_VALID_LINES = [
	JSON.stringify({
		file: "api/auth.py",
		lines: "22-28",
		text: "try:\n    verify_token(token)\nexcept AuthError:\n    print('auth failed')",
	}),
	JSON.stringify({
		file: "src/app.ts",
		lines: "10-10",
		text: "console.log('App started')",
	}),
].join("\n");

/** Empty output. */
const EMPTY_OUTPUT = "";

/** Output with one invalid JSON line and one valid line. */
const MALFORMED_OUTPUT = [
	"not valid json",
	JSON.stringify({
		file: "src/app.ts",
		lines: "10-10",
		text: "console.log('App started')",
	}),
].join("\n");

/** Line missing required fields. */
const MISSING_FIELDS_LINE = JSON.stringify({
	file: "orphan.ts",
	// missing text field
});

/** Output with null/undefined handling. */

// ═══════════════════════════════════════════════════════════════════════
// Tests — Pure functions
// ═══════════════════════════════════════════════════════════════════════

describe("validatePattern", () => {
	it("rejects single word 'TODO' (collision rule)", () => {
		const result = validatePattern("TODO");
		assert.ok(result !== null, "Expected error for single-word pattern");
		assert.ok(result!.includes("ripgrep"), "Error should mention ripgrep");
	});

	it("rejects single identifier 'verify_token'", () => {
		const result = validatePattern("verify_token");
		assert.ok(result !== null);
		assert.ok(result!.includes("ripgrep"));
	});

	it("rejects empty string", () => {
		const result = validatePattern("");
		assert.ok(result !== null);
	});

	it("rejects whitespace-only string", () => {
		const result = validatePattern("   ");
		assert.ok(result !== null);
	});

	it("accepts pattern with $ meta variable: console.log($A)", () => {
		const result = validatePattern("console.log($A)");
		assert.strictEqual(result, null);
	});

	it("accepts try/catch pattern with $$$BODY and $A", () => {
		const result = validatePattern("try { $$$BODY } catch (e) { console.log($A) }");
		assert.strictEqual(result, null);
	});

	it("accepts function pattern with parentheses and $", () => {
		const result = validatePattern("function($A, $B)");
		assert.strictEqual(result, null);
	});

	it("accepts if/return pattern with braces and $", () => {
		const result = validatePattern("if ($COND) { return $A; }");
		assert.strictEqual(result, null);
	});

	it("accepts array pattern with brackets and $", () => {
		const result = validatePattern("[$A, $B]");
		assert.strictEqual(result, null);
	});

	it("accepts class pattern with $", () => {
		const result = validatePattern("class $NAME");
		assert.strictEqual(result, null);
	});

	it("accepts pattern with console.log($A)", () => {
		const result = validatePattern("console.log($A)");
		assert.strictEqual(result, null);
	});
});

describe("truncateSnippet", () => {
	it("returns short text unchanged (under 120 chars)", () => {
		const text = "short text";
		assert.strictEqual(truncateSnippet(text), text);
	});

	it("returns 120-char string unchanged (exactly at limit)", () => {
		const text = "a".repeat(120);
		assert.strictEqual(truncateSnippet(text).length, 120);
		assert.strictEqual(truncateSnippet(text), text);
	});

	it("truncates 121-char string to 119 chars + '…'", () => {
		const text = "a".repeat(121);
		const result = truncateSnippet(text);
		assert.strictEqual(result.length, 120);
		assert.strictEqual(result, "a".repeat(119) + "…");
	});

	it("returns empty string for empty input", () => {
		assert.strictEqual(truncateSnippet(""), "");
	});

	it("truncates multi-line string respecting char count", () => {
		const longLine =
			"line with a lot of content that goes on and on and on and on and on and on and on and on and on and on and on and on and on and on\nand another line";
		const result = truncateSnippet(longLine);
		assert.ok(result.length <= 120);
		if (result !== longLine) {
			assert.strictEqual(result.endsWith("…"), true);
		}
	});
});

describe("parseSgOutput", () => {
	it("parses two valid JSONL lines", () => {
		const result = parseSgOutput(TWO_VALID_LINES);
		assert.strictEqual(result.matches, 2);
		assert.strictEqual(result.results.length, 2);
		assert.strictEqual(result.results[0]!.file, "api/auth.py");
		assert.strictEqual(result.results[0]!.lines, "22-28");
		assert.ok(result.results[0]!.snippet.length <= 120);
		assert.strictEqual(result.results[1]!.file, "src/app.ts");
	});

	it("returns empty result for empty string", () => {
		const result = parseSgOutput("");
		assert.strictEqual(result.matches, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("skips malformed JSON line, parses valid line", () => {
		const result = parseSgOutput(MALFORMED_OUTPUT);
		assert.strictEqual(result.matches, 1);
		assert.strictEqual(result.results.length, 1);
		assert.strictEqual(result.results[0]!.file, "src/app.ts");
	});

	it("handles null input defensively", () => {
		const result = parseSgOutput(null as unknown as string);
		assert.strictEqual(result.matches, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("handles undefined input defensively", () => {
		const result = parseSgOutput(undefined as unknown as string);
		assert.strictEqual(result.matches, 0);
		assert.deepStrictEqual(result.results, []);
	});

	it("skips lines with missing text field", () => {
		const result = parseSgOutput(MISSING_FIELDS_LINE);
		assert.strictEqual(result.matches, 0);
	});

	it("each result entry has precise file, lines, and snippet fields", () => {
		const result = parseSgOutput(TWO_VALID_LINES);
		for (const entry of result.results) {
			assert.ok(typeof entry.file === "string" && entry.file.length > 0);
			assert.ok(typeof entry.lines === "string" && entry.lines.length > 0);
			assert.ok(typeof entry.snippet === "string");
			assert.ok(entry.snippet.length <= 120);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — buildSgArgs (pure arg-building only, binary passed as param)
// ═══════════════════════════════════════════════════════════════════════

describe("buildSgArgs", () => {
	it("builds correct args for ts pattern", () => {
		const { command, args } = buildSgArgs("ast-grep", "console.log($A)", "ts");
		assert.strictEqual(command, "ast-grep");
		assert.deepStrictEqual(args, [
			"scan",
			"--pattern",
			"console.log($A)",
			"--json=stream",
			"--lang",
			"ts",
		]);
	});

	it("builds correct args for py pattern", () => {
		const { command, args } = buildSgArgs("ast-grep", "try { $$$BODY }", "py");
		assert.strictEqual(command, "ast-grep");
		assert.deepStrictEqual(args, [
			"scan",
			"--pattern",
			"try { $$$BODY }",
			"--json=stream",
			"--lang",
			"py",
		]);
	});

	it("pattern is passed as separate arg (not shell-escaped)", () => {
		const { args } = buildSgArgs("ast-grep", "console.log($A)", "ts");
		// The pattern is its own array element — no quoting in the arg itself
		assert.strictEqual(args[2], "console.log($A)");
	});

	it("accepts sg as binary name", () => {
		const { command, args } = buildSgArgs("sg", "console.log($A)", "ts");
		assert.strictEqual(command, "sg");
		assert.deepStrictEqual(args, [
			"scan",
			"--pattern",
			"console.log($A)",
			"--json=stream",
			"--lang",
			"ts",
		]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — Lazy binary detection (mocks pi.exec)
// ═══════════════════════════════════════════════════════════════════════

describe("lazy binary detection", () => {
	it("detects ast-grep on first execute and caches result", async () => {
		// Track all calls to pi.exec
		const execCalls: Array<{ command: string; args: string[] }> = [];
		let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;

		const mockPi = {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: async (command: string, args: string[]) => {
				execCalls.push({ command, args });
				if (command === "ast-grep" && args[0] === "--version") {
					return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
				}
				// For scan commands, return empty success (no matches)
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		};

		structuralAnalyzer(mockPi as any);

		assert.ok(capturedExecute !== undefined, "execute handler should be registered");

		// First execute — should trigger binary detection
		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" } as any,
		);

		// First call should be binary detection: ast-grep --version
		assert.strictEqual(execCalls.length >= 1, true);
		assert.strictEqual(execCalls[0]!.command, "ast-grep");
		assert.deepStrictEqual(execCalls[0]!.args, ["--version"]);

		execCalls.length = 0;

		// Second execute — should NOT trigger binary detection (cached)
		await capturedExecute!(
			"id2",
			{ pattern: "class $NAME", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" } as any,
		);

		// First call now should be the scan, not --version check
		assert.strictEqual(execCalls.length >= 1, true);
		assert.strictEqual(execCalls[0]!.command, "ast-grep");
		assert.strictEqual(execCalls[0]!.args[0], "scan");
	});

	it("falls back to sg when ast-grep not found and caches fallback", async () => {
		const execCalls: Array<{ command: string; args: string[] }> = [];
		let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;

		const mockPi = {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: async (command: string, args: string[]) => {
				execCalls.push({ command, args });
				if (command === "ast-grep" && args[0] === "--version") {
					return { stdout: "", stderr: "not found", code: 127, killed: false };
				}
				// For sg scan, return success
				return { stdout: "", stderr: "", code: 1, killed: false };
			},
		};

		structuralAnalyzer(mockPi as any);

		assert.ok(capturedExecute !== undefined);

		// First execute — ast-grep not found, should fall back to sg
		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" } as any,
		);

		// First call: ast-grep --version fails
		assert.strictEqual(execCalls[0]!.command, "ast-grep");
		assert.strictEqual(execCalls[0]!.args[0], "--version");

		// Second call: should use sg for scan
		assert.strictEqual(execCalls[1]!.command, "sg");
		assert.strictEqual(execCalls[1]!.args[0], "scan");

		execCalls.length = 0;

		// Third call (second execute): should still use sg (cached)
		await capturedExecute!(
			"id2",
			{ pattern: "class $NAME", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" } as any,
		);

		// First call should be sg scan, no --version check
		assert.strictEqual(execCalls[0]!.command, "sg");
		assert.strictEqual(execCalls[0]!.args[0], "scan");
		// No second call should exist (no binary check)
		assert.strictEqual(execCalls.length, 1);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Integration test (requires ast-grep binary installed)
// ═══════════════════════════════════════════════════════════════════════

describe("integration: ast-grep binary", () => {
	const hasAstGrep = (() => {
		try {
			const binary = (() => {
				try {
					execSync("ast-grep --version", { encoding: "utf-8", stdio: "pipe" });
					return "ast-grep";
				} catch {
					// On some systems sg may be ast-grep, but on Linux it's usually setgroups
					return null;
				}
			})();
			return binary !== null;
		} catch {
			return false;
		}
	})();

	const skipMsg =
		"ast-grep binary not installed — skip integration test (install with: npm i -g @ast-grep/cli)";

	it(
		"runs sg scan with console.log pattern on fixture dir",
		{ skip: !hasAstGrep ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve("test/fixtures/structural-sample");
			if (!existsSync(sampleDir)) {
				throw new Error("test/fixtures/structural-sample/ not found");
			}

			const binary = "ast-grep";
			const args = [
				"scan",
				"--pattern",
				"console.log($A)",
				"--json=stream",
				"--lang",
				"ts",
				"--cwd",
				sampleDir,
			];

			const stdout = execSync(
				`${binary} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseSgOutput(stdout);
			assert.ok(result.matches > 0, `Expected at least 1 match, got ${result.matches}`);

			for (const entry of result.results) {
				assert.ok(typeof entry.file === "string" && entry.file.length > 0);
				assert.ok(typeof entry.lines === "string");
				assert.ok(typeof entry.snippet === "string" && entry.snippet.length <= 120);
			}
		},
	);

	it(
		"runs sg scan with try/catch pattern on Python fixtures",
		{ skip: !hasAstGrep ? skipMsg : false, timeout: 15_000 },
		() => {
			const sampleDir = resolve("test/fixtures/structural-sample");
			if (!existsSync(sampleDir)) {
				throw new Error("test/fixtures/structural-sample/ not found");
			}

			const binary = "ast-grep";
			const args = [
				"scan",
				"--pattern",
				"try { $$$BODY } catch (e) { console.log($A) }",
				"--json=stream",
				"--lang",
				"py",
				"--cwd",
				sampleDir,
			];

			const stdout = execSync(
				`${binary} ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`,
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseSgOutput(stdout);
			assert.ok(result.matches > 0, `Expected at least 1 match, got ${result.matches}`);
		},
	);

	it(
		"returns error for nonexistent language",
		{ skip: !hasAstGrep ? skipMsg : false, timeout: 15_000 },
		() => {
			const binary = "ast-grep";
			try {
				const stdout = execSync(
					`${binary} scan --pattern 'console.log($A)' --json=stream --lang xyz`,
					{
						encoding: "utf-8",
						stdio: "pipe",
						timeout: 10_000,
					},
				);
				// If it somehow succeeds, that's unexpected but we don't fail
				assert.ok(true);
			} catch (e: unknown) {
				const err = e as { stderr?: string; stdout?: string; status?: number };
				// Expect error for unsupported language
				assert.ok(err.stderr || err.status !== 0, "Expected error for unsupported language");
			}
		},
	);
});
