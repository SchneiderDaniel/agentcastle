/**
 * executor.ts — Run ddgs Python script via temp files + env execution
 *
 * Isolates shell quoting and temp file management.
 * Writes Python script + config to ignore/web-search/ temp files and executes
 * via bash -c with properly quoted paths.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExecResult, ExecFn } from "./types.ts";

/**
 * Escape a string for use as a single-quoted bash argument.
 * Single-quote-safe: wrap in single quotes, escape embedded single quotes
 * by ending quote, adding escaped quote, and resuming.
 * abc'def → 'abc'\''def'
 */
export function shSingleQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Write Python script and config to temp files, then execute via bash -c.
 *
 * @param python — Path to python3 binary
 * @param scriptContent — Python script content (SEARCH_SCRIPT)
 * @param config — { query, max_results, proxy?, timeout? } search config
 * @param timeout — Timeout in ms
 * @param signal — Optional AbortSignal
 * @param execFn — Exec function (typically pi.exec)
 * @returns ExecResult from execFn
 */
export async function runSearchScript(
	python: string,
	scriptContent: string,
	config: { query: string; max_results: number; proxy?: string; timeout?: number },
	timeout: number,
	signal?: AbortSignal,
	execFn?: ExecFn,
): Promise<ExecResult> {
	const runDir = path.join(process.cwd(), "ignore", "web-search");
	fs.mkdirSync(runDir, { recursive: true });

	const scriptPath = path.join(runDir, "search.py");
	const configPath = path.join(runDir, "config.json");

	fs.writeFileSync(scriptPath, scriptContent, "utf-8");
	fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

	const qPython = shSingleQuote(python);
	const qScript = shSingleQuote(scriptPath);
	const qConfig = shSingleQuote(configPath);

	const bashCmd = `${qPython} ${qScript} ${qConfig}`;

	return execFn
		? execFn("bash", ["-c", bashCmd], { timeout, signal })
		: { code: 1, stdout: "", stderr: "executor: no exec function provided" };
}

/**
 * Parse SEARCH_OK / SEARCH_DONE delimited output from the Python script.
 * Returns the JSON text between delimiters, or null if not found.
 */
export function parseSearchOutput(stdout: string): string | null {
	const okIdx = stdout.indexOf("SEARCH_OK");
	const doneIdx = stdout.indexOf("SEARCH_DONE");
	if (okIdx === -1 || doneIdx === -1 || doneIdx <= okIdx) {
		return null;
	}
	const jsonPart = stdout.slice(okIdx + "SEARCH_OK".length, doneIdx).trim();
	return jsonPart || null;
}

/**
 * Parse search results from the delimited output.
 * Returns parsed SearchResult array or error string.
 */
export function parseSearchResults(
	stdout: string,
):
	| { ok: true; results: Array<{ title: string; url: string; snippet: string }> }
	| { ok: false; error: string } {
	const jsonText = parseSearchOutput(stdout);
	if (!jsonText) {
		return { ok: false, error: "No delimited output found" };
	}
	try {
		const parsed = JSON.parse(jsonText);
		if (parsed.ok === false) {
			return { ok: false, error: parsed.error || "Search returned error" };
		}
		return { ok: true, results: parsed.results || [] };
	} catch (e) {
		return { ok: false, error: `Failed to parse search results: ${e}` };
	}
}
