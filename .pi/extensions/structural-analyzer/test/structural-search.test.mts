/**
 * Tests: structural-search — error handling in interpretSgExecResult
 *
 * The interpretSgExecResult function replaces the fragile keyword-heuristic
 * error detection with exit-code-based logic. This test covers all
 * exit-code/stdout/stderr combinations exhaustively.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/structural-analyzer/test/structural-search.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helper: read source and extract interpretSgExecResult via string matching
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(__dirname, "..", "index.ts");

function getSource(): string {
	return readFileSync(sourcePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Imports — we directly import from the source file
// ---------------------------------------------------------------------------

import { interpretSgExecResult, parseSgOutput, type SgMatch } from "../index.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("interpretSgExecResult", () => {
	// ── Success cases ─────────────────────────────────────────────────

	it("code 0 with valid JSONL stdout → returns parsed matches with success: true", () => {
		const stdout = [
			JSON.stringify({ file: "a.ts", lines: "1-5", text: "console.log(x)" }),
			JSON.stringify({ file: "b.ts", lines: "10-12", text: "console.log(y)" }),
		].join("\n");

		const result = interpretSgExecResult(0, stdout, "", "console.log($A)", "ts");

		assert.equal(result.isError, undefined, "should not be an error");
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, true);
		assert.equal(details.matches, 2);
		const results = details.results as SgMatch[];
		assert.equal(results.length, 2);
		assert.equal(results[0].file, "a.ts");
		assert.equal(results[1].file, "b.ts");
		assert.ok(typeof result.content[0].text === "string");
	});

	it("code 0 with empty stdout → returns success: true, matches: 0", () => {
		const result = interpretSgExecResult(0, "", "", "console.log($A)", "ts");

		assert.equal(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, true);
		assert.equal(details.matches, 0);
		const results = details.results as SgMatch[];
		assert.equal(results.length, 0);
	});

	it("code 0 with whitespace-only stdout → returns success: true, matches: 0", () => {
		const result = interpretSgExecResult(0, "  \n  \n  ", "", "console.log($A)", "ts");

		assert.equal(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, true);
		assert.equal(details.matches, 0);
	});

	it("code 0 with stdout having mixed content (valid + invalid JSONL) → parses valid lines", () => {
		const stdout = [
			JSON.stringify({ file: "a.ts", lines: "1", text: "foo" }),
			"not json",
			JSON.stringify({ file: "b.ts", lines: "5", text: "bar" }),
		].join("\n");

		const result = interpretSgExecResult(0, stdout, "", "foo", "ts");

		assert.equal(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.matches, 2);
	});

	// ── No-match case (exit code 1, empty stdout, empty stderr) ──────

	it("code 1, empty stdout, empty stderr → returns success: true, matches: 0 with 'No matches found' text", () => {
		const result = interpretSgExecResult(1, "", "", "nonexistent($A)", "ts");

		assert.equal(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, true);
		assert.equal(details.matches, 0);
		assert.ok(result.content[0].text.includes("No matches found"));
	});

	it("code 1, empty stdout, whitespace-only stderr → treated as empty, returns success", () => {
		const result = interpretSgExecResult(1, "", "  \n  ", "nonexistent($A)", "ts");

		assert.equal(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, true);
		assert.equal(details.matches, 0);
		assert.ok(result.content[0].text.includes("No matches found"));
	});

	// ── Error cases (post-fix: any non-zero exit with non-empty stderr or code > 1) ──

	it("code 1, empty stdout, stderr='unknown language: xyz' → returns isError: true with exit code + stderr", () => {
		const stderr = "unknown language: xyz";
		const result = interpretSgExecResult(1, "", stderr, "console.log($A)", "ts");

		assert.equal(result.isError, true);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, false);
		assert.equal(details.exitCode, 1);
		assert.ok((result.content[0].text as string).includes(stderr));
	});

	it("code 1, empty stdout, stderr='Some warning message' (no keyword) → returns isError: true", () => {
		const stderr = "Some warning message";
		const result = interpretSgExecResult(1, "", stderr, "console.log($A)", "ts");

		assert.equal(result.isError, true);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, false);
		assert.equal(details.exitCode, 1);
		// The stderr text should appear in the response
		assert.ok((result.content[0].text as string).includes(stderr));
	});

	it("code 126, empty stdout, stderr='Permission denied' → returns isError: true", () => {
		const stderr = "Permission denied";
		const result = interpretSgExecResult(126, "", stderr, "console.log($A)", "ts");

		assert.equal(result.isError, true);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, false);
		assert.equal(details.exitCode, 126);
		assert.ok((result.content[0].text as string).includes(stderr));
	});

	it("code 126, empty stdout, empty stderr → returns isError: true with exit code 126", () => {
		const result = interpretSgExecResult(126, "", "", "console.log($A)", "ts");

		assert.equal(result.isError, true);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, false);
		assert.equal(details.exitCode, 126);
		// Should mention "(no stderr)" since stderr is empty
		assert.ok((result.content[0].text as string).includes("126"));
	});

	it("code 137, empty stdout, empty stderr → returns isError: true (SIGKILL/OOM)", () => {
		const result = interpretSgExecResult(137, "", "", "console.log($A)", "ts");

		assert.equal(result.isError, true);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, false);
		assert.equal(details.exitCode, 137);
	});

	it("code 139, empty stdout, stderr='Segmentation fault' → returns isError: true", () => {
		const stderr = "Segmentation fault";
		const result = interpretSgExecResult(139, "", stderr, "console.log($A)", "ts");

		assert.equal(result.isError, true);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, false);
		assert.equal(details.exitCode, 139);
		assert.ok((result.content[0].text as string).includes(stderr));
	});

	it("code 2 (ast-grep internal error), empty stdout, empty stderr → returns isError: true", () => {
		const result = interpretSgExecResult(2, "", "", "console.log($A)", "ts");

		assert.equal(result.isError, true);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.success, false);
		assert.equal(details.exitCode, 2);
	});

	it("code 1, non-empty stdout (partial results), empty stderr → stdout is parsed, not treated as no-match", () => {
		// If there's stdout content but exit code 1, we still parse the content
		const stdout = JSON.stringify({ file: "a.ts", lines: "1", text: "match" });
		const result = interpretSgExecResult(1, stdout, "", "console.log($A)", "ts");

		// With non-empty stdout, we parse it regardless of exit code
		assert.equal(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.equal(details.matches, 1);
	});
});

describe("parseSgOutput", () => {
	it("parses valid JSONL lines", () => {
		const input = [
			JSON.stringify({ file: "a.ts", lines: "1-5", text: "console.log(x)" }),
			JSON.stringify({ file: "b.ts", lines: "10", text: "console.log(y)" }),
		].join("\n");

		const result = parseSgOutput(input);
		assert.equal(result.matches, 2);
		assert.equal(result.results[0].file, "a.ts");
	});

	it("skips malformed JSON lines", () => {
		const input = ["not json", JSON.stringify({ file: "a.ts", lines: "1", text: "ok" })].join("\n");

		const result = parseSgOutput(input);
		assert.equal(result.matches, 1);
	});

	it("returns empty result for empty input", () => {
		const result = parseSgOutput("");
		assert.equal(result.matches, 0);
	});
});
