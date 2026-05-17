import { existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Config ──────────────────────────────────────────────────────────

/** File extensions that should be auto-formatted */
export const FORMAT_EXTENSIONS = [
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
export const LINT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/** Maximum file size for formatting (1MB) to avoid perf issues */
export const MAX_FILE_SIZE_BYTES = 1_048_576;

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
export function buildPrettierArgs(
	cwd: string,
	filePath: string,
): { command: string; args: string[] } {
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
export function shouldFormat(path: string): boolean {
	const lower = path.toLowerCase();
	return FORMAT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Determine if a file extension should be linted by ESLint.
 */
export function shouldLint(path: string): boolean {
	const lower = path.toLowerCase();
	return LINT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Check if a path looks like a valid file path (not a directory, not protocol).
 */
export function looksLikeFilePath(path: unknown): path is string {
	if (typeof path !== "string") return false;
	if (path.includes("://")) return false;
	if (path.startsWith("~")) return false;
	if (path.length === 0) return false;
	return true;
}
