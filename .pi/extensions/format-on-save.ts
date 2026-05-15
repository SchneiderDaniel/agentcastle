/**
 * format-on-save — Auto-formats TypeScript/JavaScript files with Prettier
 *
 * Hooks into write/edit tool results. After a TypeScript/JavaScript/TSX/JSX/JSON
 * file is written or edited, runs Prettier to reformat it.
 *
 * Uses project-local prettier from .pi/extensions/../node_modules or falls back
 * to npx prettier.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────

/** File extensions that should be auto-formatted */
const FORMAT_EXTENSIONS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".mts",
	".cts",
	".json",
	".jsonc",
	".json5",
];

/** Maximum file size for formatting (1MB) to avoid perf issues */
const MAX_FILE_SIZE_BYTES = 1_048_576;

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Find the project root with a package.json, walking up from the given
 * directory. Used to locate the nearest node_modules for prettier.
 */
function findProjectRoot(fromDir: string): string {
	let dir = resolve(fromDir);
	while (true) {
		if (existsSync(resolve(dir, "package.json"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return fromDir; // fallback
}

/**
 * Build the prettier CLI command to format a file.
 * Uses local node_modules if available, otherwise npx prettier.
 */
function buildPrettierCommand(cwd: string, filePath: string): string {
	const projectRoot = findProjectRoot(cwd);
	const localPrettier = resolve(projectRoot, "node_modules", ".bin", "prettier");
	const configPath = resolve(cwd, ".prettierrc");

	if (existsSync(localPrettier)) {
		return `"${localPrettier}" --config "${configPath}" --write "${filePath}"`;
	}
	return `npx prettier --config "${configPath}" --write "${filePath}"`;
}

/**
 * Determine if a file should be formatted based on its extension.
 */
function shouldFormat(path: string): boolean {
	const lower = path.toLowerCase();
	return FORMAT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Check if a path looks like a valid file path (not a directory, not protocol).
 */
function looksLikeFilePath(path: unknown): path is string {
	if (typeof path !== "string") return false;
	if (path.includes("://")) return false;
	if (path.startsWith("~")) return false;
	if (path.length === 0) return false;
	return true;
}

// ─── Formatter ───────────────────────────────────────────────────────

/**
 * Run prettier --write on a file. Returns true on success.
 */
function formatFile(filePath: string, configDir: string): boolean {
	try {
		const command = buildPrettierCommand(configDir, filePath);
		execSync(command, {
			cwd: configDir,
			encoding: "utf-8",
			timeout: 15_000,
			maxBuffer: 5 * 1024 * 1024, // 5MB
		});
		return true;
	} catch {
		// Prettier may fail on syntax errors — that's fine, LLM will fix
		return false;
	}
}

// ─── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		// Only handle write and edit tools
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		// Skip errors
		if (event.isError) return;

		// Extract the file path from input
		const filePath = (event.input as { path?: string }).path;
		if (!looksLikeFilePath(filePath)) return;

		// Resolve relative paths against cwd
		const absolutePath = resolve(ctx.cwd, filePath);

		// Skip non-formatable files
		if (!shouldFormat(absolutePath)) return;

		// Skip files that don't exist (shouldn't happen after write, but safe)
		if (!existsSync(absolutePath)) return;

		// Skip files that are too large
		try {
			const stats = statSync(absolutePath);
			if (stats.size > MAX_FILE_SIZE_BYTES) return;
		} catch {
			return;
		}

		// Format the file in-place with --write
		const ok = formatFile(absolutePath, ctx.cwd);
		if (ok && ctx.hasUI) {
			ctx.ui.notify(`Formatted: ${filePath}`, "info");
		}
	});
}
