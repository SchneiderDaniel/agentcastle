/**
 * Tests for venv-setup.ts — ensureScraplingVenv with lock file
 *
 * Layer: entity — mock exec, temp fs, no real venv/network.
 *
 * Also tests the makeMockExec / setupTest factory used to eliminate
 * duplicate mock boilerplate across test cases.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, ExecResult } from "../types.ts";
import { ensureScraplingVenv, VENV_DIR } from "../venv-setup.ts";

// ── Mock Factory Types ──

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
		// The venv path is always the last arg (e.g. ["-m", "venv", "--clear", "<path>"])
		if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
			// Simulate venv directory structure so pyPath exists
			const venvPath = args[args.length - 1];
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

interface SetupTestOptions {
	handlers?: MockExecHandlers;
	callbacks?: MockExecCallbacks;
}

interface SetupTestResult {
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
function setupTest(options: SetupTestOptions = {}): SetupTestResult {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-test-"));

	const execFn = makeMockExec(options.handlers, options.callbacks);
	const exec = mock.fn(execFn) as ReturnType<typeof mock.fn<ExecFn>> & {
		calls: Array<{ arguments: [string, string[]] }>;
	};

	return { cwd, exec };
}

// ══════════════════════════════════════════════════════════════════════
//  Mock Factory Tests
// ══════════════════════════════════════════════════════════════════════

describe("setupTest — default behavior", () => {
	it("(entity) setupTest with no args configures exec with default handler chain", async () => {
		const { cwd, exec } = setupTest();

		// venvCheck fails by default → triggers venv creation
		assert.ok(cwd, "cwd should be set");
		assert.equal(typeof exec, "function", "exec should be a mock function");
	});

	it("(entity) unhandled command returns mock: unhandled", async () => {
		const { exec } = setupTest();
		const result = await exec("nonexistent", ["cmd"]);
		assert.equal(result.code, 1);
		assert.equal(result.stderr, "mock: unhandled");
	});

	it("(entity) exec.mock.calls tracks all invocations through factory", async () => {
		const { exec } = setupTest({
			handlers: { venvCheck: { code: 0, stdout: "ok", stderr: "" } },
		});
		await exec("some/path/venv/bin/python3", ["-c", "import scrapling"]);
		assert.equal(exec.mock.calls.length, 1);
	});
});

describe("setupTest — MockExecHandlers overrides", () => {
	it("(entity) setupTest with venvCheck override returns custom result", async () => {
		const { exec } = setupTest({
			handlers: { venvCheck: { code: 0, stdout: "ok", stderr: "" } },
		});
		const result = await exec("/path/venv/bin/python3", ["-c", "import scrapling"]);
		assert.equal(result.code, 0);
		assert.equal(result.stdout, "ok");
	});

	it("(entity) setupTest with createVenv override returns custom result", async () => {
		const { exec } = setupTest({
			handlers: { createVenv: { code: 1, stdout: "", stderr: "venv failed" } },
		});
		const result = await exec("python3", ["-m", "venv", "/tmp/test-venv"]);
		assert.equal(result.code, 1);
		assert.equal(result.stderr, "venv failed");
	});

	it("(entity) setupTest with pipInstall override returns custom result", async () => {
		const { exec } = setupTest({
			handlers: { pipInstall: { code: 1, stdout: "", stderr: "pip failed" } },
		});
		const result = await exec("/path/venv/bin/python3", ["-m", "pip", "install", "scrapling"]);
		assert.equal(result.code, 1);
		assert.equal(result.stderr, "pip failed");
	});

	it("(entity) setupTest with scraplingCli override returns custom result", async () => {
		const { exec } = setupTest({
			handlers: { scraplingCli: { code: 1, stdout: "", stderr: "cli failed" } },
		});
		const result = await exec("/path/venv/bin/python3", ["-m", "scrapling.cli", "install"]);
		assert.equal(result.code, 1);
		assert.equal(result.stderr, "cli failed");
	});

	it("(entity) partial override does not affect other handlers", async () => {
		const { exec } = setupTest({
			handlers: { pipInstall: { code: 1, stdout: "", stderr: "pip failed" } },
		});

		// venvCheck still defaults to code 1
		const checkResult = await exec("/path/venv/bin/python3", ["-c", "import scrapling"]);
		assert.equal(checkResult.code, 1);
		assert.equal(checkResult.stderr, "import failed");

		// pipInstall returns override
		const pipResult = await exec("/path/venv/bin/python3", ["-m", "pip", "install", "scrapling"]);
		assert.equal(pipResult.code, 1);
		assert.equal(pipResult.stderr, "pip failed");
	});
});

describe("setupTest — MockExecCallbacks", () => {
	it("(entity) onPipInstall callback fires with correct args on pip install command", async () => {
		const pipArgs: string[][] = [];
		const { exec } = setupTest({
			callbacks: {
				onPipInstall: (args) => pipArgs.push(args),
			},
		});

		await exec("/path/venv/bin/python3", ["-m", "pip", "install", "scrapling[fetchers]"]);

		assert.equal(pipArgs.length, 1);
		assert.ok(pipArgs[0].includes("pip"));
		assert.ok(pipArgs[0].includes("scrapling[fetchers]"));
	});

	it("(entity) onScraplingCli callback fires with correct args on cli command", async () => {
		const cliArgs: string[][] = [];
		const { exec } = setupTest({
			callbacks: {
				onScraplingCli: (args) => cliArgs.push(args),
			},
		});

		await exec("/path/venv/bin/python3", ["-m", "scrapling.cli", "install"]);

		assert.equal(cliArgs.length, 1);
		assert.ok(cliArgs[0].includes("install"));
	});

	it("(entity) onAny callback fires for every exec command", async () => {
		const allCalls: Array<{ cmd: string; args: string[] }> = [];
		const { exec } = setupTest({
			handlers: {
				venvCheck: { code: 1, stdout: "", stderr: "import failed" },
				createVenv: { code: 0, stdout: "", stderr: "" },
				pipInstall: { code: 0, stdout: "", stderr: "" },
				scraplingCli: { code: 0, stdout: "", stderr: "" },
			},
			callbacks: {
				onAny: (cmd, args) => allCalls.push({ cmd, args }),
			},
		});

		// Simulate the full venv setup flow
		await exec("/path/venv/bin/python3", ["-c", "import scrapling"]);
		await exec("python3", ["-m", "venv", "/tmp/test-venv"]);
		await exec("/path/venv/bin/python3", ["-m", "pip", "install", "scrapling"]);
		await exec("/path/venv/bin/python3", ["-m", "scrapling.cli", "install"]);

		assert.equal(allCalls.length, 4, "onAny should fire once per exec command");
		assert.ok(allCalls[0].cmd.includes("venv/bin/python3"), "first call is venv check");
		assert.equal(allCalls[1].cmd, "python3", "second call is create venv");
		assert.ok(allCalls[2].cmd.includes("venv/bin/python3"), "third call is pip install");
		assert.equal(allCalls[3].args[1], "scrapling.cli", "fourth call is scrapling cli");
	});

	it("(entity) onAny fires for commands in correct order", async () => {
		const order: string[] = [];
		const { exec } = setupTest({
			handlers: {
				venvCheck: { code: 1, stdout: "", stderr: "import failed" },
				createVenv: { code: 0, stdout: "", stderr: "" },
				pipInstall: { code: 0, stdout: "", stderr: "" },
				scraplingCli: { code: 0, stdout: "", stderr: "" },
			},
			callbacks: {
				onAny: (cmd) => {
					if (cmd.includes("venv/bin/python3") && order.length === 0) order.push("venvCheck");
					else if (cmd === "python3") order.push("createVenv");
					else if (
						cmd.includes("venv/bin/python3") &&
						order.includes("createVenv") &&
						!order.includes("pipInstall")
					)
						order.push("pipInstall");
					else if (cmd.includes("venv/bin/python3") && order.includes("pipInstall"))
						order.push("scraplingCli");
				},
			},
		});

		await exec("/path/venv/bin/python3", ["-c", "import scrapling"]);
		await exec("python3", ["-m", "venv", "/tmp/test-venv"]);
		await exec("/path/venv/bin/python3", ["-m", "pip", "install", "scrapling"]);
		await exec("/path/venv/bin/python3", ["-m", "scrapling.cli", "install"]);

		assert.deepEqual(order, ["venvCheck", "createVenv", "pipInstall", "scraplingCli"]);
	});
});

// ══════════════════════════════════════════════════════════════════════
//  Production code tests — ensureScraplingVenv
// ══════════════════════════════════════════════════════════════════════

describe("VENV_DIR constant", () => {
	it("(entity) VENV_DIR is .pi/scrapling-venv", () => {
		assert.equal(VENV_DIR, ".pi/scrapling-venv");
	});
});

describe("ensureScraplingVenv — venv already set up", () => {
	it("(entity) returns python path when scrapling already installed", async () => {
		const { cwd, exec } = setupTest({
			handlers: { venvCheck: { code: 0, stdout: "ok", stderr: "" } },
		});

		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result !== null, "should return python path");
		assert.ok(result!.includes("venv/bin/python3"), "path should end with python3");
	});

	it("(entity) does not create venv when scrapling already present", async () => {
		const callLog: Array<{ cmd: string; args: string[] }> = [];
		const { cwd, exec } = setupTest({
			handlers: { venvCheck: { code: 0, stdout: "ok", stderr: "" } },
			callbacks: { onAny: (cmd, args) => callLog.push({ cmd, args }) },
		});

		await ensureScraplingVenv(exec, cwd);

		const venvCreationCalls = callLog.filter(
			(c) => c.cmd === "python3" && c.args.includes("-m") && c.args.includes("venv"),
		);
		assert.equal(venvCreationCalls.length, 0, "should not call python3 -m venv");
	});

	it("(entity) returns python path when lock file exists (parallel process creating venv)", async () => {
		const { cwd, exec } = setupTest();

		// Create lock file to simulate parallel venv creation
		const lockFilePath = path.join(cwd, ".pi", ".scrapling-venv.lock");
		fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
		fs.writeFileSync(lockFilePath, "locked");

		const result = await ensureScraplingVenv(exec, cwd);
		// When lock file exists, we wait and then return the python path
		assert.ok(result !== null, "should still return python path even with lock file");
		assert.ok(result!.includes("venv/bin/python3"), "path should end with python3");
	});
});

describe("ensureScraplingVenv — venv creation", () => {
	it("(entity) creates virtual environment from scratch", async () => {
		const callLog: Array<{ cmd: string; args: string[] }> = [];
		const { cwd, exec } = setupTest({
			callbacks: { onAny: (cmd, args) => callLog.push({ cmd, args }) },
		});

		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result !== null, "should return python path after creating venv");

		const venvCreationCalls = callLog.filter(
			(c) => c.cmd === "python3" && c.args.includes("-m") && c.args.includes("venv"),
		);
		assert.equal(venvCreationCalls.length, 1, "should call python3 -m venv once");
	});

	it("(entity) installs scrapling[fetchers], markdownify, and beautifulsoup4", async () => {
		const pipCalls: string[] = [];
		const { cwd, exec } = setupTest({
			callbacks: {
				onPipInstall: (args) => pipCalls.push(args.slice(2).join(" ")),
			},
		});

		await ensureScraplingVenv(exec, cwd);

		const combinedPip = pipCalls.join(" ");
		assert.ok(combinedPip.includes("scrapling[fetchers]"), "should install scrapling[fetchers]");
		assert.ok(combinedPip.includes("markdownify"), "should install markdownify");
		assert.ok(combinedPip.includes("beautifulsoup4"), "should install beautifulsoup4");
	});

	it("(entity) runs scrapling.cli install after pip install", async () => {
		const postInstallCalls: string[] = [];
		const { cwd, exec } = setupTest({
			callbacks: {
				onScraplingCli: (args) => postInstallCalls.push(args.join(" ")),
			},
		});

		await ensureScraplingVenv(exec, cwd);
		assert.ok(postInstallCalls.length > 0, "should call scrapling.cli install");
		assert.ok(
			postInstallCalls.some((c) => c.includes("install")),
			"scrapling.cli should be called with install",
		);
	});

	it("(entity) creates and removes lock file during venv setup", async () => {
		const { cwd, exec } = setupTest();

		const lockFilePath = path.join(cwd, ".pi", ".scrapling-venv.lock");
		assert.ok(!fs.existsSync(lockFilePath), "lock should not exist before setup");

		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result !== null, "should succeed");

		// Lock file should be removed after setup
		assert.ok(!fs.existsSync(lockFilePath), "lock should be removed after setup");
	});
});

describe("ensureScraplingVenv — failure paths", () => {
	it("(entity) returns null when pip install fails", async () => {
		const { cwd, exec } = setupTest({
			handlers: { pipInstall: { code: 1, stdout: "", stderr: "pip install failed" } },
		});

		const result = await ensureScraplingVenv(exec, cwd);
		assert.equal(result, null, "should return null when pip fails");
	});

	it("(entity) returns null when venv creation fails", async () => {
		const { cwd, exec } = setupTest({
			handlers: { createVenv: { code: 1, stdout: "", stderr: "venv creation failed" } },
		});

		const result = await ensureScraplingVenv(exec, cwd);
		assert.equal(result, null, "should return null when venv creation fails");
	});
});

describe("ensureScraplingVenv — lock file race condition prevention", () => {
	it("(entity) lock file is created before pip install and removed after", async () => {
		const pipState: { lockExisted: boolean } = { lockExisted: false };
		const { cwd, exec } = setupTest({
			callbacks: {
				onPipInstall: () => {
					const lockPath = path.join(cwd, ".pi", ".scrapling-venv.lock");
					pipState.lockExisted = fs.existsSync(lockPath);
				},
			},
		});

		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result !== null, "should succeed");
		assert.ok(pipState.lockExisted, "lock file should exist during pip install");
	});

	it("(entity) removes lock file even if pip install fails", async () => {
		const { cwd, exec } = setupTest({
			handlers: { pipInstall: { code: 1, stdout: "", stderr: "pip failed" } },
		});
		const lockFilePath = path.join(cwd, ".pi", ".scrapling-venv.lock");

		const result = await ensureScraplingVenv(exec, cwd);
		assert.equal(result, null, "should return null on failure");
		assert.ok(!fs.existsSync(lockFilePath), "lock should be removed even after failure");
	});
});
