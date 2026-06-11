/**
 * Phase 4: Output-adapter module — formatForMode pure function tests
 *
 * Tests the mode-adaptive formatting of LSP diagnostics.
 * Pure functions only — no I/O, no Pi API.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/lsp-auditor/test/lsp-auditor-output.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { LspDiagnostic, StructuredDiagnostics } from "../types.ts";
import { formatForMode } from "../output-adapter.ts";

// ─── Shared fixture — 3 diagnostics across 2 files ───────────────────

const SAMPLE_DIAGS: LspDiagnostic[] = [
	{
		file: "/workspace/src/app.ts",
		line: 10,
		column: 5,
		severity: "Error",
		message: "Type 'string' is not assignable to type 'number'",
	},
	{
		file: "/workspace/src/app.ts",
		line: 25,
		column: 1,
		severity: "Warning",
		message: "Variable 'x' is declared but never used",
	},
	{
		file: "/workspace/src/lib.ts",
		line: 3,
		column: 8,
		severity: "Error",
		message: "Cannot find name 'foo'",
	},
];

const WORKTREE_PATH = "/workspace";

// =========================================================================
// Tests
// =========================================================================

describe("formatForMode — TUI mode", () => {
	it("hasUI=true returns string with file:// URIs", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, true);
		assert.strictEqual(typeof result, "string");
		assert.ok((result as string).includes("file:///workspace/src/app.ts"));
		assert.ok((result as string).includes("file:///workspace/src/lib.ts"));
	});

	it("hasUI=true includes clickable link lines for each diagnostic", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, true) as string;
		// Each diagnostic should have a line with the file URI, line, severity, and message
		assert.ok(result.includes("[Error]"));
		assert.ok(result.includes("[Warning]"));
		assert.ok(result.includes("Type 'string' is not assignable"));
		assert.ok(result.includes("Variable 'x' is declared"));
	});

	it("hasUI=false returns plain text without file:// URIs", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, false);
		assert.strictEqual(typeof result, "string");
		assert.ok(!(result as string).includes("file://"));
	});

	it("hasUI=false output matches formatDiagnostics style", () => {
		const result = formatForMode(SAMPLE_DIAGS, "tui", WORKTREE_PATH, false) as string;
		// Should contain file paths but not as URIs
		assert.ok(result.includes("/workspace/src/app.ts"));
		assert.ok(!result.includes("file://"));
	});
});

describe("formatForMode — RPC mode", () => {
	it("returns StructuredDiagnostics object", () => {
		const result = formatForMode(SAMPLE_DIAGS, "rpc", WORKTREE_PATH, false);
		assert.ok(typeof result === "object" && result !== null);
		const sd = result as StructuredDiagnostics;
		assert.ok(Array.isArray(sd.files));
	});

	it("contains files[].path and files[].issues structure", () => {
		const result = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		assert.strictEqual(result.files.length, 2);

		const appTs = result.files.find((f) => f.path === "/workspace/src/app.ts");
		assert.ok(appTs);
		assert.strictEqual(appTs!.issues.length, 2);

		const libTs = result.files.find((f) => f.path === "/workspace/src/lib.ts");
		assert.ok(libTs);
		assert.strictEqual(libTs!.issues.length, 1);
	});

	it("issues have line, col, severity, message fields", () => {
		const result = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		const issue = result.files[0]!.issues[0]!;
		assert.ok("line" in issue);
		assert.ok("col" in issue);
		assert.ok("severity" in issue);
		assert.ok("message" in issue);
		assert.strictEqual(typeof issue.line, "number");
		assert.strictEqual(typeof issue.col, "number");
	});

	it("serializable via JSON.stringify", () => {
		const result = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		const serialized = JSON.stringify(result);
		assert.ok(typeof serialized === "string");
		const parsed = JSON.parse(serialized);
		assert.ok(Array.isArray(parsed.files));
	});
});

describe("formatForMode — JSON mode", () => {
	it("returns same StructuredDiagnostics shape as RPC mode", () => {
		const rpcResult = formatForMode(
			SAMPLE_DIAGS,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		const jsonResult = formatForMode(
			SAMPLE_DIAGS,
			"json",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		assert.deepStrictEqual(jsonResult, rpcResult);
	});
});

describe("formatForMode — Print mode", () => {
	it("returns plain text string matching formatDiagnostics output", () => {
		const result = formatForMode(SAMPLE_DIAGS, "print", WORKTREE_PATH, false);
		assert.strictEqual(typeof result, "string");
		// Should contain diagnostic details without file:// URIs
		assert.ok((result as string).includes("[Error]"));
		assert.ok((result as string).includes("[Warning]"));
	});

	it("no file:// URIs in output", () => {
		const result = formatForMode(SAMPLE_DIAGS, "print", WORKTREE_PATH, false) as string;
		assert.ok(!result.includes("file://"));
	});
});

describe("formatForMode — edge cases", () => {
	it("empty diagnostics array → empty string for text modes", () => {
		const tuiResult = formatForMode([], "tui", WORKTREE_PATH, true);
		assert.strictEqual(tuiResult, "");

		const printResult = formatForMode([], "print", WORKTREE_PATH, false);
		assert.strictEqual(printResult, "");
	});

	it("empty diagnostics array → empty files array for structured modes", () => {
		const rpcResult = formatForMode([], "rpc", WORKTREE_PATH, false) as StructuredDiagnostics;
		assert.deepStrictEqual(rpcResult, { files: [] });

		const jsonResult = formatForMode([], "json", WORKTREE_PATH, false) as StructuredDiagnostics;
		assert.deepStrictEqual(jsonResult, { files: [] });
	});

	it("null/undefined diagnostics → empty result, no crash", () => {
		const tuiResult = formatForMode(null as unknown as LspDiagnostic[], "tui", WORKTREE_PATH, true);
		assert.strictEqual(tuiResult, "");

		const rpcResult = formatForMode(
			undefined as unknown as LspDiagnostic[],
			"rpc",
			WORKTREE_PATH,
			false,
		);
		assert.deepStrictEqual(rpcResult, { files: [] });

		const jsonResult = formatForMode(
			null as unknown as LspDiagnostic[],
			"json",
			WORKTREE_PATH,
			false,
		);
		assert.deepStrictEqual(jsonResult, { files: [] });
	});

	it("diagnostics with unicode paths and messages → passed through unmodified", () => {
		const unicodeDiags: LspDiagnostic[] = [
			{
				file: "/workspace/测试/文件.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "🚀 unicode test 世界",
			},
		];
		const tuiResult = formatForMode(unicodeDiags, "tui", WORKTREE_PATH, true) as string;
		// TUI mode encodes file paths as URIs, so raw characters are percent-encoded
		assert.ok(tuiResult.includes("file:///workspace/%E6%B5%8B%E8%AF%95/%E6%96%87%E4%BB%B6.ts"));
		// Message text is not URI-encoded
		assert.ok(tuiResult.includes("🚀 unicode test 世界"));

		const rpcResult = formatForMode(
			unicodeDiags,
			"rpc",
			WORKTREE_PATH,
			false,
		) as StructuredDiagnostics;
		// Structured mode uses raw paths, not URIs
		assert.ok(rpcResult.files[0]!.path.includes("测试"));
		assert.ok(rpcResult.files[0]!.issues[0]!.message.includes("🚀 unicode test 世界"));
	});

	it("unknown mode → defaults to print mode (plain text)", () => {
		const result = formatForMode(SAMPLE_DIAGS, "unknown-mode", WORKTREE_PATH, false);
		assert.strictEqual(typeof result, "string");
	});
});
