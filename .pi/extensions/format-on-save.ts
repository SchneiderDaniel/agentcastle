/**
 * format-on-save — Auto-formats TypeScript/JavaScript files with Prettier
 *                  then runs ESLint --fix for lint+styling (advisory, non-blocking)
 *
 * Hooks into write/edit tool results. After a TypeScript/JavaScript/TSX/JSX/JSON
 * file is written or edited, runs Prettier to reformat it.
 *
 * Tier 1 diagnostics: After Prettier, runs ESLint on the saved file and reports
 * errors/warnings as a follow-up message to the Developer (non-blocking).
 *
 * Uses project-local prettier from .pi/extensions/../node_modules or falls back
 * to npx prettier. ESLint uses npx eslint.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

/** File extensions that should be linted by ESLint (subset of FORMAT_EXTENSIONS) */
const LINT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

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
 * Build prettier args as { command, args } array, never a shell string.
 * Uses local node_modules if available, otherwise npx prettier.
 * Array args prevent shell injection — no shell variable expansion,
 * no command chaining, no quoting needed for paths with spaces.
 */
function buildPrettierArgs(cwd: string, filePath: string): { command: string; args: string[] } {
	const projectRoot = findProjectRoot(cwd);
	const localPrettier = resolve(projectRoot, "node_modules", ".bin", "prettier");
	const configPath = resolve(cwd, ".prettierrc");

	if (existsSync(localPrettier)) {
		return { command: localPrettier, args: ["--config", configPath, "--write", filePath] };
	}
	return { command: "npx", args: ["prettier", "--config", configPath, "--write", filePath] };
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
 * Run prettier --write on a file using pi.exec. Returns true on success.
 */
async function formatFile(pi: ExtensionAPI, filePath: string, configDir: string): Promise<boolean> {
	const { command, args } = buildPrettierArgs(configDir, filePath);
	const result = await pi.exec(command, args, { cwd: configDir, timeout: 15_000 });
	// Non-zero exit is data, not exception
	return result.code === 0;
}

// ─── ESLint Helpers (Tier 1 diagnostics) ────────────────────────────

/** Parse ESLint JSON output into diagnostics array. */
export function parseEslintOutput(jsonOutput: string): Array<{
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning";
	message: string;
	ruleId: string | null;
}> {
	try {
		const data = JSON.parse(jsonOutput);
		if (!Array.isArray(data)) return [];

		const diagnostics: Array<{
			file: string;
			line: number;
			column: number;
			severity: "Error" | "Warning";
			message: string;
			ruleId: string | null;
		}> = [];

		for (const fileResult of data) {
			if (!fileResult || !Array.isArray(fileResult.messages)) continue;

			const filePath = fileResult.filePath || "unknown";

			for (const msg of fileResult.messages) {
				const severity: "Error" | "Warning" = msg.severity === 2 ? "Error" : "Warning";
				diagnostics.push({
					file: filePath,
					line: msg.line || 0,
					column: msg.column || 0,
					severity,
					message: msg.message || "",
					ruleId: msg.ruleId || null,
				});
			}
		}

		return diagnostics;
	} catch {
		return [];
	}
}

/** Format ESLint diagnostics into developer-readable follow-up message. */
export function formatEslintDiagnostics(
	diagnostics: Array<{
		file: string;
		line: number;
		column: number;
		severity: "Error" | "Warning";
		message: string;
		ruleId: string | null;
	}>,
): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, typeof diagnostics>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		// Sort: errors first, then by line
		diags.sort((a, b) => {
			if (a.severity !== b.severity) return a.severity === "Error" ? -1 : 1;
			if (a.line !== b.line) return a.line - b.line;
			return a.column - b.column;
		});

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const rulePart = d.ruleId ? ` (${d.ruleId})` : "";
			lines.push(`${file}, Line ${d.line}: [${d.severity}] ${msg}${rulePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

/**
 * Determine if a file extension should be linted by ESLint.
 */
function shouldLint(path: string): boolean {
	const lower = path.toLowerCase();
	return LINT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Exported type for ESLint diagnostics. */
export interface EslintDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning";
	message: string;
	ruleId: string | null;
}

/**
 * Run ESLint on a single file and return formatted diagnostics message.
 * Returns empty string if no issues found or ESLint is unavailable.
 *
 * ESLint exits code 0 = no errors, 1 = lint errors found, 2 = config error.
 * For code 1, stdout still contains valid JSON array.
 * pi.exec returns non-zero exit as result.code, not thrown exception.
 *
 * For code 2 (config error), retry with --no-eslintrc fallback.
 */
async function runEslintOnFile(
	pi: ExtensionAPI,
	filePath: string,
	cwd: string,
): Promise<string> {
	// Primary attempt with project ESLint config
	let result = await tryRunEslint(pi, filePath, cwd, []);
	if (result !== null) return result;

	// Config error (exit code 2) — retry with --no-eslintrc fallback
	result = await tryRunEslint(pi, filePath, cwd, ["--no-eslintrc"]);
	return result ?? "";
}

/**
 * Attempt to run ESLint with given extra args.
 * Returns formatted string on success (or lint errors found).
 * Returns null if ESLint exited with code 2 (config error).
 * Returns empty string if no issues.
 */
async function tryRunEslint(
	pi: ExtensionAPI,
	filePath: string,
	cwd: string,
	extraArgs: string[],
): Promise<string | null> {
	const result = await pi.exec(
		"npx",
		[
			"eslint",
			"--no-error-on-unmatched-pattern",
			"--format",
			"json",
			"--fix",
			...extraArgs,
			filePath,
		],
		{ cwd, timeout: 15_000 },
	);

	// Exit code 2 = config error — signal retry with --no-eslintrc
	if (result.code === 2) return null;

	// Exit code 0 or 1 — parse stdout for diagnostics
	if (result.code === 0 || result.code === 1) {
		const diags = parseEslintOutput(result.stdout);
		if (diags.length === 0) return "";
		return formatEslintDiagnostics(diags);
	}

	// Other error — skip silently
	return "";
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

		// Step 1: Format the file in-place with --write
		const ok = await formatFile(pi, absolutePath, ctx.cwd);
		if (ok && ctx.hasUI) {
			ctx.ui.notify(`Formatted: ${filePath}`, "info");
		}

		// Step 2: ESLint on saved file (Tier 1 diagnostics, advisory only)
		if (shouldLint(absolutePath)) {
			const lintMsg = await runEslintOnFile(pi, absolutePath, ctx.cwd);
			if (lintMsg && ctx.hasUI) {
				ctx.ui.notify(`ESLint ran: ${filePath}`, "info");
			}
			if (lintMsg) {
				// Non-blocking — deliver as followUp, Developer can proceed
				const followUp = [
					`## Lint Diagnostics — ${filePath}`,
					``,
					`ESLint found the following issues (advisory — not blocking):`,
					``,
					lintMsg,
				].join("\n");
				pi.sendUserMessage?.(followUp, { deliverAs: "followUp" });
			}
		}
	});
}
