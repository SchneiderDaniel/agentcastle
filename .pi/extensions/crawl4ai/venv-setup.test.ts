/**
 * Tests for ensureChromiumDeps — mkdir -p fix
 *
 * Layer: (D) Domain/Unit — ExecFn mock, temp fs, no real deps/sudo/network.
 * Fast, no infra needed.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureChromiumDeps } from "./venv-setup.ts";

interface ExecCall {
	cmd: string;
	args: string[];
}

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

type ExecHandler = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number; signal?: AbortSignal },
) => ExecResult;

function makeMockExec(handler: ExecHandler) {
	return mock.fn(handler) as ReturnType<typeof mock.fn<ExecHandler>> & {
		calls: Array<{ arguments: [string, string[]] }>;
	};
}

describe("ensureChromiumDeps — mkdir-p fix", () => {
	/**
	 * Helper: create a temp cwd with .pi/chromium-deps optionally pre-created.
	 */
	function setup(options: { preCreateDepsDir?: boolean } = {}): {
		cwd: string;
		exec: ReturnType<typeof mock.fn<ExecHandler>>;
		depsReady: Map<string, boolean>;
		updateCalls: string[];
		DEPS_DIR: string;
		DEPS_LIB_DIR: string;
	} {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crawl4ai-test-"));
		const DEPS_DIR = path.join(cwd, ".pi", "chromium-deps");
		const DEPS_LIB_DIR = path.join(DEPS_DIR, "usr", "lib", "x86_64-linux-gnu");
		const depsReady = new Map<string, boolean>();
		const updateCalls: string[] = [];

		if (options.preCreateDepsDir) {
			fs.mkdirSync(DEPS_DIR, { recursive: true });
		}

		const exec = makeMockExec((_cmd: string, _args: string[]) => {
			// Default: fail everything — tests override per scenario
			return { code: 1, stdout: "", stderr: "mock: not mocked" };
		});

		return { cwd, exec, depsReady, updateCalls, DEPS_DIR, DEPS_LIB_DIR };
	}

	// ── Test 1: Fresh system — mkdir -p called before download loop ──

	it("(D) fresh system — calls mkdir -p DEPS_DIR before download loop", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup();

		// We'll record all exec calls; we need to handle them in order.
		// The function calls:
		//   1. test -f libnspr4.so  → fail (not extracted yet)
		//   2. mkdir -p DEPS_DIR    → should succeed (this is what we test)
		//   3. apt-get download pkg1 → fail (no apt)
		//   4. apt-get download pkg2 → fail
		//   5. apt-get download pkg3 → fail
		//   6. ls *.deb             → fail (no debs)
		//   7. test -f libnspr4.so  → fail → return null
		const callLog: ExecCall[] = [];
		const testLib = `${DEPS_DIR}/usr/lib/x86_64-linux-gnu/libnspr4.so`;

		exec.mock.mockImplementation(
			(cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				callLog.push({ cmd, args });
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					// Simulate mkdir by actually creating the dir
					const dirArg = args[args.length - 1];
					fs.mkdirSync(dirArg, { recursive: true });
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					return { code: 1, stdout: "", stderr: "mock: no apt" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		// Verify mkdir -p was called
		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir" && c.args.includes("-p"));
		assert.equal(mkdirCalls.length, 1, "mkdir -p should be called once");
		assert.equal(
			mkdirCalls[0].args[mkdirCalls[0].args.length - 1],
			DEPS_DIR,
			"mkdir should target DEPS_DIR",
		);

		// Verify DEPS_DIR exists on filesystem
		assert.equal(
			fs.existsSync(DEPS_DIR),
			true,
			"DEPS_DIR should exist on filesystem after ensureChromiumDeps",
		);

		// Function returns null because no deps were downloaded
		assert.equal(result, null, "should return null when no deps can be downloaded");
	});

	// ── Test 2: DEPS_DIR already exists — mkdir -p is idempotent ──

	it("(D) DEPS_DIR already exists — mkdir -p is idempotent (no error)", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup({ preCreateDepsDir: true });

		const callLog: ExecCall[] = [];

		exec.mock.mockImplementation(
			(cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				callLog.push({ cmd, args });
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					return { code: 1, stdout: "", stderr: "mock: no apt" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		// mkdir -p should still be called (it's idempotent)
		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir" && c.args.includes("-p"));
		assert.equal(mkdirCalls.length, 1, "mkdir -p should still be called even if dir exists");

		// DEPS_DIR should still exist
		assert.equal(fs.existsSync(DEPS_DIR), true, "DEPS_DIR should exist");

		// Function returns null because no deps
		assert.equal(result, null, "should return null when no deps");
	});

	// ── Test 3: Dependencies already extracted → returns immediately ──

	it("(D) deps already extracted — returns DEPS_LIB_DIR immediately, no mkdir/download", async () => {
		const { cwd, exec, depsReady, DEPS_LIB_DIR } = setup();

		// Create the test lib file to simulate existing deps
		fs.mkdirSync(DEPS_LIB_DIR, { recursive: true });
		fs.writeFileSync(path.join(DEPS_LIB_DIR, "libnspr4.so"), "");

		const callLog: ExecCall[] = [];

		exec.mock.mockImplementation(
			(cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				callLog.push({ cmd, args });
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		// Should return DEPS_LIB_DIR immediately
		assert.equal(result, DEPS_LIB_DIR, "should return DEPS_LIB_DIR");

		// No mkdir or download calls
		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir");
		assert.equal(mkdirCalls.length, 0, "no mkdir calls when deps already exist");
		const downloadCalls = callLog.filter(
			(c) => c.cmd === "bash" && argsToString(c.args).includes("apt-get"),
		);
		assert.equal(downloadCalls.length, 0, "no download calls when deps already exist");
	});

	// ── Test 4: depsReady cache hit → returns cached value, zero exec calls ──

	it("(D) depsReady cache hit — returns cached DEPS_LIB_DIR, zero exec calls", async () => {
		const { cwd, exec, DEPS_LIB_DIR } = setup();
		const depsReady = new Map<string, boolean>();
		depsReady.set(cwd, true);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		assert.equal(result, DEPS_LIB_DIR, "should return cached DEPS_LIB_DIR");
		assert.equal(exec.mock.calls.length, 0, "zero exec calls on cache hit");
	});

	// ── Test 5: All downloads fail → returns null ──

	it("(D) all downloads fail — returns null, logs errors", async () => {
		const { cwd, exec, depsReady, DEPS_DIR, DEPS_LIB_DIR } = setup();

		// Capture console.error output
		const errorCalls: string[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => {
			errorCalls.push(args.join(" "));
		};

		try {
			exec.mock.mockImplementation(
				(cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
					const fullCmd = cmd + " " + args.join(" ");
					if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
						return { code: 1, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
						fs.mkdirSync(DEPS_DIR, { recursive: true });
						return { code: 0, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("apt-get download")) {
						return { code: 1, stdout: "", stderr: "mock: apt-get failed" };
					}
					if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
						return { code: 1, stdout: "", stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "mock: unhandled" };
				},
			);

			const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

			assert.equal(result, null, "should return null when all downloads fail");

			// Should log error for each of the 3 packages
			const failedLogs = errorCalls.filter((c) => c.includes("failed to download"));
			assert.equal(failedLogs.length, 3, "should log 3 download failures");

			// DEPS_DIR should still exist (mkdir was called)
			assert.equal(fs.existsSync(DEPS_DIR), true, "DEPS_DIR should exist");
		} finally {
			console.error = origError;
		}
	});

	// ── Test 6: Partial download success → still returns null if verify fails ──

	it("(D) partial download success — extracts any debs, returns null if verify fails", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup();

		const callLog: ExecCall[] = [];

		exec.mock.mockImplementation(
			(cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				callLog.push({ cmd, args });
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					fs.mkdirSync(DEPS_DIR, { recursive: true });
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					// One pkg fails, two succeed
					if (fullCmd.includes("libnspr4")) {
						// Create a fake .deb file for this pkg
						fs.writeFileSync(path.join(DEPS_DIR, "libnspr4.deb"), "fake");
						return { code: 0, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("libnss3")) {
						return { code: 1, stdout: "", stderr: "mock: failed" };
					}
					if (fullCmd.includes("libasound2t64")) {
						fs.writeFileSync(path.join(DEPS_DIR, "libasound.deb"), "fake");
						return { code: 0, stdout: "", stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					return { code: 0, stdout: "libnspr4.deb\nlibasound.deb", stderr: "" };
				}
				if (fullCmd.includes("dpkg") && fullCmd.includes("-x")) {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		// Returns null because verify step (test -f libnspr4.so) fails (we extracted fake debs, no actual .so)
		assert.equal(result, null, "should return null if verify step fails");

		// mkdir was called
		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir" && c.args.includes("-p"));
		assert.equal(mkdirCalls.length, 1, "mkdir -p should be called");
	});

	// ── Test 7: Full success path ──

	it("(D) full success path — returns DEPS_LIB_DIR", async () => {
		const { cwd, exec, depsReady, DEPS_DIR, DEPS_LIB_DIR } = setup();

		const callLog: ExecCall[] = [];

		exec.mock.mockImplementation(
			(cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				callLog.push({ cmd, args });
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					// First call: lib not found; second call (verify): lib found
					if (callLog.filter((c) => c.cmd + " " + c.args.join(" ") === fullCmd).length === 1) {
						return { code: 1, stdout: "", stderr: "" };
					}
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					fs.mkdirSync(DEPS_DIR, { recursive: true });
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					// Create a .deb file for each pkg
					const pkgName = fullCmd.split("apt-get download ")[1];
					fs.writeFileSync(path.join(DEPS_DIR, `${pkgName}.deb`), "fake");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					const debs = fs.readdirSync(DEPS_DIR).filter((f) => f.endsWith(".deb"));
					return { code: debs.length > 0 ? 0 : 1, stdout: debs.join("\n"), stderr: "" };
				}
				if (fullCmd.includes("dpkg") && fullCmd.includes("-x")) {
					// Extract: create the test lib file to make verify pass
					fs.mkdirSync(DEPS_LIB_DIR, { recursive: true });
					fs.writeFileSync(path.join(DEPS_LIB_DIR, "libnspr4.so"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		assert.equal(result, DEPS_LIB_DIR, "should return DEPS_LIB_DIR on success");
		assert.equal(fs.existsSync(DEPS_DIR), true, "DEPS_DIR should exist");

		// mkdir -p was called
		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir" && c.args.includes("-p"));
		assert.equal(mkdirCalls.length, 1, "mkdir -p should be called");
	});

	// ── Test 8: depsReady cache miss then success ──

	it("(D) depsReady cache miss then success — sets ready map, subsequent call returns cached", async () => {
		const { cwd, exec, DEPS_DIR, DEPS_LIB_DIR } = setup();
		const depsReady = new Map<string, boolean>();

		// Track whether dpkg extraction has run (creates the .so file)
		let extracted = false;

		// First call setup: simulate success
		exec.mock.mockImplementation(
			(cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					// Use actual extraction state, not depsReady map
					if (extracted) {
						return { code: 0, stdout: "", stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					fs.mkdirSync(DEPS_DIR, { recursive: true });
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					const pkgName = fullCmd.split("apt-get download ")[1];
					fs.writeFileSync(path.join(DEPS_DIR, `${pkgName}.deb`), "fake");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					const debs = fs.readdirSync(DEPS_DIR).filter((f) => f.endsWith(".deb"));
					return { code: debs.length > 0 ? 0 : 1, stdout: debs.join("\n"), stderr: "" };
				}
				if (fullCmd.includes("dpkg") && fullCmd.includes("-x")) {
					fs.mkdirSync(DEPS_LIB_DIR, { recursive: true });
					fs.writeFileSync(path.join(DEPS_LIB_DIR, "libnspr4.so"), "");
					extracted = true;
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		// First call
		const result1 = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
		assert.equal(result1, DEPS_LIB_DIR, "first call should return DEPS_LIB_DIR");
		assert.equal(depsReady.get(cwd), true, "depsReady should have cwd=true after success");

		// Reset mock and call count for second call
		exec.mock.resetCalls();

		// Second call with same map — should use cache
		const result2 = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
		assert.equal(result2, DEPS_LIB_DIR, "second call should return cached DEPS_LIB_DIR");
		assert.equal(exec.mock.calls.length, 0, "zero exec calls on cache hit");
	});
});

/**
 * Helper: join args array into command string for matching.
 */
function argsToString(args: string[]): string {
	return args.join(" ");
}
