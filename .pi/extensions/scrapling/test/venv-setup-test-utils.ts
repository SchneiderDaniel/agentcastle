/**
 * Test utilities for venv-setup tests.
 *
 * Provides a mock exec factory (setupTest) with typed handler overrides and
 * callbacks, eliminating ~90% of mock boilerplate in venv-setup-scrapling.test.ts.
 *
 * Layer: entity — shared test infrastructure, no production imports beyond types.ts
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { mock } from "node:test";
import type { ExecFn, ExecResult } from "../types.ts";

// ── Types ──

export interface MockExecHandlers {
	/** Handler for `exec(venv/bin/python3, ["-c", …])` — scrapling import check */
	venvCheck?: ExecResult;
	/** Handler for `exec("python3", ["-m", "venv", …])` — venv creation */
	createVenv?: ExecResult;
	/** Handler for `exec(venv/bin/python3, ["-m", "pip", "install", …])` — pip install */
	pipInstall?: ExecResult;
	/** Handler for `exec(venv/bin/python3, ["-m", "scrapling.cli", …])` — post-install step */
	scraplingCli?: ExecResult;
}

export interface MockExecCallbacks {
	/** Fires on pip install command with full args array */
	onPipInstall?: (args: string[]) => void;
	/** Fires on scrapling.cli command with full args array */
	onScraplingCli?: (args: string[]) => void;
	/** Fires on every exec call with cmd and args */
	onAny?: (cmd: string, args: string[]) => void;
}

// ── Defaults ──

const DEFAULT_RESULTS: Required<MockExecHandlers> = {
	venvCheck: { code: 1, stdout: "", stderr: "import failed" },
	createVenv: { code: 0, stdout: "", stderr: "" },
	pipInstall: { code: 0, stdout: "", stderr: "" },
	scraplingCli: { code: 0, stdout: "", stderr: "" },
};

// ── Factory ──

/**
 * Build an ExecFn mock implementation with typed handler overrides and callbacks.
 *
 * Default behaviour:
 *   - venvCheck → { code: 1 } (import fails — triggers venv creation)
 *   - createVenv → { code: 0 } (succeeds, creates fake python3 binary)
 *   - pipInstall → { code: 0 } (succeeds)
 *   - scraplingCli → { code: 0 } (succeeds)
 *   - any other command → { code: 1, stderr: "mock: unhandled" }
 */
function makeMockExec(handlers: MockExecHandlers = {}, callbacks: MockExecCallbacks = {}): ExecFn {
	const merged: Required<MockExecHandlers> = { ...DEFAULT_RESULTS, ...handlers };

	return async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
		callbacks.onAny?.(cmd, args);

		// venvCheck: exec(venv/bin/python3, ["-c", …])
		if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
			return merged.venvCheck;
		}

		// createVenv: exec("python3", ["-m", "venv", …])
		if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
			// Simulate venv directory structure so pyPath exists
			const venvPath = args[2];
			fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
			fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
			return merged.createVenv;
		}

		// pipInstall: exec(venv/bin/python3, ["-m", "pip", "install", …])
		if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
			callbacks.onPipInstall?.(args);
			return merged.pipInstall;
		}

		// scraplingCli: exec(venv/bin/python3, ["-m", "scrapling.cli", …])
		if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "scrapling.cli") {
			callbacks.onScraplingCli?.(args);
			return merged.scraplingCli;
		}

		return { code: 1, stdout: "", stderr: "mock: unhandled" };
	};
}

// ── setupTest ──

export interface SetupTestOptions {
	handlers?: MockExecHandlers;
	callbacks?: MockExecCallbacks;
}

export interface SetupTestResult {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecFn>>;
}

/**
 * Create a temp directory and a pre-configured mock exec function.
 *
 * @example
 *   const { cwd, exec } = setupTest();
 *   const result = await ensureScraplingVenv(exec, cwd);
 *
 * @example
 *   const { cwd, exec } = setupTest({ handlers: { pipInstall: { code: 1, stdout: "", stderr: "fail" } } });
 *   const result = await ensureScraplingVenv(exec, cwd);  // pip install will fail
 *
 * @example
 *   const calls: string[] = [];
 *   const { cwd, exec } = setupTest({}, { onPipInstall: (args) => calls.push(args.join(" ")) });
 */
export function setupTest(options: SetupTestOptions = {}): SetupTestResult {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-test-"));

	const execFn = makeMockExec(options.handlers, options.callbacks);
	const exec = mock.fn(execFn) as ReturnType<typeof mock.fn<ExecFn>> & {
		calls: Array<{ arguments: [string, string[]] }>;
	};

	return { cwd, exec };
}
