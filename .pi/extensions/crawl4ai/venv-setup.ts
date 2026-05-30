/**
 * Python virtual environment + Chromium system dependencies management.
 *
 * Adapts system/shell operations — pi.exec injected to keep functions
 * testable with mock exec. State Maps (venvReady, depsReady) passed in
 * to let caller own caching lifecycle.
 *
 * Cache entries carry retry metadata: failed setups retry after TTL expiry
 * up to max retries. This prevents permanent lockout without restart.
 */

import type { OnUpdateCallback } from "./types";

// ── Configurable constants ──

/** TTL before a failed venv/deps cache entry is eligible for retry (ms). */
export const VENV_RETRY_TTL_MS = 30_000;

/** Maximum retry attempts for failed venv/deps setup. */
export const VENV_RETRY_MAX = 3;

// ── Types ──

/** Cache entry for venv/deps ready state with retry metadata. */
export interface VenvCacheEntry {
	ready: boolean;
	timestamp: number;
	retries: number;
}

export type VenvCache = Map<string, VenvCacheEntry>;

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; signal?: AbortSignal },
	): Promise<ExecResult>;
}

function lazyPaths(cwd: string) {
	return {
		VENV_DIR: `${cwd}/.pi/crawl4ai-venv`,
		VENV_PYTHON: `${cwd}/.pi/crawl4ai-venv/bin/python3`,
		DEPS_DIR: `${cwd}/.pi/chromium-deps`,
		DEPS_LIB_DIR: `${cwd}/.pi/chromium-deps/usr/lib/x86_64-linux-gnu`,
	};
}

/**
 * Shell-safe single-quote escaping for bash -c argument interpolation.
 *
 * Wraps `s` in single quotes so that ALL characters except the single quote
 * are treated literally by bash. Embedded single quotes are escaped via the
 * `'\''` sequence (end quote, escaped quote, reopen quote).
 *
 * This is the same strategy used by executor.ts:shSingleQuote (issue #271 fix).
 */
export function shSingleQuote(s: string): string {
	// Replace each ' with '\'' then wrap in single quotes
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── Cache helpers ──

function cacheGet(
	cache: Map<string, VenvCacheEntry>,
	key: string,
): { entry: VenvCacheEntry | undefined; shouldRetry: boolean } {
	const entry = cache.get(key);
	if (!entry) return { entry: undefined, shouldRetry: false };
	if (entry.ready) return { entry, shouldRetry: false };
	// Failed entry: check if retry eligible
	if (entry.retries >= VENV_RETRY_MAX) return { entry, shouldRetry: false };
	if (Date.now() - entry.timestamp < VENV_RETRY_TTL_MS) return { entry, shouldRetry: false };
	return { entry, shouldRetry: true };
}

function cacheMarkSuccess(cache: Map<string, VenvCacheEntry>, key: string): void {
	cache.set(key, { ready: true, timestamp: Date.now(), retries: 0 });
}

function cacheMarkFailure(cache: Map<string, VenvCacheEntry>, key: string): void {
	const existing = cache.get(key);
	const retries = existing ? existing.retries + 1 : 0;
	cache.set(key, { ready: false, timestamp: Date.now(), retries });
}

/**
 * Ensure Python virtual env with crawl4ai installed exists.
 * Returns path to python3 binary or null if setup fails.
 */
export async function ensurePythonVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: OnUpdateCallback,
	venvReady?: VenvCache,
): Promise<string | null> {
	const ready = venvReady ?? new Map<string, VenvCacheEntry>();
	const { VENV_PYTHON, VENV_DIR } = lazyPaths(cwd);

	const { entry, shouldRetry } = cacheGet(ready, cwd);
	if (entry && !shouldRetry) return entry.ready ? VENV_PYTHON : null;

	// Check system python3 exists
	const pyCheck = await exec("python3", ["--version"]);
	if (pyCheck.code !== 0) {
		console.error("crawl4ai: python3 not found");
		cacheMarkFailure(ready, cwd);
		return null;
	}

	// Check if venv already set up with crawl4ai
	const alreadyOk = await exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
	if (alreadyOk.code === 0 && alreadyOk.stdout.includes("ok")) {
		cacheMarkSuccess(ready, cwd);
		return VENV_PYTHON;
	}

	// Create venv if it doesn't exist (or is broken)
	const venvCheck = await exec(VENV_PYTHON, ["--version"]);
	if (venvCheck.code !== 0) {
		// Clean up any broken partial venv first
		await exec("rm", ["-rf", VENV_DIR]);
		onUpdate?.({
			content: [{ type: "text", text: "Creating Python virtual environment for crawl4ai…" }],
			details: {} as Record<string, unknown>,
		});
		const create = await exec("python3", ["-m", "venv", "--clear", VENV_DIR]);
		if (create.code !== 0) {
			console.error("crawl4ai: failed to create venv");
			cacheMarkFailure(ready, cwd);
			return null;
		}
	}

	// Install crawl4ai in venv
	onUpdate?.({
		content: [{ type: "text", text: "Installing crawl4ai (this may take a minute)…" }],
		details: {} as Record<string, unknown>,
	});
	const install = await exec(VENV_PYTHON, ["-m", "pip", "install", "crawl4ai"], {
		timeout: 180_000,
	});
	if (install.code !== 0) {
		console.error("crawl4ai: pip install failed:", install.stderr.slice(0, 500));
		cacheMarkFailure(ready, cwd);
		return null;
	}

	// Install playwright browsers (best-effort)
	onUpdate?.({
		content: [{ type: "text", text: "Installing Chromium browser for crawl4ai…" }],
		details: {} as Record<string, unknown>,
	});
	await exec(VENV_PYTHON, ["-m", "playwright", "install", "chromium"], { timeout: 120_000 });

	// Verify
	const verify = await exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
	const readyFlag = verify.code === 0 && verify.stdout.includes("ok");
	if (readyFlag) {
		cacheMarkSuccess(ready, cwd);
		return VENV_PYTHON;
	}
	cacheMarkFailure(ready, cwd);
	return null;
}

/**
 * Ensure Chromium system dependencies are available.
 * Downloads and extracts .deb packages without sudo.
 * Returns path to lib directory or null if setup fails.
 *
 * Tries package names with fallback for distro version differences
 * (e.g., libasound2t64 on Debian 12+ / Ubuntu 24.04+ vs libasound2 on older).
 */
export async function ensureChromiumDeps(
	exec: ExecFn,
	cwd: string,
	onUpdate?: OnUpdateCallback,
	depsReady?: VenvCache,
): Promise<string | null> {
	const ready = depsReady ?? new Map<string, VenvCacheEntry>();
	const { DEPS_DIR, DEPS_LIB_DIR } = lazyPaths(cwd);

	const { entry, shouldRetry } = cacheGet(ready, cwd);
	if (entry && !shouldRetry) return entry.ready ? DEPS_LIB_DIR : null;

	// Check if deps already extracted and working
	const testLib = `${DEPS_LIB_DIR}/libnspr4.so`;
	const libCheck = await exec("bash", ["-c", `test -f ${shSingleQuote(testLib)}`]);
	if (libCheck.code === 0) {
		cacheMarkSuccess(ready, cwd);
		return DEPS_LIB_DIR;
	}

	// Create deps directory if it doesn't exist
	await exec("mkdir", ["-p", DEPS_DIR]);

	// Download and extract Chromium system dependencies (without sudo)
	onUpdate?.({
		content: [{ type: "text", text: "Downloading Chromium system libraries…" }],
		details: {} as Record<string, unknown>,
	});

	// Package groups with fallback names per group
	// libasound2t64 is Debian 12+ / Ubuntu 24.04+ naming; libasound2 for older distros
	const pkgGroups = [["libasound2t64", "libasound2"], ["libnspr4"], ["libnss3"]];

	for (const group of pkgGroups) {
		let downloaded = false;
		for (const pkg of group) {
			const dl = await exec(
				"bash",
				["-c", `cd ${shSingleQuote(DEPS_DIR)} && apt-get download ${pkg}`],
				{
					timeout: 30_000,
				},
			);
			if (dl.code === 0) {
				downloaded = true;
				if (pkg !== group[0]) {
					console.warn(`crawl4ai: using fallback package ${pkg} (${group[0]} not available)`);
				}
				break;
			}
			if (pkg === group[group.length - 1]) {
				console.error(`crawl4ai: failed to download ${group[0]} (and fallback if available)`);
			}
		}
		if (!downloaded) {
			console.error(`crawl4ai: failed to download any package in group ${group[0]}`);
		}
	}

	// Extract all debs
	const findResult = await exec("bash", ["-c", `ls ${shSingleQuote(DEPS_DIR)}/*.deb 2>/dev/null`]);
	if (findResult.code === 0 && findResult.stdout.trim()) {
		for (const deb of findResult.stdout.trim().split("\n")) {
			await exec("dpkg", ["-x", deb.trim(), DEPS_DIR]);
		}
	}

	// Verify
	const verify = await exec("bash", ["-c", `test -f ${shSingleQuote(testLib)}`]);
	if (verify.code !== 0) {
		console.error("crawl4ai: failed to set up Chromium system libraries");
		cacheMarkFailure(ready, cwd);
		return null;
	}

	cacheMarkSuccess(ready, cwd);
	return DEPS_LIB_DIR;
}
