/**
 * Tests for venv-setup.ts — cache retry, apt package fallback
 *
 * Layer: (D) Domain/Unit — ExecFn mock, temp fs, no real deps/sudo/network.
 * Fast, no infra needed.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExecResult, ExecFn } from "../types.ts";
import { ensureChromiumDeps, VENV_RETRY_TTL_MS, VENV_RETRY_MAX } from "../venv-setup.ts";
import { shSingleQuote } from "../executor.ts";

type ExecHandler = ExecFn;

function makeMockExec(handler: ExecHandler) {
	return mock.fn(handler) as ReturnType<typeof mock.fn<ExecHandler>> & {
		calls: Array<{ arguments: [string, string[]] }>;
	};
}

describe("VENV_RETRY constants (Bug 4)", () => {
	it("(D) VENV_RETRY_TTL_MS === 30000", () => {
		assert.equal(VENV_RETRY_TTL_MS, 30000);
	});

	it("(D) VENV_RETRY_MAX === 3", () => {
		assert.equal(VENV_RETRY_MAX, 3);
	});
});

describe("ensureChromiumDeps — retry cache (Bug 4)", () => {
	/**
	 * Helper: create a temp cwd with .pi/chromium-deps optionally pre-created.
	 */
	function setup(options: { preCreateDepsDir?: boolean } = {}): {
		cwd: string;
		exec: ReturnType<typeof mock.fn<ExecHandler>>;
		depsReady: Map<string, { ready: boolean; timestamp: number; retries: number }>;
		DEPS_DIR: string;
		DEPS_LIB_DIR: string;
	} {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crawl4ai-test-"));
		const DEPS_DIR = path.join(cwd, ".pi", "chromium-deps");
		const DEPS_LIB_DIR = path.join(DEPS_DIR, "usr", "lib", "x86_64-linux-gnu");
		const depsReady = new Map<string, { ready: boolean; timestamp: number; retries: number }>();

		if (options.preCreateDepsDir) {
			fs.mkdirSync(DEPS_DIR, { recursive: true });
		}

		const exec = makeMockExec(async (_cmd: string, _args: string[]) => {
			return { code: 1, stdout: "", stderr: "mock: not mocked" };
		});

		return { cwd, exec, depsReady, DEPS_DIR, DEPS_LIB_DIR };
	}

	// ── Test 1: Fresh system ──

	it("(D) fresh system — calls mkdir -p DEPS_DIR before download loop", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup();

		const callLog: Array<{ cmd: string; args: string[] }> = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				callLog.push({ cmd, args });
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					fs.mkdirSync(args[args.length - 1], { recursive: true });
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

		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir" && c.args.includes("-p"));
		assert.equal(mkdirCalls.length, 1, "mkdir -p should be called once");
		assert.equal(
			mkdirCalls[0].args[mkdirCalls[0].args.length - 1],
			DEPS_DIR,
			"mkdir should target DEPS_DIR",
		);
		assert.equal(fs.existsSync(DEPS_DIR), true, "DEPS_DIR should exist");
		assert.equal(result, null, "should return null when no deps can be downloaded");
	});

	// ── Test 2: DEPS_DIR already exists ──

	it("(D) DEPS_DIR already exists — mkdir -p is idempotent", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup({ preCreateDepsDir: true });

		const callLog: Array<{ cmd: string; args: string[] }> = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
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

		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir" && c.args.includes("-p"));
		assert.equal(mkdirCalls.length, 1, "mkdir -p should still be called");
		assert.equal(fs.existsSync(DEPS_DIR), true, "DEPS_DIR should exist");
		assert.equal(result, null, "should return null when no deps");
	});

	// ── Test 3: Dependencies already extracted ──

	it("(D) deps already extracted — returns DEPS_LIB_DIR immediately", async () => {
		const { cwd, exec, depsReady, DEPS_LIB_DIR } = setup();

		fs.mkdirSync(DEPS_LIB_DIR, { recursive: true });
		fs.writeFileSync(path.join(DEPS_LIB_DIR, "libnspr4.so"), "");

		const callLog: Array<{ cmd: string; args: string[] }> = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				callLog.push({ cmd, args });
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		assert.equal(result, DEPS_LIB_DIR, "should return DEPS_LIB_DIR");
		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir");
		assert.equal(mkdirCalls.length, 0, "no mkdir calls when deps already exist");
	});

	// ── Test 4: depsReady cache hit (new shape) ──

	it("(D) depsReady cache hit — returns cached DEPS_LIB_DIR, zero exec calls", async () => {
		const { cwd, exec, DEPS_LIB_DIR } = setup();
		const depsReady = new Map<string, { ready: boolean; timestamp: number; retries: number }>();
		depsReady.set(cwd, { ready: true, timestamp: Date.now(), retries: 0 });

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		assert.equal(result, DEPS_LIB_DIR, "should return cached DEPS_LIB_DIR");
		assert.equal(exec.mock.calls.length, 0, "zero exec calls on cache hit");
	});

	// ── Test 5: All downloads fail ──

	it("(D) all downloads fail — returns null, logs errors", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup();

		const errorCalls: string[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => {
			errorCalls.push(args.join(" "));
		};

		try {
			exec.mock.mockImplementation(
				async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
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
			// With 3 package groups all failing, each group logs 2 messages
			// (per-package failure + per-group summary)
			const failedLogs = errorCalls.filter((c) => c.includes("failed to download"));
			assert.ok(failedLogs.length >= 3, "should log at least 3 download failure messages");
			assert.equal(fs.existsSync(DEPS_DIR), true, "DEPS_DIR should exist");
		} finally {
			console.error = origError;
		}
	});

	// ── Test 6: Partial download success ──

	it("(D) partial download success — extracts any debs, returns null if verify fails", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup();

		const callLog: Array<{ cmd: string; args: string[] }> = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
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
					if (fullCmd.includes("libnspr4")) {
						fs.writeFileSync(path.join(DEPS_DIR, "libnspr4.deb"), "fake");
						return { code: 0, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("libnss3")) {
						return { code: 1, stdout: "", stderr: "mock: failed" };
					}
					if (fullCmd.includes("libasound2")) {
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

		assert.equal(result, null, "should return null if verify step fails");
		const mkdirCalls = callLog.filter((c) => c.cmd === "mkdir" && c.args.includes("-p"));
		assert.equal(mkdirCalls.length, 1, "mkdir -p should be called");
	});

	// ── Test 7: Full success path ──

	it("(D) full success path — returns DEPS_LIB_DIR", async () => {
		const { cwd, exec, depsReady, DEPS_DIR, DEPS_LIB_DIR } = setup();

		// Track calls to test -f to return different results on first vs second call
		let testLibCallCount = 0;

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					testLibCallCount++;
					// first call (libCheck): return 1 (not found)
					// second call (verify after extraction): return 0 (found)
					return testLibCallCount === 1
						? { code: 1, stdout: "", stderr: "" }
						: { code: 0, stdout: "", stderr: "" };
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
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
		assert.equal(result, DEPS_LIB_DIR, "should return DEPS_LIB_DIR on success");
	});

	// ── Test 8: Cache miss then success (new shape) ──

	it("(D) depsReady cache miss then success — sets ready map, subsequent call returns cached", async () => {
		const { cwd, exec, DEPS_DIR, DEPS_LIB_DIR } = setup();
		const depsReady = new Map<string, { ready: boolean; timestamp: number; retries: number }>();
		let extracted = false;

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					if (extracted) return { code: 0, stdout: "", stderr: "" };
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
		const entry = depsReady.get(cwd);
		assert.ok(entry, "depsReady should have entry for cwd");
		assert.equal(entry!.ready, true, "entry.ready should be true after success");

		exec.mock.resetCalls();

		// Second call — should use cache
		const result2 = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
		assert.equal(result2, DEPS_LIB_DIR, "second call should return cached DEPS_LIB_DIR");
		assert.equal(exec.mock.calls.length, 0, "zero exec calls on cache hit");
	});

	// ── Test 9: Cache miss on first failure ──

	it("(D) cache miss on first failure — stores entry with ready:false, returns null", async () => {
		const { cwd, exec, DEPS_DIR } = setup();
		const depsReady = new Map<string, { ready: boolean; timestamp: number; retries: number }>();

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					fs.mkdirSync(DEPS_DIR, { recursive: true });
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					return { code: 1, stdout: "", stderr: "mock: failed" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
		assert.equal(result, null, "should return null on failure");

		const entry = depsReady.get(cwd);
		assert.ok(entry, "should have cache entry after failure");
		assert.equal(entry!.ready, false, "entry.ready should be false");
		assert.equal(typeof entry!.timestamp, "number", "entry.timestamp should be number");
		assert.equal(entry!.retries, 0, "entry.retries should be 0 on first failure");
	});

	// ── Test 10: Retry after TTL expiry ──

	it("(D) retry after 30s TTL — treated as miss, re-executes setup", async () => {
		const { cwd, exec, DEPS_DIR, DEPS_LIB_DIR } = setup();
		const depsReady = new Map<string, { ready: boolean; timestamp: number; retries: number }>();

		// Pre-populate with stale failure (60s old, 1 retry)
		const oldTimestamp = Date.now() - 60_000;
		depsReady.set(cwd, { ready: false, timestamp: oldTimestamp, retries: 1 });

		let execCount = 0;
		let testLibCallCount = 0;

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				execCount++;
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					testLibCallCount++;
					// first call: not found; second: found after extraction
					return testLibCallCount === 1
						? { code: 1, stdout: "", stderr: "" }
						: { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					fs.mkdirSync(DEPS_DIR, { recursive: true });
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					// Succeed this time
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
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
		assert.equal(result, DEPS_LIB_DIR, "should retry and succeed after TTL expiry");
		assert.ok(execCount > 0, "exec should be called (cache miss)");

		const entry = depsReady.get(cwd);
		assert.ok(entry, "should have cache entry");
		assert.equal(entry!.ready, true, "entry.ready should be true after successful retry");
	});

	// ── Test 11: Max retries exhausted ──

	it("(D) max 3 retries exhausted — returns null immediately without exec", async () => {
		const { cwd, exec, depsReady } = setup();

		// Pre-populate with max retries exhausted
		depsReady.set(cwd, { ready: false, timestamp: Date.now() - 60_000, retries: 3 });

		exec.mock.mockImplementation(
			async (_cmd: string, _args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				return { code: 0, stdout: "should not be called", stderr: "" };
			},
		);

		const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
		assert.equal(result, null, "should return null when max retries exhausted");
		assert.equal(exec.mock.calls.length, 0, "zero exec calls when retries exhausted");
	});
});

describe("ensureChromiumDeps — apt package fallback (Bug 5)", () => {
	function setup(): {
		cwd: string;
		exec: ReturnType<typeof mock.fn<ExecHandler>>;
		depsReady: Map<string, { ready: boolean; timestamp: number; retries: number }>;
		DEPS_DIR: string;
		DEPS_LIB_DIR: string;
	} {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crawl4ai-test-"));
		const DEPS_DIR = path.join(cwd, ".pi", "chromium-deps");
		const DEPS_LIB_DIR = path.join(DEPS_DIR, "usr", "lib", "x86_64-linux-gnu");
		const depsReady = new Map<string, { ready: boolean; timestamp: number; retries: number }>();
		const exec = makeMockExec(async () => ({ code: 1, stdout: "", stderr: "mock" }));
		return { cwd, exec, depsReady, DEPS_DIR, DEPS_LIB_DIR };
	}

	it("(D) primary package name succeeds — uses libasound2t64, never tries libasound2", async () => {
		const { cwd, exec, depsReady, DEPS_DIR, DEPS_LIB_DIR } = setup();
		const aptCalls: string[] = [];

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				const fullCmd = cmd + " " + args.join(" ");
				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					fs.mkdirSync(DEPS_DIR, { recursive: true });
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					const pkg = fullCmd.split("apt-get download ")[1];
					aptCalls.push(pkg);
					fs.writeFileSync(path.join(DEPS_DIR, `${pkg}.deb`), "fake");
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					const debs = fs.readdirSync(DEPS_DIR).filter((f) => f.endsWith(".deb"));
					return { code: debs.length > 0 ? 0 : 1, stdout: debs.join("\n"), stderr: "" };
				}
				if (fullCmd.includes("dpkg") && fullCmd.includes("-x")) {
					fs.mkdirSync(DEPS_LIB_DIR, { recursive: true });
					fs.writeFileSync(path.join(DEPS_LIB_DIR, "libnspr4.so"), "");
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		// Verify libasound2t64 was tried, but not libasound2
		const asoundCalls = aptCalls.filter((p) => p.startsWith("libasound2"));
		assert.ok(asoundCalls.length >= 1, "should try libasound2t64");
		assert.ok(asoundCalls.includes("libasound2t64"), "should try libasound2t64 first");
		assert.ok(!asoundCalls.includes("libasound2"), "should NOT try libasound2 fallback");
	});

	it("(D) primary package fails, fallback succeeds — tries libasound2 after libasound2t64 fails", async () => {
		const { cwd, exec, depsReady, DEPS_DIR, DEPS_LIB_DIR } = setup();
		const aptCalls: string[] = [];
		const warnCalls: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnCalls.push(args.join(" "));
		};

		try {
			exec.mock.mockImplementation(
				async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
					const fullCmd = cmd + " " + args.join(" ");
					if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
						return { code: 1, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
						fs.mkdirSync(DEPS_DIR, { recursive: true });
						return { code: 0, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("apt-get download")) {
						const pkg = fullCmd.split("apt-get download ")[1];
						aptCalls.push(pkg);
						if (pkg === "libasound2t64") {
							return { code: 1, stdout: "", stderr: "mock: package not found" };
						}
						if (pkg === "libasound2") {
							fs.writeFileSync(path.join(DEPS_DIR, `${pkg}.deb`), "fake");
							return { code: 0, stdout: "", stderr: "" };
						}
						fs.writeFileSync(path.join(DEPS_DIR, `${pkg}.deb`), "fake");
						return { code: 0, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
						const debs = fs.readdirSync(DEPS_DIR).filter((f) => f.endsWith(".deb"));
						return { code: debs.length > 0 ? 0 : 1, stdout: debs.join("\n"), stderr: "" };
					}
					if (fullCmd.includes("dpkg") && fullCmd.includes("-x")) {
						fs.mkdirSync(DEPS_LIB_DIR, { recursive: true });
						fs.writeFileSync(path.join(DEPS_LIB_DIR, "libnspr4.so"), "");
						return { code: 0, stdout: "", stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "mock: unhandled" };
				},
			);

			await ensureChromiumDeps(exec, cwd, undefined, depsReady);

			// Verify both names were tried
			assert.ok(aptCalls.includes("libasound2t64"), "should try libasound2t64 first");
			assert.ok(aptCalls.includes("libasound2"), "should try libasound2 as fallback");
			assert.ok(
				warnCalls.some((c) => c.includes("libasound2")),
				"should warn about fallback",
			);
		} finally {
			console.warn = origWarn;
		}
	});

	it("(D) both package names fail — logs error, continues to next group", async () => {
		const { cwd, exec, depsReady, DEPS_DIR } = setup();
		const aptCalls: string[] = [];
		const errorCalls: string[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => {
			errorCalls.push(args.join(" "));
		};

		try {
			exec.mock.mockImplementation(
				async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
					const fullCmd = cmd + " " + args.join(" ");
					if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
						return { code: 1, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
						fs.mkdirSync(DEPS_DIR, { recursive: true });
						return { code: 0, stdout: "", stderr: "" };
					}
					if (fullCmd.includes("apt-get download")) {
						const pkg = fullCmd.split("apt-get download ")[1];
						aptCalls.push(pkg);
						return { code: 1, stdout: "", stderr: `mock: ${pkg} not found` };
					}
					if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
						return { code: 1, stdout: "", stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "mock: unhandled" };
				},
			);

			const result = await ensureChromiumDeps(exec, cwd, undefined, depsReady);
			assert.equal(result, null, "should return null when all packages fail");
			assert.ok(aptCalls.includes("libasound2t64"), "should try libasound2t64");
			assert.ok(aptCalls.includes("libasound2"), "should try libasound2 fallback");
			assert.ok(
				errorCalls.some((c) => c.includes("failed to download")),
				"should log error messages",
			);
		} finally {
			console.error = origError;
		}
	});
});

describe("ensureChromiumDeps — shell path quoting (Bug 602)", () => {
	function setupWithCwd(
		customCwd: string,
		returnSuccessForFirstCheck?: boolean,
	): {
		cwd: string;
		exec: ReturnType<typeof mock.fn<ExecHandler>>;
		depsReady: Map<string, { ready: boolean; timestamp: number; retries: number }>;
		bashCalls: Array<{ cmd: string; args: string[] }>;
	} {
		const depsReady = new Map<string, { ready: boolean; timestamp: number; retries: number }>();
		const bashCalls: Array<{ cmd: string; args: string[] }> = [];
		let firstLibCheckDone = false;

		const exec = makeMockExec(async (_cmd: string, _args: string[]) => {
			return { code: 1, stdout: "", stderr: "mock: not mocked" };
		});

		exec.mock.mockImplementation(
			async (cmd: string, args: string[], _opts?: { timeout?: number; signal?: AbortSignal }) => {
				const fullCmd = cmd + " " + args.join(" ");

				// Capture all bash -c calls
				if (cmd === "bash" && args[0] === "-c") {
					bashCalls.push({ cmd, args });
				}

				if (fullCmd.includes("test -f") && fullCmd.includes("libnspr4.so")) {
					if (returnSuccessForFirstCheck && !firstLibCheckDone) {
						firstLibCheckDone = true;
						return { code: 0, stdout: "", stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("mkdir") && fullCmd.includes("-p")) {
					const dir = args[args.length - 1];
					try {
						fs.mkdirSync(dir, { recursive: true });
					} catch {
						// ignore
					}
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("apt-get download")) {
					const pkg = fullCmd.split("apt-get download ")[1];
					const dirMatch = fullCmd.match(/cd ([^&]+) &&/);
					if (dirMatch) {
						const dirPath = dirMatch[1].replace(/^'/, "").replace(/'$/, "");
						const debPath = path.join(dirPath, `${pkg}.deb`);
						try {
							fs.writeFileSync(debPath, "fake");
						} catch {
							// ignore
						}
					}
					return { code: 0, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("ls") && fullCmd.includes("*.deb")) {
					const lsArg = args[1];
					const debMatch = lsArg.match(/ls (.+?)\/\*\.deb/);
					if (debMatch) {
						const cleanPath = debMatch[1].replace(/^'/, "").replace(/'$/, "");
						try {
							const debs = fs.readdirSync(cleanPath).filter((f) => f.endsWith(".deb"));
							return {
								code: debs.length > 0 ? 0 : 1,
								stdout: debs.join("\n"),
								stderr: "",
							};
						} catch {
							return { code: 1, stdout: "", stderr: "" };
						}
					}
					return { code: 1, stdout: "", stderr: "" };
				}
				if (fullCmd.includes("dpkg") && fullCmd.includes("-x")) {
					try {
						const depsDir = args[args.length - 1];
						fs.mkdirSync(path.join(depsDir, "usr", "lib", "x86_64-linux-gnu"), { recursive: true });
						fs.writeFileSync(
							path.join(depsDir, "usr", "lib", "x86_64-linux-gnu", "libnspr4.so"),
							"",
						);
					} catch {
						// ignore
					}
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "mock: unhandled" };
			},
		);

		return { cwd: customCwd, exec, depsReady, bashCalls };
	}

	it("(D) shSingleQuote imported — libCheck command wraps testLib path in single quotes", async () => {
		const cwdWithSpace = "/tmp/my project";
		const { cwd, exec, depsReady, bashCalls } = setupWithCwd(cwdWithSpace);

		await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		const libCheckCall = bashCalls.find((c) => c.args[1].includes("test -f"));
		assert.ok(libCheckCall, "should have a bash -c call with test -f");

		const bashCmd = libCheckCall!.args[1];
		assert.ok(
			bashCmd.includes("'/tmp/my project/.pi/chromium-deps"),
			`libCheck command should have quoted path with spaces, got: ${bashCmd}`,
		);
	});

	it("(D) download command wraps DEPS_DIR in single quotes", async () => {
		const cwdWithSpace = "/tmp/my project";
		const { cwd, exec, depsReady, bashCalls } = setupWithCwd(cwdWithSpace);

		await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		const dlCall = bashCalls.find((c) => c.args[1].includes("apt-get download"));
		assert.ok(dlCall, "should have a bash -c call with apt-get download");

		const bashCmd = dlCall!.args[1];
		assert.ok(
			bashCmd.includes("'/tmp/my project/.pi/chromium-deps'"),
			`download command should have quoted DEPS_DIR in cd, got: ${bashCmd}`,
		);
	});

	it("(D) findResult command wraps DEPS_DIR in single quotes", async () => {
		const cwdWithSpace = "/tmp/my project";
		const { cwd, exec, depsReady, bashCalls } = setupWithCwd(cwdWithSpace);

		await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		const lsCall = bashCalls.find((c) => c.args[1].includes("ls ") && c.args[1].includes("*.deb"));
		assert.ok(lsCall, "should have a bash -c call with ls *.deb");

		const bashCmd = lsCall!.args[1];
		assert.ok(
			bashCmd.includes("'/tmp/my project/.pi/chromium-deps'"),
			`ls command should have quoted DEPS_DIR, got: ${bashCmd}`,
		);
	});

	it("(D) verify command wraps testLib path in single quotes", async () => {
		const cwdWithSpace = "/tmp/my project";
		// Use returnSuccessForFirstCheck=true so libCheck succeeds immediately
		// and the verify path is also tested on the same test-f call
		const { cwd, exec, depsReady, bashCalls } = setupWithCwd(cwdWithSpace, true);

		await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		// When libCheck returns 0 (already extracted), there should still
		// be a test -f call (the libCheck itself)
		const testCall = bashCalls.find((c) => c.args[1].includes("test -f"));
		assert.ok(testCall, "should have a bash -c call with test -f");

		const bashCmd = testCall!.args[1];
		assert.ok(
			bashCmd.includes("'/tmp/my project/.pi/chromium-deps"),
			`verify command should have quoted testLib path, got: ${bashCmd}`,
		);
	});

	it("(D) path with embedded single quote uses proper bash escaping", async () => {
		const cwdWithQuote = "/tmp/it's project";
		const { cwd, exec, depsReady, bashCalls } = setupWithCwd(cwdWithQuote);

		await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		const testCall = bashCalls.find((c) => c.args[1].includes("test -f"));
		assert.ok(testCall, "should have test -f bash call");

		const bashCmd = testCall!.args[1];
		// Should use shSingleQuote escape pattern (embedded ' => '\\'')
		// The bash-safe pattern for embedding ' inside single quotes is:
		//   '...'\\''...'  (close quote, escaped quote, open quote)
		assert.ok(
			bashCmd.includes("\\'"),
			`bash command should have escaped single quote (backslash-quote), got: ${bashCmd}`,
		);
		// Verify the path appears properly escaped using shSingleQuote pattern
		// Pattern: '/tmp/it'\\''s project/.pi/chromium-deps/...'
		assert.ok(
			bashCmd.includes("'/tmp/it") && bashCmd.includes("s project"),
			`bash command should contain quoted path fragments around the escape, got: ${bashCmd}`,
		);
		// The raw path with unescaped quote should NOT appear
		assert.ok(
			!bashCmd.includes("it's project"),
			"raw unescaped path with single quote should NOT appear in bash command",
		);
	});

	it("(D) cwd with leading hyphen does not break commands", async () => {
		const cwdWithHyphen = "/tmp/-test project";
		const { cwd, exec, depsReady, bashCalls } = setupWithCwd(cwdWithHyphen);

		await ensureChromiumDeps(exec, cwd, undefined, depsReady);

		const dlCall = bashCalls.find((c) => c.args[1].includes("apt-get download"));
		assert.ok(dlCall, "should have apt-get download bash call");

		const bashCmd = dlCall!.args[1];
		// The cd should have the leading-hyphen path properly quoted
		assert.ok(
			bashCmd.includes("'/tmp/-test project/.pi/chromium-deps'"),
			`cd command should have quoted DEPS_DIR, got: ${bashCmd}`,
		);
	});
});
