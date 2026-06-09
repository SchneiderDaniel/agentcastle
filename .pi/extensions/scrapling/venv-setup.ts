/**
 * Simplified Python virtual environment setup for Scrapling.
 *
 * Sets up Python venv for scrapling-based web crawling.
 * Clean pip install scrapling[fetchers] markdownify beautifulsoup4
 * File-based lock to prevent race conditions from parallel agents
 * No system-level Chromium deps needed (Scrapling manages its own browser binaries)
 */

import type { ExecFn } from "./types.ts";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ── Constants ──

export const VENV_DIR = ".pi/scrapling-venv";
const LOCK_FILE = ".pi/.scrapling-venv.lock";
const LOCK_WAIT_MS = 5000;

// ── ensureScraplingVenv ──

/**
 * Ensure Scrapling Python virtual environment exists and has required packages.
 *
 * @param exec — Exec function (typically pi.exec)
 * @param cwd — Working directory (project root)
 * @param onUpdate — Optional progress update callback
 * @returns Path to python3 binary, or null if setup fails
 */
export async function ensureScraplingVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void,
): Promise<string | null> {
	const pyPath = `${cwd}/${VENV_DIR}/bin/python3`;

	// Quick check if already setup
	const check = await exec(pyPath, [
		"-c",
		"from scrapling.fetchers import StealthyFetcher; import markdownify; print('ok')",
	]);
	if (check.code === 0) return pyPath;

	// Prevent parallel venv creation race condition
	if (existsSync(`${cwd}/${LOCK_FILE}`)) {
		// Wait for the other process to finish creating it
		await new Promise((r) => setTimeout(r, LOCK_WAIT_MS));
		return pyPath;
	}

	try {
		mkdirSync(`${cwd}/.pi`, { recursive: true });
		writeFileSync(`${cwd}/${LOCK_FILE}`, "locked");

		onUpdate?.({
			content: [{ type: "text", text: "Creating Python venv for scraping…" }],
			details: {},
		});
		const createVenv = await exec("python3", ["-m", "venv", "--clear", `${cwd}/${VENV_DIR}`]);
		if (createVenv.code !== 0) {
			console.error("scrapling: failed to create venv");
			return null;
		}

		onUpdate?.({
			content: [{ type: "text", text: "Installing Scrapling and Markdown tools…" }],
			details: {},
		});
		const install = await exec(
			pyPath,
			["-m", "pip", "install", "scrapling[fetchers]", "markdownify", "beautifulsoup4"],
			{ timeout: 180_000 },
		);
		if (install.code !== 0) {
			console.error("scrapling: pip install failed:", install.stderr.slice(0, 500));
			return null;
		}

		onUpdate?.({
			content: [{ type: "text", text: "Downloading browser binaries…" }],
			details: {},
		});
		await exec(pyPath, ["-m", "scrapling.cli", "install"], { timeout: 120_000 });

		return pyPath;
	} finally {
		// Always remove the lock file
		try {
			if (existsSync(`${cwd}/${LOCK_FILE}`)) {
				unlinkSync(`${cwd}/${LOCK_FILE}`);
			}
		} catch {
			// Best-effort cleanup
		}
	}
}
