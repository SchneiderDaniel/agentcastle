/**
 * ranked-map — Git recency and HEAD helpers
 *
 * Adapter module — uses ExecFn (pi.exec compatible) for subprocess execution.
 * Fully async with AbortSignal support.
 */

import type { ExecFn } from "./types.ts";

/**
 * Run git log to get last-touched dates for tracked files within the window.
 *
 * Returns a map of file path → ISO date string (most recent commit date per file).
 * Returns empty map on error or no commits.
 */
export async function runGitRecency(
	exec: ExecFn,
	windowDays: number,
	cwd: string,
	signal?: AbortSignal,
): Promise<Record<string, string>> {
	const fileDates: Record<string, string> = {};

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

	// git log may fail on repos with no commits — return empty
	if (result.code !== 0) return fileDates;

	const lines = result.stdout.split("\n");
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

	return fileDates;
}

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
