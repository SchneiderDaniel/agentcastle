/**
 * Tests for venv-setup.ts — ensureScraplingVenv with lock file
 *
 * Layer: entity — mock exec, temp fs, no real venv/network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { ExecResult } from "../types.ts";
import { ensureScraplingVenv, VENV_DIR } from "../venv-setup.ts";
import {
	setupTest,
	type MockExecHandlers,
	type MockExecCallbacks,
} from "./venv-setup-test-utils.ts";

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
