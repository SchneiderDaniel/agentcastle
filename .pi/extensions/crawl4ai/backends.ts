/**
 * backends.ts — CrawlBackend strategy pattern
 *
 * Defines the CrawlBackend interface and registry for the fallback chain.
 * Each backend implements tryCrawl(url, maxPages, signal, onUpdate) and
 * returns markdown text on success or null on failure.
 *
 * The CrawlBackendRegistry iterates backends in order until one succeeds.
 */

import { runCrawl4aiScript } from "./executor.ts";
import { CRAWL4AI_SCRIPT } from "./python-script.ts";
import { ensurePythonVenv, ensureChromiumDeps } from "./venv-setup.ts";
import type { ExecResult, ExecFn, OnUpdateCallback } from "./types.ts";
import type { VenvCache } from "./venv-setup.ts";
import { apifyCrawl } from "./apify-crawl.ts";
import { directFetchCrawl } from "./direct-fetch.ts";
import os from "node:os";

// ── CrawlBackend interface ──

export interface CrawlBackend {
	/** Human-readable backend name (used for diagnostics/status). */
	readonly name: string;

	/**
	 * Attempt to crawl the given URL.
	 *
	 * @param url — Target URL to crawl
	 * @param maxPages — Maximum pages to crawl (1–10)
	 * @param signal — Optional AbortSignal for cancellation
	 * @param onUpdate — Optional progress update callback
	 * @returns Markdown text on success, or null on failure
	 */
	tryCrawl(
		url: string,
		maxPages: number,
		signal?: AbortSignal,
		onUpdate?: OnUpdateCallback,
	): Promise<string | null>;
}

// ── Local crawl4ai backend ──

/**
 * Local crawl4ai Python script backend.
 *
 * Runs crawl4ai via a Python subprocess with Playwright+Chromium.
 * Requires a Python virtual environment with crawl4ai installed.
 * Falls back (returns null) if venv, deps, or script execution fails.
 */
export class LocalCrawl4aiBackend implements CrawlBackend {
	readonly name = "crawl4ai";

	exec: ExecFn;
	cwd: string;
	venvReady: VenvCache;
	depsReady: VenvCache;

	constructor(exec: ExecFn, cwd: string, venvReady: VenvCache, depsReady: VenvCache) {
		this.exec = exec;
		this.cwd = cwd;
		this.venvReady = venvReady;
		this.depsReady = depsReady;
	}

	async tryCrawl(
		url: string,
		maxPages: number,
		signal?: AbortSignal,
		onUpdate?: OnUpdateCallback,
	): Promise<string | null> {
		const python = await ensurePythonVenv(this.exec, this.cwd, onUpdate, this.venvReady);
		const depsDir = await ensureChromiumDeps(this.exec, this.cwd, onUpdate, this.depsReady);
		if (!python || !depsDir) return null;

		const browsersPath = (os.homedir() || "/tmp") + "/.cache/ms-playwright";
		const run = await runCrawl4aiScript(
			python,
			depsDir,
			browsersPath,
			CRAWL4AI_SCRIPT,
			{ url, maxPages },
			120_000,
			signal,
			this.exec,
		);
		if (run.code !== 0) return null;

		try {
			const okIdx = run.stdout.indexOf("CRAWL4AI_OK");
			const doneIdx = run.stdout.indexOf("CRAWL4AI_DONE");
			let jsonStr = "";
			if (okIdx !== -1 && doneIdx !== -1 && doneIdx > okIdx) {
				jsonStr = run.stdout.slice(okIdx + "CRAWL4AI_OK".length, doneIdx).trim();
			}
			const parsed = JSON.parse(jsonStr || run.stdout) as {
				ok: boolean;
				error?: string;
				results?: Array<{
					url: string;
					markdown?: string;
					error?: string;
					success: boolean;
				}>;
			};
			if (parsed.ok && parsed.results) {
				const texts = parsed.results.map((r) =>
					r.success
						? `--- ${r.url} ---\n${r.markdown || "[No content]"}`
						: `--- ${r.url} ---\nError: ${r.error}`,
				);
				return texts.join("\n\n");
			}
		} catch {
			console.error(
				"crawl4ai: parse failed, raw stdout (first 500 chars):",
				run.stdout.slice(0, 500),
			);
		}
		return null;
	}
}

// ── Apify backend ──

/**
 * Apify website-content-crawler backend.
 *
 * Delegates to the standalone apifyCrawl function.
 * Returns null if APIFY_TOKEN is unset or the crawl fails.
 */
export class ApifyBackend implements CrawlBackend {
	readonly name = "apify";

	async tryCrawl(
		url: string,
		maxPages: number,
		signal?: AbortSignal,
		_onUpdate?: OnUpdateCallback,
	): Promise<string | null> {
		return apifyCrawl(url, maxPages, signal);
	}
}

// ── Direct fetch backend ──

/**
 * Direct HTTP fetch backend (last resort).
 *
 * Delegates to the standalone directFetchCrawl function.
 * Always returns a string (error messages included) — never null.
 */
export class DirectFetchBackend implements CrawlBackend {
	readonly name = "direct-fetch";

	async tryCrawl(
		url: string,
		maxPages: number,
		signal?: AbortSignal,
		_onUpdate?: OnUpdateCallback,
	): Promise<string | null> {
		return directFetchCrawl(url, maxPages, signal);
	}
}

// ── CrawlBackendRegistry ──

/**
 * Registry that tries backends in order until one returns a non-null result.
 *
 * Usage:
 *   const registry = new CrawlBackendRegistry([backendA, backendB, backendC]);
 *   const result = await registry.tryAll(url, maxPages, signal, onUpdate);
 *   // result is the first non-null return from a backend, or null if all fail
 */
export class CrawlBackendRegistry {
	backends: CrawlBackend[];

	constructor(backends: CrawlBackend[]) {
		this.backends = backends;
	}

	/**
	 * Try each backend in order. Returns the first non-null result,
	 * or null if all backends return null.
	 */
	async tryAll(
		url: string,
		maxPages: number,
		signal?: AbortSignal,
		onUpdate?: OnUpdateCallback,
	): Promise<string | null> {
		for (const backend of this.backends) {
			const result = await backend.tryCrawl(url, maxPages, signal, onUpdate);
			if (result !== null) return result;
		}
		return null;
	}
}
