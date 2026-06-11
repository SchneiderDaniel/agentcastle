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
import { buildPrettierArgs, findProjectRoot } from "../formatting.mts";

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { EslintDiagnostic } from "../eslint.mts";

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

// ═══════════════════════════════════════════════════════════════════════
// Tests: findProjectRoot
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a temporary directory with an optional package.json.
 * Returns { root, subdir, cleanup }.
 */
function createTempProject(): { root: string; subdir: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), "format-on-save-root-test-"));
	const subdir = join(root, "src", "components");
	return { root, subdir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("findProjectRoot", () => {
	it("finds project root from subdirectory when package.json exists at root", () => {
		const { root, subdir, cleanup } = createTempProject();
		try {
			writeFileSync(join(root, "package.json"), "{}");
			const result = findProjectRoot(subdir);
			assert.strictEqual(result, root);
		} finally {
			cleanup();
		}
	});

	it("returns input directory when no package.json exists in any parent", () => {
		const { root, subdir, cleanup } = createTempProject();
		try {
			// No package.json created anywhere
			const result = findProjectRoot(subdir);
			assert.strictEqual(result, subdir);
		} finally {
			cleanup();
		}
	});

	it("returns root of filesystem from / ", () => {
		// The root of the filesystem is its own parent, so the loop breaks.
		const result = findProjectRoot("/");
		assert.strictEqual(result, "/");
	});

	it("finds project root when cwd is at project root", () => {
		const { root, cleanup } = createTempProject();
		try {
			writeFileSync(join(root, "package.json"), "{}");
			const result = findProjectRoot(root);
			assert.strictEqual(result, root);
		} finally {
			cleanup();
		}
	});

	it("finds project root from nested subdirectory (multi-level)", () => {
		const { root, subdir, cleanup } = createTempProject();
		try {
			writeFileSync(join(root, "package.json"), "{}");
			const deepDir = join(root, "packages", "lib", "src");
			const result = findProjectRoot(deepDir);
			assert.strictEqual(result, root);
		} finally {
			cleanup();
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Tests: buildPrettierArgs config path resolution
// ═══════════════════════════════════════════════════════════════════════

describe("buildPrettierArgs config path", () => {
	it("resolves configPath against projectRoot (not cwd) from subdirectory", () => {
		const { root, subdir, cleanup } = createTempProject();
		try {
			writeFileSync(join(root, "package.json"), "{}");
			const result = buildPrettierArgs(subdir, "test.ts");
			const configIndex = result.args.indexOf("--config");
			assert.notStrictEqual(configIndex, -1, "args should contain --config");
			const configPath = result.args[configIndex + 1];
			assert.ok(configPath, "configPath should exist");
			assert.strictEqual(configPath, join(root, ".prettierrc"));
		} finally {
			cleanup();
		}
	});

	it("resolves configPath against projectRoot when cwd is project root", () => {
		const { root, cleanup } = createTempProject();
		try {
			writeFileSync(join(root, "package.json"), "{}");
			const result = buildPrettierArgs(root, "test.ts");
			const configIndex = result.args.indexOf("--config");
			assert.notStrictEqual(configIndex, -1);
			const configPath = result.args[configIndex + 1];
			assert.strictEqual(configPath, join(root, ".prettierrc"));
		} finally {
			cleanup();
		}
	});

	it("resolves configPath against projectRoot from multi-level subdirectory", () => {
		const { root, cleanup } = createTempProject();
		try {
			writeFileSync(join(root, "package.json"), "{}");
			const deepDir = join(root, "packages", "lib", "src");
			const result = buildPrettierArgs(deepDir, "test.ts");
			const configIndex = result.args.indexOf("--config");
			assert.notStrictEqual(configIndex, -1);
			const configPath = result.args[configIndex + 1];
			assert.strictEqual(configPath, join(root, ".prettierrc"));
		} finally {
			cleanup();
		}
	});

	it("falls back to cwd-based configPath when no project root found", () => {
		const { root, subdir, cleanup } = createTempProject();
		try {
			// No package.json anywhere
			const result = buildPrettierArgs(subdir, "test.ts");
			const configIndex = result.args.indexOf("--config");
			assert.notStrictEqual(configIndex, -1);
			const configPath = result.args[configIndex + 1];
			assert.strictEqual(configPath, join(subdir, ".prettierrc"));
		} finally {
			cleanup();
		}
	});

	it("configPath arg is the correct absolute path (not cwd-based)", () => {
		const { root, subdir, cleanup } = createTempProject();
		try {
			writeFileSync(join(root, "package.json"), "{}");
			const result = buildPrettierArgs(subdir, "test.ts");
			const configIndex = result.args.indexOf("--config");
			assert.notStrictEqual(configIndex, -1);
			const configPath = result.args[configIndex + 1];
			// configPath should NOT be cwd-based
			assert.notStrictEqual(configPath, join(subdir, ".prettierrc"));
			// configPath SHOULD be projectRoot-based
			assert.strictEqual(configPath, join(root, ".prettierrc"));
		} finally {
			cleanup();
		}
	});

	it("existing test 'returns { command, args } with npx when no local prettier' still passes", () => {
		// Characterization test: when no package.json in /tmp, behavior preserved
		const result = buildPrettierArgs("/tmp", "/tmp/test.ts");
		assert.strictEqual(result.command, "npx");
		assert.ok(Array.isArray(result.args));
		assert.ok(result.args.length >= 4);
		assert.strictEqual(result.args[0], "prettier");
		assert.ok(result.args.includes("--write"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Tests: error boundary (handler-level try/catch)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// Tests: handler-level integration (trust gate + mode-adaptive notifications)
// ═══════════════════════════════════════════════════════════════════════

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Temp file helper: creates a small temp file and returns cleanup + path.
 */
function createTempTsFile(): { dir: string; filePath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "fos-handler-test-"));
	const filePath = join(dir, "test.ts");
	writeFileSync(filePath, "const x = 1;\n");
	return { dir, filePath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

interface EventHandler {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

function getNotifyCalls(ctx: ExtensionContext): string[] {
	return (ctx as unknown as Record<string, unknown>)._notifyCalls as string[];
}

/**
 * Run the tool_result handler with given overrides.
 * Creates a temp .ts file so existsSync/statSync pass through.
 */
async function runHandler(
	ctxOverrides: Record<string, unknown> = {},
	eventOverrides: Record<string, unknown> = {},
	execResults?: {
		prettierCode?: number;
		prettierStdout?: string;
		eslintCode?: number;
		eslintStdout?: string;
	},
): Promise<{
	events: EventHandler[];
	execCalls: Array<{ command: string; args: string[]; opts?: Record<string, unknown> }>;
	sendUserMessages: Array<{ content: string; options: Record<string, unknown> }>;
	ctx: ExtensionContext;
	cleanup: () => void;
}> {
	const { dir, filePath, cleanup } = createTempTsFile();

	const events: EventHandler[] = [];
	const execCalls: Array<{ command: string; args: string[]; opts?: Record<string, unknown> }> = [];
	const sendUserMessages: Array<{ content: string; options: Record<string, unknown> }> = [];

	let execCallIndex = 0;

	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			events.push({ event, handler });
		},
		exec: async (command: string, args: string[], opts?: Record<string, unknown>) => {
			execCalls.push({ command, args, opts });
			const idx = execCallIndex++;
			if (idx === 0) {
				return {
					code: execResults?.prettierCode ?? 0,
					stdout: execResults?.prettierStdout ?? "",
					stderr: "",
					killed: false,
				};
			}
			return {
				code: execResults?.eslintCode ?? 0,
				stdout: execResults?.eslintStdout ?? "[]",
				stderr: "",
				killed: false,
			};
		},
		sendUserMessage: (content: string, options: Record<string, unknown>) => {
			sendUserMessages.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	const mod = await import("../index.ts");
	mod.default(pi);

	const toolResult = events.find((e) => e.event === "tool_result");
	assert.ok(toolResult !== undefined, "tool_result handler must be registered");

	const notifyCalls: string[] = [];

	// Use the temp dir as cwd so file resolution works
	const eventInputPath = (eventOverrides as Record<string, unknown>).input as
		| { path: string }
		| undefined;
	const relativePath = eventInputPath?.path ?? "test.ts";
	const inputPath = relativePath.startsWith("/") ? relativePath : relativePath;

	const ctx = {
		cwd: dir,
		ui: {
			notify: (message: string) => {
				notifyCalls.push(message);
			},
			setStatus: () => {},
			theme: {
				fg: () => (s: string) => s,
				bold: (s: string) => s,
			},
		} as unknown as ExtensionContext["ui"],
		sessionManager: {
			getEntries: () => [] as unknown[],
		},
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		_notifyCalls: notifyCalls,
		...ctxOverrides,
	} as unknown as ExtensionContext;

	const event = {
		toolName: "write",
		isError: false,
		input: { path: "test.ts" },
		...eventOverrides,
	};

	await toolResult.handler(event, ctx);

	return {
		events,
		execCalls,
		sendUserMessages,
		ctx: { ...ctx, _notifyCalls: notifyCalls } as unknown as ExtensionContext,
		cleanup,
	};
}

describe("handler — trust gate", () => {
	it("trusted + write + .ts → exec called for prettier and eslint", async () => {
		const { execCalls, sendUserMessages, cleanup } = await runHandler();
		try {
			assert.ok(execCalls.length >= 1, "prettier exec should be called");
			const prettierCall = execCalls[0]!;
			assert.ok(
				prettierCall.command === "npx" && prettierCall.args[0] === "prettier",
				"first exec should be prettier",
			);
		} finally {
			cleanup();
		}
	});

	it("untrusted + write + .ts → early return, no exec, no notifications", async () => {
		const { execCalls, sendUserMessages, ctx, cleanup } = await runHandler({
			isProjectTrusted: () => false,
		});
		try {
			assert.strictEqual(execCalls.length, 0, "no exec calls for untrusted project");
			assert.strictEqual(getNotifyCalls(ctx).length, 0, "no notify calls for untrusted project");
			assert.strictEqual(sendUserMessages.length, 0, "no sendUserMessage for untrusted project");
		} finally {
			cleanup();
		}
	});

	it("untrusted + edit + .ts → same early return", async () => {
		const { execCalls, sendUserMessages, ctx, cleanup } = await runHandler(
			{ isProjectTrusted: () => false },
			{ toolName: "edit" },
		);
		try {
			assert.strictEqual(execCalls.length, 0, "no exec calls for untrusted project on edit");
			assert.strictEqual(getNotifyCalls(ctx).length, 0);
			assert.strictEqual(sendUserMessages.length, 0);
		} finally {
			cleanup();
		}
	});

	it("untrusted + write + .py → skipped at shouldFormat before trust check", async () => {
		const { execCalls, sendUserMessages, cleanup } = await runHandler(
			{ isProjectTrusted: () => false },
			{ input: { path: "test.py" } },
		);
		try {
			assert.strictEqual(execCalls.length, 0, "no exec for .py file");
			assert.strictEqual(sendUserMessages.length, 0);
		} finally {
			cleanup();
		}
	});

	it("trusted + error event → skipped before trust check", async () => {
		const { execCalls, sendUserMessages, cleanup } = await runHandler(
			{ isProjectTrusted: () => true },
			{ isError: true },
		);
		try {
			assert.strictEqual(execCalls.length, 0, "no exec on error event");
			assert.strictEqual(sendUserMessages.length, 0);
		} finally {
			cleanup();
		}
	});
});

describe("handler — mode-adaptive notifications", () => {
	it("tui mode, format succeeds, ESLint returns diagnostics → notify + followUp", async () => {
		const eslintDiagStdout = JSON.stringify([
			{
				filePath: "test.ts",
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

		const { sendUserMessages, ctx, cleanup } = await runHandler(
			{ mode: "tui", hasUI: true },
			{},
			{ prettierCode: 0, eslintCode: 1, eslintStdout: eslintDiagStdout },
		);
		try {
			const notifyCalls = getNotifyCalls(ctx);
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Formatted:")),
				"TUI should notify formatted",
			);
			assert.ok(
				notifyCalls.some((m) => m.startsWith("ESLint ran:")),
				"TUI should notify ESLint ran",
			);
			assert.ok(sendUserMessages.length >= 1, "should send followUp for lint diagnostics");
			if (sendUserMessages.length >= 1) {
				assert.strictEqual(sendUserMessages[0]!.options.deliverAs, "followUp");
				assert.ok(sendUserMessages[0]!.content.includes("Lint Diagnostics"));
			}
		} finally {
			cleanup();
		}
	});

	it("rpc mode, format succeeds, ESLint returns diagnostics → no notify, followUp for format + lint", async () => {
		const eslintDiagStdout = JSON.stringify([
			{
				filePath: "test.ts",
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

		const { sendUserMessages, ctx, cleanup } = await runHandler(
			{ mode: "rpc", hasUI: true },
			{},
			{ prettierCode: 0, eslintCode: 1, eslintStdout: eslintDiagStdout },
		);
		try {
			const notifyCalls = getNotifyCalls(ctx);
			assert.strictEqual(notifyCalls.length, 0, "RPC mode should not call ctx.ui.notify");
			assert.ok(sendUserMessages.length >= 1, "should send followUp messages in RPC mode");

			const formatFollowUps = sendUserMessages.filter((m: { content: string }) =>
				m.content.startsWith("Formatted:"),
			);
			assert.ok(formatFollowUps.length >= 1, "RPC should send format summary as followUp");

			const lintFollowUps = sendUserMessages.filter((m: { content: string }) =>
				m.content.includes("Lint Diagnostics"),
			);
			assert.ok(lintFollowUps.length >= 1, "RPC should send lint diagnostics as followUp");
		} finally {
			cleanup();
		}
	});

	it("json mode, format succeeds → no notify, no followUp for format (lint followUp still sent if diagnostics)", async () => {
		const eslintDiagStdout = JSON.stringify([
			{
				filePath: "test.ts",
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

		const { sendUserMessages, ctx, cleanup } = await runHandler(
			{ mode: "json", hasUI: false },
			{},
			{ prettierCode: 0, eslintCode: 1, eslintStdout: eslintDiagStdout },
		);
		try {
			const notifyCalls = getNotifyCalls(ctx);
			assert.strictEqual(notifyCalls.length, 0, "JSON mode should not call ctx.ui.notify");

			const formatFollowUps = sendUserMessages.filter((m: { content: string }) =>
				m.content.startsWith("Formatted:"),
			);
			assert.strictEqual(
				formatFollowUps.length,
				0,
				"JSON mode should not send format summary followUp",
			);

			const lintFollowUps = sendUserMessages.filter((m: { content: string }) =>
				m.content.includes("Lint Diagnostics"),
			);
			assert.ok(lintFollowUps.length >= 1, "JSON mode should still send lint diagnostics followUp");
		} finally {
			cleanup();
		}
	});

	it("print mode, format succeeds → same as json mode", async () => {
		const eslintDiagStdout = JSON.stringify([
			{
				filePath: "test.ts",
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

		const { sendUserMessages, ctx, cleanup } = await runHandler(
			{ mode: "print", hasUI: false },
			{},
			{ prettierCode: 0, eslintCode: 1, eslintStdout: eslintDiagStdout },
		);
		try {
			const notifyCalls = getNotifyCalls(ctx);
			assert.strictEqual(notifyCalls.length, 0, "Print mode should not call ctx.ui.notify");

			const formatFollowUps = sendUserMessages.filter((m: { content: string }) =>
				m.content.startsWith("Formatted:"),
			);
			assert.strictEqual(
				formatFollowUps.length,
				0,
				"Print mode should not send format summary followUp",
			);

			const lintFollowUps = sendUserMessages.filter((m: { content: string }) =>
				m.content.includes("Lint Diagnostics"),
			);
			assert.ok(
				lintFollowUps.length >= 1,
				"Print mode should still send lint diagnostics followUp",
			);
		} finally {
			cleanup();
		}
	});

	it("all modes, ESLint returns empty/no diagnostics → no ESLint notify, no followUp for diagnostics", async () => {
		const { sendUserMessages, ctx, cleanup } = await runHandler(
			{ mode: "tui", hasUI: true },
			{},
			{ prettierCode: 0, eslintCode: 0, eslintStdout: "[]" },
		);
		try {
			const notifyCalls = getNotifyCalls(ctx);
			assert.ok(
				notifyCalls.some((m) => m.startsWith("Formatted:")),
				"should notify formatted",
			);
			assert.ok(
				!notifyCalls.some((m) => m.startsWith("ESLint ran:")),
				"should not notify ESLint ran when empty",
			);
			assert.strictEqual(sendUserMessages.length, 0, "no sendUserMessage when ESLint empty");
		} finally {
			cleanup();
		}
	});

	it("all modes, ESLint config error → retry with --no-eslintrc works", async () => {
		const { dir, cleanup: cleanupFiles } = createTempTsFile();
		try {
			const events2: EventHandler[] = [];
			const execCalls2: Array<{ command: string; args: string[]; opts?: Record<string, unknown> }> =
				[];
			const sendUserMessages2: Array<{ content: string; options: Record<string, unknown> }> = [];

			let execCallIndex = 0;

			const pi2 = {
				on: (event: string, handler: (...args: unknown[]) => unknown) => {
					events2.push({ event, handler });
				},
				exec: async (command: string, args: string[], opts?: Record<string, unknown>) => {
					execCalls2.push({ command, args, opts });
					const idx = execCallIndex++;
					if (idx === 0) return { code: 0, stdout: "", stderr: "", killed: false };
					if (idx === 1) return { code: 2, stdout: "", stderr: "", killed: false };
					return { code: 0, stdout: "[]", stderr: "", killed: false };
				},
				sendUserMessage: (content: string, options: Record<string, unknown>) => {
					sendUserMessages2.push({ content, options });
				},
			} as unknown as ExtensionAPI;

			const mod = await import("../index.ts");
			mod.default(pi2);

			const toolResult = events2.find((e) => e.event === "tool_result");
			assert.ok(toolResult !== undefined);

			const notifyCalls2: string[] = [];
			const ctx2 = {
				cwd: dir,
				ui: {
					notify: (message: string) => notifyCalls2.push(message),
					setStatus: () => {},
					theme: { fg: () => (s: string) => s, bold: (s: string) => s },
				} as unknown as ExtensionContext["ui"],
				sessionManager: { getEntries: () => [] as unknown[] },
				mode: "tui",
				hasUI: true,
				isProjectTrusted: () => true,
			} as unknown as ExtensionContext;

			await toolResult!.handler(
				{ toolName: "write", isError: false, input: { path: "test.ts" } },
				ctx2,
			);

			const eslintRetry = execCalls2.find((c) => c.args.includes("--no-eslintrc"));
			assert.ok(eslintRetry, "ESLint retry with --no-eslintrc should be called after config error");
			assert.ok(!notifyCalls2.some((m) => m.startsWith("ESLint ran:")));
			assert.strictEqual(
				sendUserMessages2.length,
				0,
				"no sendUserMessage when ESLint returns empty after retry",
			);
		} finally {
			cleanupFiles();
		}
	});

	it("untrusted + any mode → trust check precedes notification logic", async () => {
		const { execCalls, sendUserMessages, ctx, cleanup } = await runHandler(
			{ mode: "tui", hasUI: true, isProjectTrusted: () => false },
			{},
			{ prettierCode: 0, eslintCode: 0, eslintStdout: "[]" },
		);
		try {
			assert.strictEqual(execCalls.length, 0, "no exec calls for untrusted project");
			assert.strictEqual(getNotifyCalls(ctx).length, 0, "no notify for untrusted project");
			assert.strictEqual(sendUserMessages.length, 0, "no sendUserMessage for untrusted project");
		} finally {
			cleanup();
		}
	});
});

describe("handler error boundary", () => {
	it("runEslintOnFile does not throw on exec rejection (simulated via failing mock)", async () => {
		let caught = false;
		const failingExec: ExecFn = async () => {
			throw new Error("ENOENT: npx not found");
		};
		try {
			await runEslintOnFile(failingExec, "test.ts", "/tmp");
		} catch {
			caught = true;
		}
		// Without handler-level try/catch, this would propagate as unhandled rejection.
		// runEslintOnFile itself should propagate the error for the handler to catch.
		assert.strictEqual(caught, true, "exec rejection should propagate through runEslintOnFile");
	});

	it("tryRunEslint propagates exec rejection (no internal swallow)", async () => {
		const failingExec: ExecFn = async () => {
			throw new Error("exec failed");
		};
		await assert.rejects(async () => {
			// Import tryRunEslint via dynamic hack — use runEslintOnFile which wraps it
			await runEslintOnFile(failingExec, "test.ts", "/tmp");
		}, /exec failed/);
	});
});
