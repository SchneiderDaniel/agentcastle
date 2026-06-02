/**
 * Tests for format-on-save ESLint integration (Tier 1)
 *
 * Pure function tests for parseEslintOutput().
 * Imports from refactored modules.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/format-on-save/test/format-on-save.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

import {
	parseEslintOutput,
	formatEslintDiagnostics,
	runEslintOnFile,
	type ExecFn,
} from "../eslint.mts";
import { buildPrettierArgs } from "../formatting.mts";
import { formatFile } from "../formatter.mts";
import type { EslintDiagnostic } from "../types.mts";

// ═══════════════════════════════════════════════════════════════════════
// Tests: parseEslintOutput
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

// ═══════════════════════════════════════════════════════════════════════
// Tests: buildPrettierArgs
// ═══════════════════════════════════════════════════════════════════════

describe("buildPrettierArgs", () => {
	it("returns { command, args } with npx when no local prettier", () => {
		const result = buildPrettierArgs("/tmp", "/tmp/test.ts");
		assert.strictEqual(result.command, "npx");
		assert.ok(Array.isArray(result.args));
		assert.ok(result.args.length >= 4);
		assert.strictEqual(result.args[0], "prettier");
		// args[1] = --config, args[2] = configPath, args[3] = --write
		assert.ok(result.args.includes("--write"));
	});

	it("returned args contain --config flag", () => {
		const result = buildPrettierArgs("/tmp", "file.ts");
		assert.ok(result.args.includes("--config"));
	});

	it("returned args contain --write flag", () => {
		const result = buildPrettierArgs("/tmp", "file.ts");
		assert.ok(result.args.includes("--write"));
	});

	it("returned args contain filePath as last argument", () => {
		const result = buildPrettierArgs("/tmp", "/path/to/file.ts");
		assert.strictEqual(result.args[result.args.length - 1], "/path/to/file.ts");
	});

	it("no shell metacharacters in args", () => {
		const pathWithSpaces = "/path/with spaces/file.ts";
		const result = buildPrettierArgs("/tmp", pathWithSpaces);
		// Array args pass path as literal string — no quoting needed
		assert.strictEqual(result.args[result.args.length - 1], pathWithSpaces);
		for (const a of result.args) {
			assert.ok(!a.includes('"'), "arg should not contain double quotes");
			assert.ok(!a.includes("'"), "arg should not contain single quotes");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Tests: formatEslintDiagnostics
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// Tests: adapter functions (require exec mock)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a mock exec function that returns the given result.
 */
function mockExec(result: {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}): ExecFn {
	return async (_cmd: string, _args: string[], _opts?: unknown) => result;
}

describe("formatFile (async, exec)", () => {
	it("returns true when exec returns code 0", async () => {
		const exec = mockExec({ stdout: "", stderr: "", code: 0, killed: false });
		const ok = await formatFile(exec, "/tmp/test.ts", "/tmp");
		assert.strictEqual(ok, true);
	});

	it("returns false when exec returns non-zero code", async () => {
		const exec = mockExec({ stdout: "", stderr: "error", code: 1, killed: false });
		const ok = await formatFile(exec, "/tmp/test.ts", "/tmp");
		assert.strictEqual(ok, false);
	});

	it("passes correct command and args to exec", async () => {
		let captured: { cmd: string; args: string[]; opts?: unknown } | undefined;
		const exec: ExecFn = async (cmd, args, opts) => {
			captured = { cmd, args, opts };
			return { stdout: "", stderr: "", code: 0, killed: false };
		};
		await formatFile(exec, "/tmp/test.ts", "/tmp");
		assert.ok(captured);
		assert.strictEqual(captured!.cmd, "npx");
		assert.ok(captured!.args.includes("prettier"));
		assert.ok(captured!.args.includes("--write"));
		assert.strictEqual((captured!.opts as any)?.cwd, "/tmp");
	});
});

describe("runEslintOnFile (async, exec)", () => {
	it("returns empty string on eslint code 0 (no errors)", async () => {
		const exec = mockExec({ stdout: "[]", stderr: "", code: 0, killed: false });
		const result = await runEslintOnFile(exec, "test.ts", "/tmp");
		assert.strictEqual(result, "");
	});

	it("returns formatted diagnostics on code 1 (lint errors)", async () => {
		const stdout = JSON.stringify([
			{
				filePath: "src/app.ts",
				messages: [
					{
						line: 10,
						column: 5,
						severity: 2,
						message: "Unexpected any",
						ruleId: "no-explicit-any",
					},
				],
				errorCount: 1,
				warningCount: 0,
			},
		]);
		const exec = mockExec({ stdout, stderr: "", code: 1, killed: false });
		const result = await runEslintOnFile(exec, "test.ts", "/tmp");
		assert.ok(result);
		assert.ok(result!.includes("src/app.ts"));
		assert.ok(result!.includes("[Error]"));
	});

	it("retries with --no-eslintrc after config error", async () => {
		let callCount = 0;
		const exec: ExecFn = async (_cmd, args, _opts) => {
			callCount++;
			if (callCount === 1) {
				return { stdout: "", stderr: "", code: 2, killed: false };
			}
			return { stdout: "[]", stderr: "", code: 0, killed: false };
		};
		const result = await runEslintOnFile(exec, "test.ts", "/tmp");
		assert.strictEqual(result, "");
		assert.strictEqual(callCount, 2);
	});

	it("returns empty string on unexpected error code", async () => {
		const exec = mockExec({ stdout: "", stderr: "", code: 127, killed: false });
		const result = await runEslintOnFile(exec, "test.ts", "/tmp");
		assert.strictEqual(result, "");
	});
});
