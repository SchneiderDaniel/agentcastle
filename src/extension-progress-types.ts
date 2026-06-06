/**
 * Extension loading progress types for the splash screen.
 *
 * These types define the progress tracking interface used by
 * SplashComponent to display extension loading progress.
 */

/** Status of a single extension during loading. */
export type ExtensionLoadStatus = "pending" | "loading" | "done" | "failed";

/** Progress entry for a single extension. */
export interface ExtensionProgressEntry {
	/** Extension name (display name or path basename). */
	name: string;
	/** Current loading status. */
	status: ExtensionLoadStatus;
	/** Error message if status is "failed". */
	error?: string;
}

/**
 * Extension loading progress event payload.
 * Emitted by ExtensionRunner as each extension factory resolves or rejects.
 */
export interface ExtensionLoadingProgressEvent {
	type: "extension_loading_progress";
	total: number;
	completed: number;
	failed: number;
	pending: number;
	entries: ExtensionProgressEntry[];
}

/**
 * Aggregate loading progress state.
 * Accumulated from ExtensionLoadingProgressEvent emissions.
 */
export interface LoadingProgress {
	total: number;
	completed: number;
	failed: number;
	pending: number;
	entries: ExtensionProgressEntry[];
}

/**
 * Build initial LoadingProgress from a list of extension names/paths.
 */
export function createLoadingProgress(extensionNames: string[]): LoadingProgress {
	return {
		total: extensionNames.length,
		completed: 0,
		failed: 0,
		pending: extensionNames.length,
		entries: extensionNames.map((name) => ({
			name,
			status: "pending",
		})),
	};
}

/**
 * Apply a progress delta to the current LoadingProgress state.
 * Returns a new LoadingProgress with the update applied.
 */
export function applyProgressDelta(
	current: LoadingProgress,
	delta: { name: string; status: ExtensionLoadStatus; error?: string },
): LoadingProgress {
	const entries = current.entries.map((entry) =>
		entry.name === delta.name
			? { ...entry, status: delta.status, error: delta.error ?? entry.error }
			: entry,
	);
	const completed = entries.filter((e) => e.status === "done").length;
	const failed = entries.filter((e) => e.status === "failed").length;
	const pending = entries.filter((e) => e.status === "pending" || e.status === "loading").length;
	return { total: current.total, completed, failed, pending, entries };
}

/**
 * Calculate the progress fraction (0-1) for the progress bar.
 */
export function calculateProgressFraction(
	completed: number,
	failed: number,
	total: number,
): number {
	if (total === 0) return 1;
	return (completed + failed) / total;
}
