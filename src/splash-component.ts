/**
 * SplashComponent — Terminal loading screen for extension startup.
 *
 * Renders a full-screen loading overlay when pi starts in interactive mode.
 * Shows real-time progress as extensions load, then transitions to the editor.
 *
 * The component is stateless — it receives progress data and renders output.
 * State management is handled by the caller (InteractiveMode).
 */

import type {
	LoadingProgress,
	ExtensionLoadStatus,
	ExtensionProgressEntry,
} from "./extension-progress-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Rendering helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate the status icon for an extension entry. */
export function getStatusIcon(status: ExtensionLoadStatus): string {
	switch (status) {
		case "pending":
			return "·";
		case "loading":
			return "◌";
		case "done":
			return "✓";
		case "failed":
			return "✗";
	}
}

/** Render the progress bar string (e.g. "[====----]"). */
export function renderProgressBar(fraction: number, width: number): string {
	const barWidth = Math.max(width - 2, 1);
	const filled = Math.round(fraction * barWidth);
	const empty = barWidth - filled;
	const bar = "=".repeat(filled) + "-".repeat(empty);
	return `[${bar}]`;
}

/** Format a fraction as percentage string (e.g. "65%"). */
export function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/** Render the extension list with status icons, truncated to maxLines. */
export function renderExtensionList(entries: ExtensionProgressEntry[], maxLines: number): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		if (lines.length >= maxLines) {
			const remaining = entries.length - maxLines;
			lines.push(`  ··· and ${remaining} more`);
			break;
		}
		const icon = getStatusIcon(entry.status);
		const errorSuffix = entry.error ? ` — ${entry.error}` : "";
		lines.push(`  ${icon} ${entry.name}${errorSuffix}`);
	}
	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// SplashComponent class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SplashComponent renders a loading screen for extension startup.
 *
 * Usage:
 *   const splash = new SplashComponent("pi coding agent", "v0.74.0");
 *   splash.update(progressData);
 *   const lines = splash.render(80);  // returns string[]
 */
export class SplashComponent {
	private _title: string;
	private _version: string;
	private _progress: LoadingProgress | null = null;
	private _quiet: boolean;
	private _progressListeners: Array<(progress: LoadingProgress) => void> = [];

	constructor(title: string, version: string, quiet: boolean = false) {
		this._title = title;
		this._version = version;
		this._quiet = quiet;
	}

	/** Get the current title. */
	get title(): string {
		return this._title;
	}

	/** Get the current version string. */
	get version(): string {
		return this._version;
	}

	/** Whether quiet mode is enabled. */
	get quiet(): boolean {
		return this._quiet;
	}

	/** Get the current progress state (null if no update received yet). */
	get progress(): LoadingProgress | null {
		return this._progress;
	}

	/**
	 * Update the progress state and render.
	 * Call this each time an extension factory completes.
	 */
	update(progress: LoadingProgress): void {
		this._progress = progress;
		for (const listener of this._progressListeners) {
			listener(progress);
		}
	}

	/**
	 * Listen for progress updates. Returns unsubscribe function.
	 */
	onProgress(listener: (progress: LoadingProgress) => void): () => void {
		this._progressListeners.push(listener);
		return () => {
			const idx = this._progressListeners.indexOf(listener);
			if (idx !== -1) this._progressListeners.splice(idx, 1);
		};
	}

	/**
	 * Render the splash screen as an array of lines for the given terminal width.
	 */
	render(width: number): string[] {
		if (this._quiet) {
			return this._renderQuiet(width);
		}
		return this._renderFull(width);
	}

	/** Render the minimal quiet-mode splash. */
	private _renderQuiet(_width: number): string[] {
		if (!this._progress) {
			return ["  Loading..."];
		}
		const { total, completed, failed } = this._progress;
		const fraction = total === 0 ? 1 : (completed + failed) / total;
		const pct = formatPercent(fraction);
		return [`  Loading... ${pct}`];
	}

	/** Render the full splash screen. */
	private _renderFull(width: number): string[] {
		const lines: string[] = [];
		const innerWidth = Math.min(width - 4, 60);

		// Title
		lines.push(`  ${this._title}`);
		lines.push("");

		// Logo / version
		lines.push(`  ${this._version}`);
		lines.push("");

		// Loading message
		lines.push(`  Loading extensions...`);

		// Progress bar
		if (this._progress) {
			const { total, completed, failed } = this._progress;
			const fraction = total === 0 ? 1 : (completed + failed) / total;
			const barWidth = Math.min(innerWidth - 4, 40);
			const bar = renderProgressBar(fraction, barWidth);
			const pct = formatPercent(fraction);
			lines.push(`  ${bar} ${pct}`);
		} else {
			const barWidth = Math.min(innerWidth - 4, 40);
			const emptyBar = renderProgressBar(0, barWidth);
			lines.push(`  ${emptyBar} 0%`);
		}
		lines.push("");

		// Extension list
		if (this._progress && this._progress.entries.length > 0) {
			const maxExtLines = innerWidth > 50 ? 10 : 5;
			const extLines = renderExtensionList(this._progress.entries, maxExtLines);
			for (const line of extLines) {
				lines.push(line);
			}
		}

		return lines;
	}
}
