/**
 * Tests for format-on-save ESLint integration (Tier 1)
 *
 * Pure function tests for parseEslintOutput().
 *
 * Run with:
 *   node --experimental-strip-types --test test/format-on-save.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Types (mirrored from implementation for test isolation)
// ═══════════════════════════════════════════════════════════════════════

interface EslintMessage {
	line: number;
	column: number;
	severity: number; // 1=warning, 2=error
	message: string;
	ruleId: string | null;
}

interface EslintFileResult {
	filePath: string;
	messages: EslintMessage[];
	errorCount: number;
	warningCount: number;
}

// ═══════════════════════════════════════════════════════════════════════
// Pure function under test (will be extracted to format-on-save.ts later)
// ═══════════════════════════════════════════════════════════════════════

export interface EslintDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning";
	message: string;
	ruleId: string | null;
}

/**
 * Parse ESLint JSON output into EslintDiagnostic[].
 * ESLint JSON format is an array of file results, each with messages[].
 * Severity: 1=Warning, 2=Error.
 *
 * Returns empty array if no errors/warnings.
 */
export function parseEslintOutput(jsonOutput: string): EslintDiagnostic[] {
	try {
		const data = JSON.parse(jsonOutput);
		if (!Array.isArray(data)) return [];

		const diagnostics: EslintDiagnostic[] = [];

		for (const fileResult of data) {
			if (!fileResult || !Array.isArray(fileResult.messages)) continue;

			const filePath = fileResult.filePath || "unknown";
			const messages: EslintMessage[] = fileResult.messages;

			for (const msg of messages) {
				const severity: "Error" | "Warning" = msg.severity === 2 ? "Error" : "Warning";
				diagnostics.push({
					file: filePath,
					line: msg.line || 0,
					column: msg.column || 0,
					severity,
					message: msg.message || "",
					ruleId: msg.ruleId || null,
				});
			}
		}

		return diagnostics;
	} catch {
		return [];
	}
}

/**
 * Format ESLint diagnostics into a follow-up message for the Developer.
 *
 * Format same as LSP auditor: file, Line N: [Severity] message (ruleId)
 * Grouped by file, sorted by line, errors first per file.
 */
export function formatEslintDiagnostics(diagnostics: EslintDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Group by file
	const byFile = new Map<string, EslintDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		// Sort: errors first, then by line
		diags.sort((a, b) => {
			if (a.severity !== b.severity) return a.severity === "Error" ? -1 : 1;
			if (a.line !== b.line) return a.line - b.line;
			return a.column - b.column;
		});

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const rulePart = d.ruleId ? ` (${d.ruleId})` : "";
			lines.push(`${file}, Line ${d.line}: [${d.severity}] ${msg}${rulePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("parseEslintOutput", () => {
	it("parses valid ESLint JSON with errors", () => {
		const json = JSON.stringify([
			{
				filePath: "/repo/src/app.ts",
				messages: [
					{
						line: 10,
						column: 5,
						severity: 2,
						message: "Unexpected any",
						ruleId: "@typescript-eslint/no-explicit-any",
					},
					{
						line: 15,
						column: 1,
						severity: 1,
						message: "Unused variable x",
						ruleId: "@typescript-eslint/no-unused-vars",
					},
				],
				errorCount: 1,
				warningCount: 1,
			},
		]);
		const result = parseEslintOutput(json);
		assert.strictEqual(result.length, 2);
		assert.strictEqual(result[0]!.severity, "Error");
		assert.strictEqual(result[0]!.ruleId, "@typescript-eslint/no-explicit-any");
		assert.strictEqual(result[1]!.severity, "Warning");
	});

	it("empty messages array → empty diagnostics", () => {
		const json = JSON.stringify([
			{ filePath: "a.ts", messages: [], errorCount: 0, warningCount: 0 },
		]);
		assert.strictEqual(parseEslintOutput(json).length, 0);
	});

	it("empty JSON array → empty diagnostics", () => {
		assert.strictEqual(parseEslintOutput("[]").length, 0);
	});

	it("malformed JSON → empty diagnostics (no crash)", () => {
		assert.strictEqual(parseEslintOutput("not valid json").length, 0);
	});

	it("null/undefined filePath → uses 'unknown'", () => {
		const json = JSON.stringify([
			{
				messages: [{ line: 1, column: 1, severity: 2, message: "err", ruleId: "no-var" }],
				errorCount: 1,
				warningCount: 0,
			},
		]);
		const result = parseEslintOutput(json);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.file, "unknown");
	});

	it("severity 1 → Warning, severity 2 → Error", () => {
		const json = JSON.stringify([
			{
				filePath: "a.ts",
				messages: [
					{ line: 1, column: 1, severity: 1, message: "warn", ruleId: "no-warn" },
					{ line: 2, column: 1, severity: 2, message: "err", ruleId: "no-err" },
				],
				errorCount: 1,
				warningCount: 1,
			},
		]);
		const result = parseEslintOutput(json);
		assert.strictEqual(result[0]!.severity, "Warning");
		assert.strictEqual(result[1]!.severity, "Error");
	});

	it("ruleId null → included as null", () => {
		const json = JSON.stringify([
			{
				filePath: "a.ts",
				messages: [{ line: 1, column: 1, severity: 2, message: "syntax error", ruleId: null }],
				errorCount: 1,
				warningCount: 0,
			},
		]);
		const result = parseEslintOutput(json);
		assert.strictEqual(result[0]!.ruleId, null);
	});

	it("multiple files → all parsed", () => {
		const json = JSON.stringify([
			{
				filePath: "a.ts",
				messages: [{ line: 1, column: 1, severity: 2, message: "err1", ruleId: "r1" }],
				errorCount: 1,
				warningCount: 0,
			},
			{
				filePath: "b.ts",
				messages: [{ line: 2, column: 3, severity: 1, message: "warn1", ruleId: "r2" }],
				errorCount: 0,
				warningCount: 1,
			},
		]);
		assert.strictEqual(parseEslintOutput(json).length, 2);
	});
});

describe("formatEslintDiagnostics", () => {
	it("empty → empty string", () => {
		assert.strictEqual(formatEslintDiagnostics([]), "");
	});

	it("single error → formatted line", () => {
		const result = formatEslintDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Unexpected any",
				ruleId: "@typescript-eslint/no-explicit-any",
			},
		]);
		assert.strictEqual(
			result,
			"src/app.ts, Line 10: [Error] Unexpected any (@typescript-eslint/no-explicit-any)",
		);
	});

	it("single warning without ruleId → no rule part", () => {
		const result = formatEslintDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Warning", message: "unused", ruleId: null },
		]);
		assert.strictEqual(result, "a.ts, Line 1: [Warning] unused");
	});

	it("errors sort before warnings in same file", () => {
		const result = formatEslintDiagnostics([
			{ file: "a.ts", line: 2, column: 1, severity: "Warning", message: "warn", ruleId: "w" },
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "err", ruleId: "e" },
		]);
		const lines = result.split("\n");
		assert.strictEqual(lines[0], "a.ts, Line 1: [Error] err (e)");
		assert.strictEqual(lines[1], "a.ts, Line 2: [Warning] warn (w)");
	});

	it("multiple files → blocks separated by blank line", () => {
		const result = formatEslintDiagnostics([
			{ file: "b.ts", line: 1, column: 1, severity: "Error", message: "err1", ruleId: null },
			{ file: "a.ts", line: 1, column: 1, severity: "Warning", message: "warn1", ruleId: null },
		]);
		assert.ok(result.includes("\n\n"));
		assert.ok(result.startsWith("a.ts"));
	});

	it("message >500 chars truncated", () => {
		const longMsg = "x".repeat(1000);
		const result = formatEslintDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: longMsg, ruleId: null },
		]);
		assert.ok(result.length < 600);
		// Message truncated to 500 chars, ends with ...
		assert.ok(result.includes("..."));
	});
});
