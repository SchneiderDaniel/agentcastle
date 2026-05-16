/**
 * Tests for format-on-save ESLint integration (Tier 1)
 *
 * Pure function tests for parseEslintOutput().
 * Local copies match source at .pi/extensions/format-on-save.ts exactly.
 *
 * Run with:
 *   node --experimental-strip-types --test test/format-on-save.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/format-on-save.ts)
// ═══════════════════════════════════════════════════════════════════════

interface EslintDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning";
	message: string;
	ruleId: string | null;
}

interface PrettierArgs {
	command: string;
	args: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// Pure function under test (match source exactly)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find the project root with a package.json, walking up from the given
 * directory. Used to locate the nearest node_modules for prettier.
 */
function findProjectRoot(fromDir: string): string {
	let dir = resolve(fromDir);
	while (true) {
		if (existsSync(resolve(dir, "package.json"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return fromDir; // fallback
}

/**
 * Build prettier args as { command, args } array, never a shell string.
 * Uses local node_modules if available, otherwise npx prettier.
 */
function buildPrettierArgs(cwd: string, filePath: string): PrettierArgs {
	const projectRoot = findProjectRoot(cwd);
	const localPrettier = resolve(projectRoot, "node_modules", ".bin", "prettier");
	const configPath = resolve(cwd, ".prettierrc");

	if (existsSync(localPrettier)) {
		return { command: localPrettier, args: ["--config", configPath, "--write", filePath] };
	}
	return { command: "npx", args: ["prettier", "--config", configPath, "--write", filePath] };
}

/** Parse ESLint JSON output into diagnostics array. */
function parseEslintOutput(jsonOutput: string): Array<{
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning";
	message: string;
	ruleId: string | null;
}> {
	try {
		const data = JSON.parse(jsonOutput);
		if (!Array.isArray(data)) return [];

		const diagnostics: Array<{
			file: string;
			line: number;
			column: number;
			severity: "Error" | "Warning";
			message: string;
			ruleId: string | null;
		}> = [];

		for (const fileResult of data) {
			if (!fileResult || !Array.isArray(fileResult.messages)) continue;

			const filePath = fileResult.filePath || "unknown";

			for (const msg of fileResult.messages) {
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

/** Format ESLint diagnostics into developer-readable follow-up message. */
function formatEslintDiagnostics(
	diagnostics: Array<{
		file: string;
		line: number;
		column: number;
		severity: "Error" | "Warning";
		message: string;
		ruleId: string | null;
	}>,
): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, typeof diagnostics>();
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

// ── parseEslintOutput ────────────────────────────────────────────────

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

// ── buildPrettierArgs ────────────────────────────────────────────────

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

// ── formatEslintDiagnostics ──────────────────────────────────────────

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
// Tests: adapter functions (require pi.exec mock)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a mock pi.exec that returns the given result.
 */
function mockPiExec(result: ExecResult): { exec: () => Promise<ExecResult> } {
	return {
		exec: async (_cmd: string, _args: string[], _opts?: unknown) => result,
	};
}

/**
 * Run prettier --write on a file using pi.exec. Returns true on success.
 */
async function formatFile(
	pi: { exec: (cmd: string, args: string[], opts?: unknown) => Promise<ExecResult> },
	filePath: string,
	configDir: string,
): Promise<boolean> {
	const { command, args } = buildPrettierArgs(configDir, filePath);
	const result = await pi.exec(command, args, { cwd: configDir, timeout: 15_000 });
	return result.code === 0;
}

/**
 * Attempt to run ESLint with given extra args.
 * Returns formatted string on success (or lint errors found).
 * Returns null if ESLint exited with code 2 (config error).
 * Returns empty string if no issues.
 */
async function tryRunEslint(
	pi: { exec: (cmd: string, args: string[], opts?: unknown) => Promise<ExecResult> },
	filePath: string,
	cwd: string,
	extraArgs: string[],
): Promise<string | null> {
	const result = await pi.exec(
		"npx",
		[
			"eslint",
			"--no-error-on-unmatched-pattern",
			"--format",
			"json",
			"--fix",
			...extraArgs,
			filePath,
		],
		{ cwd, timeout: 15_000 },
	);

	if (result.code === 2) return null; // Config error
	if (result.code === 0 || result.code === 1) {
		const diags = parseEslintOutput(result.stdout);
		if (diags.length === 0) return "";
		return formatEslintDiagnostics(diags);
	}
	return "";
}

/**
 * Run ESLint on a single file and return formatted diagnostics message.
 */
async function runEslintOnFile(
	pi: { exec: (cmd: string, args: string[], opts?: unknown) => Promise<ExecResult> },
	filePath: string,
	cwd: string,
): Promise<string> {
	// Primary attempt with project ESLint config
	let result = await tryRunEslint(pi, filePath, cwd, []);
	if (result !== null) return result;

	// Config error (exit code 2) — retry with --no-eslintrc fallback
	result = await tryRunEslint(pi, filePath, cwd, ["--no-eslintrc"]);
	return result ?? "";
}

describe("formatFile (async, pi.exec)", () => {
	it("returns true when pi.exec returns code 0", async () => {
		const pi = mockPiExec({ stdout: "", stderr: "", code: 0, killed: false });
		const ok = await formatFile(pi as any, "/tmp/test.ts", "/tmp");
		assert.strictEqual(ok, true);
	});

	it("returns false when pi.exec returns non-zero code", async () => {
		const pi = mockPiExec({ stdout: "", stderr: "error", code: 1, killed: false });
		const ok = await formatFile(pi as any, "/tmp/test.ts", "/tmp");
		assert.strictEqual(ok, false);
	});

	it("passes correct command and args to pi.exec", async () => {
		let captured: { cmd: string; args: string[]; opts?: unknown } | undefined;
		const pi = {
			exec: async (cmd: string, args: string[], opts?: unknown) => {
				captured = { cmd, args, opts };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		};
		await formatFile(pi as any, "/tmp/test.ts", "/tmp");
		assert.ok(captured);
		assert.strictEqual(captured!.cmd, "npx");
		assert.ok(captured!.args.includes("prettier"));
		assert.ok(captured!.args.includes("--write"));
		assert.strictEqual((captured!.opts as any)?.cwd, "/tmp");
	});
});

describe("tryRunEslint (async, pi.exec)", () => {
	it("returns empty string on code 0 (no errors)", async () => {
		const pi = mockPiExec({ stdout: "[]", stderr: "", code: 0, killed: false });
		const result = await tryRunEslint(pi as any, "test.ts", "/tmp", []);
		assert.strictEqual(result, "");
	});

	it("returns formatted diagnostics on code 1 (lint errors)", async () => {
		const stdout = JSON.stringify([
			{
				filePath: "src/app.ts",
				messages: [
					{ line: 10, column: 5, severity: 2, message: "Unexpected any", ruleId: "no-explicit-any" },
				],
				errorCount: 1,
				warningCount: 0,
			},
		]);
		const pi = mockPiExec({ stdout, stderr: "", code: 1, killed: false });
		const result = await tryRunEslint(pi as any, "test.ts", "/tmp", []);
		assert.ok(result);
		assert.ok(result!.includes("src/app.ts"));
		assert.ok(result!.includes("[Error]"));
	});

	it("returns null on code 2 (config error)", async () => {
		const pi = mockPiExec({ stdout: "", stderr: "config error", code: 2, killed: false });
		const result = await tryRunEslint(pi as any, "test.ts", "/tmp", []);
		assert.strictEqual(result, null);
	});

	it("returns empty string on unexpected error code", async () => {
		const pi = mockPiExec({ stdout: "", stderr: "", code: 127, killed: false });
		const result = await tryRunEslint(pi as any, "test.ts", "/tmp", []);
		assert.strictEqual(result, "");
	});
});

describe("runEslintOnFile (async, pi.exec)", () => {
	it("retries with --no-eslintrc after config error", async () => {
		let callCount = 0;
		const pi = {
			exec: async (_cmd: string, args: string[], _opts?: unknown) => {
				callCount++;
				if (callCount === 1) {
					// First call: config error (code 2)
					return { stdout: "", stderr: "", code: 2, killed: false };
				}
				// Second call: success
				return { stdout: "[]", stderr: "", code: 0, killed: false };
			},
		};
		const result = await runEslintOnFile(pi as any, "test.ts", "/tmp");
		assert.strictEqual(result, "");
		assert.strictEqual(callCount, 2);
	});
});
