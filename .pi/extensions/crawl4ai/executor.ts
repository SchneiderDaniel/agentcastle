/**
 * executor.ts — Run crawl4ai Python script via temp files + env execution
 *
 * Isolates shell quoting, cross-platform concerns, and temp file management.
 * Writes Python script + config to .pi/crawl4ai/ temp files and executes
 * via bash -c with properly quoted paths and LD_LIBRARY_PATH.
 *
 * No base64 dependency. All paths single-quoted with embedded quote escaping.
 */

import fs from "node:fs";
import path from "node:path";

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

/**
 * Escape a string for use as a single-quoted bash argument.
 * Single-quote-safe: wrap in single quotes, escape embedded single quotes
 * by ending quote, adding escaped quote, and resuming.
 * abc'def → 'abc'\''def'
 */
function shSingleQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Write Python script and config to temp files, then execute via bash -c
 * with LD_LIBRARY_PATH set and all paths properly quoted.
 *
 * @param python — Path to python3 binary
 * @param depsDir — Chromium dependencies directory (LD_LIBRARY_PATH)
 * @param browsersPath — Playwright browsers cache path (PLAYWRIGHT_BROWSERS_PATH)
 * @param scriptContent — Python script content (CRAWL4AI_SCRIPT)
 * @param config — { url, maxPages } crawl config
 * @param timeout — Timeout in ms
 * @param signal — Optional AbortSignal
 * @param execFn — Exec function (typically pi.exec)
 * @returns ExecResult from execFn
 */
export async function runCrawl4aiScript(
	python: string,
	depsDir: string,
	browsersPath: string,
	scriptContent: string,
	config: { url: string; maxPages: number },
	timeout: number,
	signal?: AbortSignal,
	execFn?: ExecFn,
): Promise<ExecResult> {
	const runDir = path.join(depsDir, "..", "crawl4ai");
	fs.mkdirSync(runDir, { recursive: true });

	const scriptPath = path.join(runDir, "run.py");
	const configPath = path.join(runDir, "config.json");

	fs.writeFileSync(scriptPath, scriptContent, "utf-8");
	fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

	// Build bash command with all paths single-quoted
	const ldPath = shSingleQuote(depsDir + ":$LD_LIBRARY_PATH");
	const qBrowsers = shSingleQuote(browsersPath);
	const qPython = shSingleQuote(python);
	const qScript = shSingleQuote(scriptPath);
	const qConfig = shSingleQuote(configPath);

	const bashCmd = `env LD_LIBRARY_PATH=${ldPath} PLAYWRIGHT_BROWSERS_PATH=${qBrowsers} ${qPython} ${qScript} ${qConfig}`;

	return execFn
		? execFn("bash", ["-c", bashCmd], { timeout, signal })
		: { code: 1, stdout: "", stderr: "executor: no exec function provided" };
}
