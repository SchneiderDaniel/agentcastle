/**
 * Python virtual environment setup for web-search.
 *
 * Creates `.pi/web-search-venv/` and installs `ddgs` from requirements.txt.
 * Uses pi.exec for testable mock injection. Cache with retry TTL so
 * failed setups don't permanently lock out without restart.
 *
 * Lightweight — no Chromium deps, just one pip package.
 */

import type { ExecFn, OnUpdateCallback } from "./types.ts";

// ── Configurable constants ──

/** TTL before a failed venv cache entry is eligible for retry (ms). */
export const VENV_RETRY_TTL_MS = 30_000;

/** Maximum retry attempts for failed venv setup. */
export const VENV_RETRY_MAX = 3;

// ── Types ──

/** Cache entry for venv ready state with retry metadata. */
export interface VenvCacheEntry {
	ready: boolean;
	timestamp: number;
	retries: number;
}

export type VenvCache = Map<string, VenvCacheEntry>;

/** Resolve venv paths relative to cwd */
function lazyPaths(cwd: string) {
	return {
		VENV_DIR: `${cwd}/.pi/web-search-venv`,
		VENV_PYTHON: `${cwd}/.pi/web-search-venv/bin/python3`,
		REQUIREMENTS: `${cwd}/.pi/extensions/web-search/requirements.txt`,
	};
}

// ── Cache helpers ──

function cacheGet(
	cache: Map<string, VenvCacheEntry>,
	key: string,
): { entry: VenvCacheEntry | undefined; shouldRetry: boolean } {
	const entry = cache.get(key);
	if (!entry) return { entry: undefined, shouldRetry: false };
	if (entry.ready) return { entry, shouldRetry: false };
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
 * Ensure Python virtual env with ddgs installed exists.
 * Returns path to venv python3 binary, or null if setup fails.
 */
export async function ensureWebSearchVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: OnUpdateCallback,
	venvReady?: VenvCache,
): Promise<string | null> {
	const ready = venvReady ?? new Map<string, VenvCacheEntry>();
	const { VENV_PYTHON, VENV_DIR, REQUIREMENTS } = lazyPaths(cwd);

	const { entry, shouldRetry } = cacheGet(ready, cwd);
	if (entry && !shouldRetry) return entry.ready ? VENV_PYTHON : null;

	// Check system python3 exists
	const pyCheck = await exec("python3", ["--version"]);
	if (pyCheck.code !== 0) {
		console.error("web-search: python3 not found");
		cacheMarkFailure(ready, cwd);
		return null;
	}

	// Check if venv already set up with ddgs
	const alreadyOk = await exec(VENV_PYTHON, ["-c", "import ddgs; print('ok')"]);
	if (alreadyOk.code === 0 && alreadyOk.stdout.includes("ok")) {
		cacheMarkSuccess(ready, cwd);
		return VENV_PYTHON;
	}

	// Create venv if missing or broken
	const venvCheck = await exec(VENV_PYTHON, ["--version"]);
	if (venvCheck.code !== 0) {
		await exec("rm", ["-rf", VENV_DIR]);
		onUpdate?.({
			content: [
				{
					type: "text",
					text: "Creating Python virtual environment for web-search…",
				},
			],
			details: {} as Record<string, unknown>,
		});
		const create = await exec("python3", ["-m", "venv", "--clear", VENV_DIR]);
		if (create.code !== 0) {
			console.error("web-search: failed to create venv");
			cacheMarkFailure(ready, cwd);
			return null;
		}
	}

	// Install ddgs from requirements.txt
	onUpdate?.({
		content: [{ type: "text", text: "Installing ddgs (web-search dependency)…" }],
		details: {} as Record<string, unknown>,
	});
	const install = await exec(VENV_PYTHON, ["-m", "pip", "install", "-r", REQUIREMENTS], {
		timeout: 120_000,
	});
	if (install.code !== 0) {
		console.error("web-search: pip install failed:", install.stderr.slice(0, 500));
		cacheMarkFailure(ready, cwd);
		return null;
	}

	// Verify
	const verify = await exec(VENV_PYTHON, ["-c", "import ddgs; print('ok')"]);
	if (verify.code === 0 && verify.stdout.includes("ok")) {
		cacheMarkSuccess(ready, cwd);
		return VENV_PYTHON;
	}
	cacheMarkFailure(ready, cwd);
	return null;
}
