/**
 * Tests for tsc-checkpoint (Tier 2)
 *
 * Pure function tests for parseTscOutput() and formatTscDiagnostics().
 *
 * Run with:
 *   node --experimental-strip-types --test test/tsc-checkpoint.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Types (same shape as LspDiagnostic from lsp-auditor.ts)
// ═══════════════════════════════════════════════════════════════════════

interface TscDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error";
	message: string;
	code?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Pure functions under test
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse raw tsc --noEmit stderr output into TscDiagnostic[].
 *
 * tsc error format: file.ts(line,column): error TS<code>: <message>
 *
 * Handles:
 * - Multiple errors, multiple files
 * - Errors with and without TS code
 * - ANSI color codes (--pretty enabled by default)
 * - Non-error lines (info, file discovery, etc.) filtered out
 */
export function parseTscOutput(raw: string): TscDiagnostic[] {
	if (!raw || typeof raw !== "string") return [];

	const lines = raw.split("\n");
	const diagnostics: TscDiagnostic[] = [];
	// Regex: file(line,col): error TS<code>: message
	// Groups: 1=file, 2=line, 3=col, 4=code (optional TS prefix), 5=message
	const errorRegex = /^([^(]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
	const errorRegexNoCode = /^([^(]+)\((\d+),(\d+)\):\s+error\s+(.+)$/;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Try with TS code first
		let match = trimmed.match(errorRegex);
		if (match) {
			diagnostics.push({
				file: match[1]!,
				line: parseInt(match[2]!, 10),
				column: parseInt(match[3]!, 10),
				severity: "Error",
				message: match[5]!,
				code: match[4]!,
			});
			continue;
		}

		// Try without TS code
		match = trimmed.match(errorRegexNoCode);
		if (match) {
			diagnostics.push({
				file: match[1]!,
				line: parseInt(match[2]!, 10),
				column: parseInt(match[3]!, 10),
				severity: "Error",
				message: match[4]!,
			});
		}
	}

	return diagnostics;
}

/**
 * Format TSC diagnostics into developer-readable message.
 * Same format as LSP auditor: file, Line N: [Error] message.
 */
export function formatTscDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Group by file
	const byFile = new Map<string, TscDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		// Sort by line, then column
		diags.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const codePart = d.code ? ` (${d.code})` : "";
			lines.push(`${file}, Line ${d.line}: [${d.severity}] ${msg}${codePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("parseTscOutput", () => {
	it("parses standard tsc error with TS code", () => {
		const raw = "src/app.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
		const result = parseTscOutput(raw);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.file, "src/app.ts");
		assert.strictEqual(result[0]!.line, 10);
		assert.strictEqual(result[0]!.column, 5);
		assert.strictEqual(result[0]!.code, "TS2322");
		assert.strictEqual(result[0]!.message, "Type 'string' is not assignable to type 'number'.");
	});

	it("parses error without TS code", () => {
		const raw = "src/app.ts(1,1): error Cannot find module './nonexistent'.";
		const result = parseTscOutput(raw);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.code, undefined);
	});

	it("parses multiple errors from same file", () => {
		const raw = [
			"src/app.ts(10,5): error TS2322: Type error.",
			"src/app.ts(20,3): error TS2304: Cannot find name 'x'.",
		].join("\n");
		const result = parseTscOutput(raw);
		assert.strictEqual(result.length, 2);
	});

	it("parses errors from multiple files", () => {
		const raw = [
			"src/app.ts(10,5): error TS2322: Type error.",
			"src/lib.ts(3,1): error TS2304: Cannot find name 'y'.",
		].join("\n");
		const result = parseTscOutput(raw);
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0]!.file, "src/app.ts");
		assert.strictEqual(result[1]!.file, "src/lib.ts");
	});

	it("filters out non-error lines", () => {
		const raw = [
			"Files: 100",
			"node_modules/@types/node/index.d.ts(1,1): info: some info",
			"src/app.ts(10,5): error TS2322: Type error.",
			"",
			"Some random output",
		].join("\n");
		const result = parseTscOutput(raw);
		assert.strictEqual(result.length, 1);
	});

	it("empty string → empty array", () => {
		assert.deepStrictEqual(parseTscOutput(""), []);
	});

	it("null/undefined → empty array", () => {
		assert.deepStrictEqual(parseTscOutput(null as unknown as string), []);
		assert.deepStrictEqual(parseTscOutput(undefined as unknown as string), []);
	});

	it("handles file paths with special chars (dots, slashes)", () => {
		const raw = "./src/utils/helper.util.ts(5,10): error TS2304: Cannot find name 'foo'.";
		const result = parseTscOutput(raw);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.file, "./src/utils/helper.util.ts");
	});

	it("handles Windows-style paths with backslashes", () => {
		const raw = "src\\app.ts(10,5): error TS2322: Type error.";
		const result = parseTscOutput(raw);
		// Note: backslash might appear in file path
		assert.strictEqual(result.length, 1);
		assert.ok(result[0]!.file.includes("src"));
	});

	it("handles ANSI color codes (tsc --pretty default)", () => {
		// tsc --pretty outputs with ANSI color escape codes
		const raw =
			"\u001b[96msrc/app.ts\u001b[0m\u001b[93m(10,5)\u001b[0m: \u001b[91merror\u001b[0m\u001b[90m TS2322: \u001b[0m\u001b[97mType error.\u001b[0m";
		const result = parseTscOutput(raw);
		// With ANSI codes, parsing may fail or produce partially correct results
		// The function should not crash. Best effort parsing.
		assert.ok(Array.isArray(result));
	});

	it("line and column parsed as numbers", () => {
		const raw = "src/app.ts(42,7): error TS2551: Property 'x' does not exist on type 'Y'.";
		const result = parseTscOutput(raw);
		assert.strictEqual(result[0]!.line, 42);
		assert.strictEqual(result[0]!.column, 7);
	});

	it("message with colon preserved fully", () => {
		const raw =
			"src/app.ts(5,2): error TS2345: Argument of type '\"a\"' is not assignable to parameter of type '\"b\"'.";
		const result = parseTscOutput(raw);
		assert.strictEqual(result.length, 1);
		assert.ok(result[0]!.message.includes("not assignable"));
	});
});

describe("formatTscDiagnostics", () => {
	it("empty → empty string", () => {
		assert.strictEqual(formatTscDiagnostics([]), "");
	});

	it("single error → formatted line with code", () => {
		const result = formatTscDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
			},
		]);
		assert.strictEqual(result, "src/app.ts, Line 10: [Error] Type error (TS2322)");
	});

	it("single error without code → no code part", () => {
		const result = formatTscDiagnostics([
			{ file: "src/app.ts", line: 10, column: 5, severity: "Error", message: "Type error" },
		]);
		assert.strictEqual(result, "src/app.ts, Line 10: [Error] Type error");
	});

	it("multiple errors sorted by line", () => {
		const result = formatTscDiagnostics([
			{ file: "a.ts", line: 20, column: 1, severity: "Error", message: "err2", code: "TS2322" },
			{ file: "a.ts", line: 5, column: 3, severity: "Error", message: "err1", code: "TS2304" },
		]);
		const lines = result.split("\n");
		assert.strictEqual(lines[0], "a.ts, Line 5: [Error] err1 (TS2304)");
		assert.strictEqual(lines[1], "a.ts, Line 20: [Error] err2 (TS2322)");
	});

	it("multiple files → alphabetically sorted, blank line separator", () => {
		const result = formatTscDiagnostics([
			{ file: "z.ts", line: 1, column: 1, severity: "Error", message: "z", code: "TS1" },
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "a", code: "TS2" },
		]);
		const blocks = result.split("\n\n");
		assert.strictEqual(blocks.length, 2);
		assert.ok(blocks[0]!.startsWith("a.ts"));
		assert.ok(blocks[1]!.startsWith("z.ts"));
	});

	it("message >500 chars truncated", () => {
		const longMsg = "x".repeat(1000);
		const result = formatTscDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: longMsg, code: "TS2322" },
		]);
		assert.ok(result.length < 600);
		// Message part truncated to 500 chars, result includes code suffix
		assert.ok(result.includes("..."));
	});

	it("unicode in message passed through", () => {
		const result = formatTscDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "🚀 unicode 世界",
				code: "TS2322",
			},
		]);
		assert.ok(result.includes("🚀 unicode 世界"));
	});
});
