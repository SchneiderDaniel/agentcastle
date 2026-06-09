/**
 * Tests for venv-setup-test-utils.ts — mock exec factory
 *
 * Layer: entity — validates MockExecHandlers, MockExecCallbacks, and setupTest()
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ExecFn } from "../types.ts";
import {
	setupTest,
	type MockExecHandlers,
	type MockExecCallbacks,
} from "./venv-setup-test-utils.ts";

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
