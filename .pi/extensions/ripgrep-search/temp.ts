/**
 * Temp directory tracking + lifecycle cleanup for ripgrep-search.
 *
 * Pure module — no dependencies on pi SDK.
 * Tracks temp directories created during searches and cleans them
 * up at session shutdown.
 */

/** @internal Exported for testability — allows tests to inspect state. */
export const trackedTempDirs = new Set<string>();

/** Register a temp directory for deferred cleanup at session end. */
export function registerTempDir(dir: string): void {
	trackedTempDirs.add(dir);
}

/**
 * Clean up all tracked temp directories.
 * Accepts rm function for testability (mock injection).
 */
export async function cleanupTrackedTempDirs(
	rmFn: (path: string, opts?: { recursive?: boolean; force?: boolean }) => Promise<void>,
): Promise<void> {
	for (const dir of trackedTempDirs) {
		await rmFn(dir, { recursive: true, force: true });
	}
	trackedTempDirs.clear();
}
