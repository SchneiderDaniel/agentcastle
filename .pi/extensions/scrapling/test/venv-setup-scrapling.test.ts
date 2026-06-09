/**
 * Tests for venv-setup.ts — ensureScraplingVenv with lock file
 *
 * Layer: entity — mock exec, temp fs, no real venv/network.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecFn, ExecResult } from "../types.ts";
import { ensureScraplingVenv, VENV_DIR } from "../venv-setup.ts";

type ExecHandler = ExecFn;

function makeMockExec(handler: ExecHandler) {
	return mock.fn(handler) as ReturnType<typeof mock.fn<ExecHandler>> & {
		calls: Array<{ arguments: [string, string[]] }>;
	};
}

/** Create a temp directory for testing */
function setup(): {
	cwd: string;
	exec: ReturnType<typeof mock.fn<ExecHandler>>;
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "scrapling-test-"));
	const exec = makeMockExec(async (_cmd: string, _args: string[]) => {
		return { code: 1, stdout: "", stderr: "mock: not mocked" };
	});
	return { cwd, exec };
}

describe("VENV_DIR constant", () => {
	it("(entity) VENV_DIR is .pi/scrapling-venv", () => {
		assert.equal(VENV_DIR, ".pi/scrapling-venv");
	});
});

describe("ensureScraplingVenv — venv already set up", () => {
	it("(entity) returns python path when scrapling already installed", async () => {
		const { cwd, exec } = setup();

		exec.mock.mockImplementation(
			async (cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && _args[0] === "-c") {
					return { code: 0, stdout: "ok", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result !== null, "should return python path");
		assert.ok(result!.includes("venv/bin/python3"), "path should end with python3");
	});

	it("(entity) does not create venv when scrapling already present", async () => {
		const { cwd, exec } = setup();
		const callLog: Array<{ cmd: string; args: string[] }> = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				callLog.push({ cmd, args });
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 0, stdout: "ok", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		await ensureScraplingVenv(exec, cwd);

		const venvCreationCalls = callLog.filter(
			(c) => c.cmd === "python3" && c.args.includes("-m") && c.args.includes("venv"),
		);
		assert.equal(venvCreationCalls.length, 0, "should not call python3 -m venv");
	});

	it("(entity) returns python path when lock file exists (parallel process creating venv)", async () => {
		const { cwd, exec } = setup();

		// Create lock file to simulate parallel venv creation
		const lockFilePath = path.join(cwd, ".pi", ".scrapling-venv.lock");
		fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
		fs.writeFileSync(lockFilePath, "locked");

		exec.mock.mockImplementation(
			async (cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && _args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureScraplingVenv(exec, cwd);
		// When lock file exists, we wait and then return the python path
		assert.ok(result !== null, "should still return python path even with lock file");
		assert.ok(result!.includes("venv/bin/python3"), "path should end with python3");
	});
});

describe("ensureScraplingVenv — venv creation", () => {
	it("(entity) creates virtual environment from scratch", async () => {
		const { cwd, exec } = setup();
		const callLog: Array<{ cmd: string; args: string[] }> = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				callLog.push({ cmd, args });
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
					// Simulate venv creation
					const venvPath = args[2];
					fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
					fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd === "rm") {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result !== null, "should return python path after creating venv");

		const venvCreationCalls = callLog.filter(
			(c) => c.cmd === "python3" && c.args.includes("-m") && c.args.includes("venv"),
		);
		assert.equal(venvCreationCalls.length, 1, "should call python3 -m venv once");
	});

	it("(entity) installs scrapling[fetchers], markdownify, and beautifulsoup4", async () => {
		const { cwd, exec } = setup();
		const pipCalls: string[] = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
					const venvPath = args[2];
					fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
					fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
					pipCalls.push(args.slice(2).join(" "));
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		await ensureScraplingVenv(exec, cwd);

		const combinedPip = pipCalls.join(" ");
		assert.ok(combinedPip.includes("scrapling[fetchers]"), "should install scrapling[fetchers]");
		assert.ok(combinedPip.includes("markdownify"), "should install markdownify");
		assert.ok(combinedPip.includes("beautifulsoup4"), "should install beautifulsoup4");
	});

	it("(entity) runs scrapling.cli install after pip install", async () => {
		const { cwd, exec } = setup();
		const postInstallCalls: string[] = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
					const venvPath = args[2];
					fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
					fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "scrapling.cli") {
					postInstallCalls.push(args.join(" "));
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		await ensureScraplingVenv(exec, cwd);
		assert.ok(postInstallCalls.length > 0, "should call scrapling.cli install");
		assert.ok(
			postInstallCalls.some((c) => c.includes("install")),
			"scrapling.cli should be called with install",
		);
	});

	it("(entity) creates and removes lock file during venv setup", async () => {
		const { cwd, exec } = setup();

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
					const venvPath = args[2];
					fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
					fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "scrapling.cli") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd === "rm") {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

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
		const { cwd, exec } = setup();

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
					return { code: 1, stdout: "", stderr: "pip install failed" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureScraplingVenv(exec, cwd);
		assert.equal(result, null, "should return null when pip fails");
	});

	it("(entity) returns null when venv creation fails", async () => {
		const { cwd, exec } = setup();

		exec.mock.mockImplementation(
			async (cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && _args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && _args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && _args.includes("-m") && _args.includes("venv")) {
					return { code: 1, stdout: "", stderr: "venv creation failed" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureScraplingVenv(exec, cwd);
		assert.equal(result, null, "should return null when venv creation fails");
	});
});

describe("ensureScraplingVenv — lock file race condition prevention", () => {
	it("(entity) lock file is created before pip install and removed after", async () => {
		const { cwd, exec } = setup();
		const lockFilePath = path.join(cwd, ".pi", ".scrapling-venv.lock");
		let lockExistedDuringPip = false;

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
					const venvPath = args[2];
					fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
					fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
					lockExistedDuringPip = fs.existsSync(lockFilePath);
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "scrapling.cli") {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd === "rm") {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureScraplingVenv(exec, cwd);
		assert.ok(result !== null, "should succeed");
		assert.ok(lockExistedDuringPip, "lock file should exist during pip install");
	});

	it("(entity) removes lock file even if pip install fails", async () => {
		const { cwd, exec } = setup();
		const lockFilePath = path.join(cwd, ".pi", ".scrapling-venv.lock");

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: Record<string, unknown>) => {
				if (cmd.includes("venv/bin/python3") && args[0] === "-c") {
					return { code: 1, stdout: "", stderr: "import failed" };
				}
				if (cmd === "python3" && args[0] === "--version") {
					return { code: 0, stdout: "Python 3.12.0", stderr: "" };
				}
				if (cmd === "python3" && args[0] === "-m" && args[1] === "venv") {
					const venvPath = args[2];
					fs.mkdirSync(path.join(venvPath, "bin"), { recursive: true });
					fs.writeFileSync(path.join(venvPath, "bin", "python3"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (cmd.includes("venv/bin/python3") && args[0] === "-m" && args[1] === "pip") {
					return { code: 1, stdout: "", stderr: "pip failed" };
				}
				if (cmd === "rm") {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureScraplingVenv(exec, cwd);
		assert.equal(result, null, "should return null on failure");
		assert.ok(!fs.existsSync(lockFilePath), "lock should be removed even after failure");
	});
});
