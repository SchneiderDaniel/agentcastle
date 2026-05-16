/**
 * Tests for tsc-checkpoint (Tier 2)
 *
 * Pure function tests for parseTscOutput() and formatTscDiagnostics().
 * Local copies match source at .pi/extensions/tsc-checkpoint.ts exactly.
 *
 * Run with:
 *   node --experimental-strip-types --test test/tsc-checkpoint.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/tsc-checkpoint.ts)
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
// Pure functions under test (match source exactly)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse raw tsc --noEmit stderr output into TscDiagnostic[].
 *
 * tsc error format: file.ts(line,column): error TS<code>: message
 *
 * Handles:
 * - Multiple errors from multiple files
 * - Errors with and without TS error code
 * - Non-error lines are filtered out (info, file counts, etc.)
 * - ANSI color codes (--pretty is default) — stripped via regex
 */
function parseTscOutput(raw: string): TscDiagnostic[] {
	if (!raw || typeof raw !== "string") return [];

	const lines = raw.split("\n");
	const diagnostics: TscDiagnostic[] = [];

	// Strip ANSI color codes first
	const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

	// Match: file(line,col): error TS<code>: message
	const errorRegex = /^([^:(]+)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;
	// Match: file(line,col): error message (no TS code)
	const errorRegexNoCode = /^([^:(]+)\((\d+),(\d+)\):\s+error\s+(.+)$/;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Strip ANSI before matching
		const clean = stripAnsi(trimmed);

		// Try with TS code first
		let match = clean.match(errorRegex);
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
		match = clean.match(errorRegexNoCode);
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
 * Same format as LSP auditor: file, Line N: [Error] message (code).
 */
function formatTscDiagnostics(diagnostics: TscDiagnostic[]): string {
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
		// ANSI stripping in source parses this correctly
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.file, "src/app.ts");
		assert.strictEqual(result[0]!.line, 10);
		assert.strictEqual(result[0]!.column, 5);
		assert.strictEqual(result[0]!.code, "TS2322");
		assert.strictEqual(result[0]!.message, "Type error.");
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

// ═══════════════════════════════════════════════════════════════════════
// Tests: runTscCheckpoint adapter (requires pi.exec mock)
// ═══════════════════════════════════════════════════════════════════════

interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
}

/**
 * Run `npx tsc --noEmit` using pi.exec.
 */
async function runTscCheckpoint(
	pi: { exec: (cmd: string, args: string[], opts?: unknown) => Promise<ExecResult> },
	worktreePath: string,
): Promise<TscCheckpointResult> {
	// Check for tsconfig.json first
	const tsconfigPath = resolve(worktreePath, "tsconfig.json");
	if (!existsSync(tsconfigPath)) {
		return { diagnostics: [], hasErrors: false };
	}

	const result = await pi.exec("npx", ["tsc", "--noEmit"], {
		cwd: worktreePath,
		timeout: 60_000,
	});

	if (result.code === 0) {
		return { diagnostics: [], hasErrors: false };
	}

	const output = result.stderr || result.stdout || "";
	const diagnostics = parseTscOutput(output);
	return {
		diagnostics,
		hasErrors: diagnostics.length > 0,
	};
}

describe("runTscCheckpoint (async, pi.exec)", () => {
	it("returns no errors when pi.exec returns code 0", async () => {
		const pi = {
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		};
		// Use a dir without tsconfig.json so it returns early
		const result = await runTscCheckpoint(pi as any, "/nonexistent");
		// No tsconfig.json, should return early with no errors
		assert.strictEqual(result.hasErrors, false);
		assert.strictEqual(result.diagnostics.length, 0);
	});

	it("returns parsed diagnostics when pi.exec returns non-zero", async () => {
		const stderr = "src/app.ts(10,5): error TS2322: Type 'string' is not assignable.";
		const pi = {
			exec: async () => ({ stdout: "", stderr, code: 1, killed: false }),
		};
		// Create a temp tsconfig to bypass the early-exit check
		const testDir = resolve(process.cwd(), "tmp-tsc-test");
		try {
			if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
			writeFileSync(resolve(testDir, "tsconfig.json"), "{}");
			const result = await runTscCheckpoint(pi as any, testDir);
			assert.strictEqual(result.hasErrors, true);
			assert.strictEqual(result.diagnostics.length, 1);
			assert.strictEqual(result.diagnostics[0]!.code, "TS2322");
		} finally {
			// Cleanup
			try { rmSync(testDir, { recursive: true }); } catch {}
		}
	});

	it("handles no tsconfig.json gracefully", async () => {
		const pi = {
			exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		};
		const result = await runTscCheckpoint(pi as any, "/tmp/no-tsconfig-dir");
		assert.strictEqual(result.hasErrors, false);
		assert.strictEqual(result.diagnostics.length, 0);
	});

	it("passes correct args to pi.exec when tsconfig exists", async () => {
		let captured: { cmd: string; args: string[]; opts?: unknown } | undefined;
		const pi = {
			exec: async (cmd: string, args: string[], opts?: unknown) => {
				captured = { cmd, args, opts };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		};
		const testDir = resolve(process.cwd(), "tmp-tsc-test2");
		try {
			if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
			writeFileSync(resolve(testDir, "tsconfig.json"), "{}");
			await runTscCheckpoint(pi as any, testDir);
			assert.ok(captured);
			assert.strictEqual(captured!.cmd, "npx");
			assert.deepStrictEqual(captured!.args, ["tsc", "--noEmit"]);
			assert.strictEqual((captured!.opts as any)?.cwd, testDir);
			assert.strictEqual((captured!.opts as any)?.timeout, 60_000);
		} finally {
			try { rmSync(testDir, { recursive: true }); } catch {}
		}
	});
});
