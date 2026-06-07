/**
 * runWithSplash — Coordinates SplashComponent with extension loading.
 *
 * Creates a SplashComponent before extensions load, subscribes to
 * progress events from the event bus, renders the splash to terminal,
 * and dismisses it when all extensions are loaded.
 *
 * Usage:
 *   const result = await runWithSplash({
 *     title: "pi coding agent",
 *     version: "v0.74.0",
 *     eventBus,
 *     terminalWidth: 80,
 *     loadExtensions: () => loader.loadExtensions(paths, cwd, eventBus),
 *   });
 */

import { SplashComponent } from "./splash-component.js";
import type { ExtensionLoadingProgressEvent, LoadingProgress } from "./extension-progress-types.js";
import type { ProgressEventListener } from "./progress-emitter.js";

/** Options for runWithSplash. */
export interface RunWithSplashOptions {
	/** Application title displayed in splash header. */
	title: string;
	/** Version string displayed in splash. */
	version: string;
	/** Event bus for extension loading progress events. */
	eventBus: {
		on: (channel: string, handler: (data: unknown) => void) => () => void;
		emit: (channel: string, data: unknown) => void;
	};
	/** Terminal width in characters (for splash layout). */
	terminalWidth: number;
	/**
	 * Function that loads extensions.
	 * Receives a progress callback that should be called with each
	 * extension loading event from the event bus.
	 */
	loadExtensions: () => Promise<unknown>;
	/** Whether to run in quiet mode (minimal output). */
	quiet?: boolean;
	/** Whether this is an interactive session (non-interactive modes skip splash). */
	interactive?: boolean;
	/** Callback invoked when splash is dismissed (after all extensions load). */
	onDismiss?: () => void;
}

/** Result of runWithSplash. */
export interface RunWithSplashResult {
	/** The result from loadExtensions(). */
	result: unknown;
	/** The SplashComponent instance (useful for inspecting final state). */
	splash: SplashComponent;
	/** Total number of progress events received. */
	eventCount: number;
}

/**
 * Run extension loading with a splash screen.
 *
 * In non-interactive modes (quiet or not interactive), the splash is
 * skipped and loadExtensions() is called directly.
 *
 * @returns The result from loadExtensions() and the SplashComponent.
 */
export async function runWithSplash(options: RunWithSplashOptions): Promise<RunWithSplashResult> {
	const {
		title,
		version,
		eventBus,
		terminalWidth,
		loadExtensions,
		quiet = false,
		interactive = true,
		onDismiss,
	} = options;

	// In non-interactive modes, skip splash entirely
	if (!interactive || quiet) {
		const result = await loadExtensions();
		return { result, splash: new SplashComponent(title, version, true), eventCount: 0 };
	}

	// Create splash component before extensions load
	const splash = new SplashComponent(title, version, false);

	// Track progress events
	let eventCount = 0;
	let lastProgress: LoadingProgress | null = null;

	// Subscribe to progress events
	const unsubscribe = eventBus.on("extension_loading_progress", (data: unknown) => {
		const event = data as ExtensionLoadingProgressEvent;
		lastProgress = {
			total: event.total,
			completed: event.completed,
			failed: event.failed,
			pending: event.pending,
			entries: [...event.entries],
		};
		splash.update(lastProgress);
		eventCount++;

		// Render the splash
		const lines = splash.render(terminalWidth);
		if (lines.length > 0) {
			// Output to stderr so it doesn't interfere with stdout-based workflows
			for (const line of lines) {
				process.stderr.write(line + "\n");
			}
		}

		// Check if all extensions are done
		const total = event.total;
		const done = event.completed + event.failed;
		if (total > 0 && done >= total) {
			// Dismiss splash: clear the output
			clearSplash(terminalWidth, lines.length);
			if (onDismiss) onDismiss();
		}
	});

	try {
		// Load extensions (the actual loading function should emit progress events)
		const result = await loadExtensions();

		// If no progress events were received but there were extensions,
		// the loader didn't emit progress — force a final update
		if (eventCount === 0 && lastProgress === null) {
			// Notify that we're done (empty done state)
			splash.update({
				total: 0,
				completed: 0,
				failed: 0,
				pending: 0,
				entries: [],
			});
			const lines = splash.render(terminalWidth);
			if (lines.length > 0) {
				for (const line of lines) {
					process.stderr.write(line + "\n");
				}
			}
			// Immediately dismiss
			clearSplash(terminalWidth, lines.length);
			if (onDismiss) onDismiss();
		}

		return { result, splash, eventCount };
	} finally {
		unsubscribe();
	}
}

/**
 * Clear the splash output by moving cursor up and clearing lines.
 * Fallback: writes empty lines to overwrite.
 */
export function clearSplash(width: number, lineCount: number): void {
	if (lineCount <= 0) return;
	// Move cursor up by lineCount, then clear each line
	for (let i = 0; i < lineCount; i++) {
		// Carriage return + clear line
		process.stderr.write("\r\x1b[K");
		if (i < lineCount - 1) {
			// Move cursor up one line
			process.stderr.write("\x1b[1A");
		}
	}
	// Return cursor to position after cleared area
	process.stderr.write("\r");
}
