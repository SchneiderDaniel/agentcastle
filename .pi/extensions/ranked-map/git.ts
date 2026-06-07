/**
 * ranked-map — Git recency, HEAD helpers, and submodule discovery
 *
 * Adapter module — uses ExecFn (pi.exec compatible) for subprocess execution.
 * Fully async with AbortSignal support.
 */

import type { ExecFn, SubmoduleInfo } from "./types.ts";

// --------------------------------------------------------------------------
// Git recency — superproject + submodule aware
// --------------------------------------------------------------------------

/**
 * Parse git log --pretty=format:%ad --date=format:... --name-only output
 * and populate the fileDates map with the most recent commit date per file.
 */
function parseGitLogOutput(stdout: string, fileDates: Record<string, string>): void {
	const lines = stdout.split("\n");
	let currentDate: string | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Check if this line looks like a date (from --pretty=format)
		if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(trimmed)) {
			currentDate = trimmed;
			continue;
		}

		// It's a file path
		if (currentDate && trimmed) {
			// Keep the most recent date per file (first encounter in git log is most recent)
			if (!fileDates[trimmed]) {
				fileDates[trimmed] = currentDate;
			}
		}
	}
}

/**
 * Run git log to get last-touched dates for tracked files within the window.
 *
 * When submodules is provided, also runs git log inside each initialized submodule
 * and merges file dates with the submodule path prefix (e.g. "flask_blogs/src/file.py").
 *
 * Returns a map of file path → ISO date string (most recent commit date per file).
 * Returns empty map on error or no commits.
 *
 * Backward compatible: callers that don't pass submodules get the same behavior as before.
 */
export async function runGitRecency(
	exec: ExecFn,
	windowDays: number,
	cwd: string,
	signal?: AbortSignal,
	submodules?: SubmoduleInfo[],
): Promise<Record<string, string>> {
	const fileDates: Record<string, string> = {};

	// Phase 1: Superproject git log (unchanged behavior)
	const since = `--since="${windowDays} days ago"`;
	const result = await exec(
		"git",
		[
			"log",
			since,
			"--pretty=format:%ad",
			"--date=format:%Y-%m-%dT%H:%M:%SZ",
			"--name-only",
			"--diff-filter=AM",
		],
		{ cwd, timeout: 15_000, signal },
	);

	// git log may fail on repos with no commits — continue but fileDates stays empty
	if (result.code === 0) {
		parseGitLogOutput(result.stdout, fileDates);
	}

	// Phase 2: Submodule git logs (if any)
	if (submodules && submodules.length > 0) {
		for (const sm of submodules) {
			// Skip uninitialized submodules — no git repo to query
			if (sm.sha === "uninitialized") continue;

			const smResult = await exec(
				"git",
				[
					"-C",
					sm.path,
					"log",
					since,
					"--pretty=format:%ad",
					"--date=format:%Y-%m-%dT%H:%M:%SZ",
					"--name-only",
					"--diff-filter=AM",
				],
				{ cwd, timeout: 15_000, signal },
			);

			// Skip failed submodule git log — superproject results preserved
			if (smResult.code !== 0) continue;

			const smLines = smResult.stdout.split("\n");
			let smCurrentDate: string | null = null;

			for (const rawLine of smLines) {
				const trimmed = rawLine.trim();
				if (!trimmed) continue;

				// Check if this line looks like a date
				if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(trimmed)) {
					smCurrentDate = trimmed;
					continue;
				}

				// It's a file path — prefix with submodule path
				if (smCurrentDate && trimmed) {
					const prefixedPath = `${sm.path}/${trimmed}`;
					if (!fileDates[prefixedPath]) {
						fileDates[prefixedPath] = smCurrentDate;
					}
				}
			}
		}
	}

	return fileDates;
}

// --------------------------------------------------------------------------
// Submodule discovery
// --------------------------------------------------------------------------

/**
 * Parse a single line from `git submodule status` output.
 *
 * Status line format: <flags><sha> <path> (<describe>)
 * Flags:
 *   ' ' = initialized
 *   '-' = uninitialized
 *   '+' = modified (dirty)
 *   'U' = merge conflict
 *
 * Returns {sha, path} or null if the line can't be parsed.
 */
function parseSubmoduleStatusLine(line: string): { sha: string; path: string } | null {
	const trimmed = line.trim();
	if (!trimmed) return null;

	// Match optional single-char flag + 40-char sha + space + path + optional (describe)
	const match = trimmed.match(/^([-+U ])?([a-f0-9]{4,64})\s+(.+?)(?:\s+\(.*\))?$/);
	if (!match) return null;

	const flag = match[1] ?? " ";
	const sha = match[2]!;
	const path = match[3]!.trim();

	return {
		sha: flag === "-" ? "uninitialized" : sha,
		path,
	};
}

/**
 * Parse .gitmodules configuration via `git config --file .gitmodules`.
 *
 * Returns an array of {path, url} entries extracted from the submodule
 * sections of the .gitmodules file. sha is left undefined since
 * .gitmodules doesn't contain commit information.
 */
async function discoverFromGitmodules(
	exec: ExecFn,
	cwd: string,
	signal?: AbortSignal,
): Promise<SubmoduleInfo[]> {
	// Get submodule paths
	const pathResult = await exec(
		"git",
		["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"],
		{ cwd, timeout: 10_000, signal },
	);

	if (pathResult.code !== 0 || !pathResult.stdout.trim()) return [];

	// Parse paths: "submodule.name.path value"
	const pathLines = pathResult.stdout.trim().split("\n");
	const submoduleNames: string[] = [];
	const pathMap = new Map<string, string>(); // name → path

	for (const line of pathLines) {
		const match = line.match(/^submodule\.(.+?)\.path\s+(.+)$/);
		if (match) {
			const name = match[1]!;
			const smPath = match[2]!.trim();
			submoduleNames.push(name);
			pathMap.set(name, smPath);
		}
	}

	if (submoduleNames.length === 0) return [];

	// Get submodule URLs
	const urlResult = await exec(
		"git",
		["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.url"],
		{ cwd, timeout: 10_000, signal },
	);

	const urlMap = new Map<string, string>(); // name → url
	if (urlResult.code === 0 && urlResult.stdout.trim()) {
		for (const line of urlResult.stdout.trim().split("\n")) {
			const match = line.match(/^submodule\.(.+?)\.url\s+(.+)$/);
			if (match) {
				urlMap.set(match[1]!, match[2]!.trim());
			}
		}
	}

	const submodules: SubmoduleInfo[] = [];
	for (const name of submoduleNames) {
		const smPath = pathMap.get(name);
		if (smPath) {
			submodules.push({
				path: smPath,
				url: urlMap.get(name),
				// sha is undefined since .gitmodules doesn't contain commit info
			});
		}
	}

	return submodules;
}

/**
 * Discover git submodules in the repository at cwd.
 *
 * Strategy:
 * 1. Run `git submodule status` — parses output for sha, path, and initialization status.
 * 2. If status returns empty stdout (e.g. submodules not initialized), falls back to
 *    parsing `.gitmodules` via `git config --file .gitmodules`.
 * 3. Returns empty array on failure or when no submodules exist.
 *
 * Uninitialized submodules (prefix `-` in status) are marked with sha="uninitialized".
 */
export async function discoverSubmodules(
	exec: ExecFn,
	cwd: string,
	signal?: AbortSignal,
): Promise<SubmoduleInfo[]> {
	// Strategy 1: `git submodule status` for initialized submodules
	const statusResult = await exec("git", ["submodule", "status"], {
		cwd,
		timeout: 10_000,
		signal,
	});

	if (statusResult.code !== 0) {
		// git command failed entirely — try .gitmodules fallback
		return discoverFromGitmodules(exec, cwd, signal);
	}

	const stdout = statusResult.stdout.trim();
	if (!stdout) {
		// Empty output — submodules exist but none are initialized; try .gitmodules
		return discoverFromGitmodules(exec, cwd, signal);
	}

	// Parse status lines
	const lines = stdout.split("\n");
	const submodules: SubmoduleInfo[] = [];

	for (const line of lines) {
		const parsed = parseSubmoduleStatusLine(line);
		if (parsed) {
			submodules.push({
				path: parsed.path,
				sha: parsed.sha,
			});
		}
	}

	return submodules;
}

// --------------------------------------------------------------------------
// Git HEAD
// --------------------------------------------------------------------------

/**
 * Get the current git HEAD for cache invalidation.
 * Returns null if not a git repo or git fails.
 */
export async function getGitHead(
	exec: ExecFn,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	const result = await exec("git", ["rev-parse", "HEAD"], {
		cwd,
		timeout: 5_000,
		signal,
	});
	if (result.code !== 0) return null;
	return result.stdout.trim();
}
