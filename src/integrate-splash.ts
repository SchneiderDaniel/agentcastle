/**
 * integrate-splash — Wires the splash screen into the pi extension loading pipeline.
 *
 * This module patches `DefaultResourceLoader.prototype.reload` to:
 * 1. Show a loading indicator during extension startup
 * 2. Emit progress events on the eventBus via `ProgressEmitter` after loading
 * 3. Allow any subscriber (e.g., `runWithSplash`) to consume these events
 *
 * Usage:
 *   import { setupSplashIntegration } from "./integrate-splash.js";
 *   setupSplashIntegration();  // patches DefaultResourceLoader before pi starts
 *
 * Architecture:
 *   - The patched reload emits progress events on `this.eventBus` AFTER extensions
 *     have loaded (since the internal `loadExtensions()` is in node_modules and
 *     can't be modified to emit per-extension progress).
 *   - A simple spinner animation runs during loading so the terminal doesn't
 *     appear frozen.
 *   - After loading, `ProgressEmitter` emits events showing final extension states.
 *   - These events can be consumed by `runWithSplash()` or other eventBus subscribers.
 */

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { SplashComponent } from "./splash-component.js";
import { clearSplash } from "./run-with-splash.js";
import { ProgressEmitter } from "./progress-emitter.js";
import type { ExtensionLoadingProgressEvent, LoadingProgress } from "./extension-progress-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Spinner frames for terminal animation
// ─────────────────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Call this before pi startup to patch the resource loader with splash support.
 *
 * After calling this, `DefaultResourceLoader.prototype.reload` will:
 * - Show a spinner during extension loading
 * - Emit `extension_loading_progress` events on the eventBus after loading
 * - Track extension results via ProgressEmitter
 */
export function setupSplashIntegration(): void {
	const origReload = DefaultResourceLoader.prototype.reload;

	DefaultResourceLoader.prototype.reload = async function () {
		const terminalWidth = process.stdout.columns || 80;

		// ── Show splash before loading ──────────────────────────────
		const splash = new SplashComponent("pi", "0.74.0");
		let splashLines = splash.render(terminalWidth);
		for (const line of splashLines) {
			process.stderr.write(line + "\n");
		}

		// ── Start spinner animation during loading ──────────────────
		let spinnerIdx = 0;
		const spinnerInterval = setInterval(() => {
			// Re-render splash over previous output using ANSI
			const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
			spinnerIdx++;

			// Redraw the splash with a spinner indicator
			const lines = splash.render(terminalWidth);
			// Move cursor up by previous line count
			for (let i = 0; i < splashLines.length; i++) {
				process.stderr.write("\r\x1b[K");
				if (i < splashLines.length - 1) {
					process.stderr.write("\x1b[1A");
				}
			}
			// Write updated lines with spinner frame in the last line
			const updatedLines = [...lines];
			if (updatedLines.length > 0) {
				// Add spinner to the loading line
				const loadingLineIdx = updatedLines.findIndex((l) => l.includes("Loading"));
				if (loadingLineIdx >= 0) {
					updatedLines[loadingLineIdx] = `  ${frame} ${updatedLines[loadingLineIdx].trim()}`;
				}
			}
			for (const line of updatedLines) {
				process.stderr.write(line + "\n");
			}
			splashLines = updatedLines;
		}, 120);

		try {
			// ── Call original reload (extensions load internally) ────
			const result = await origReload.call(this);

			// ── Stop spinner ─────────────────────────────────────────
			clearInterval(spinnerInterval);

			// ── Get extension paths from the results ─────────────────
			const extEntries: Array<{ name: string; path: string }> = [];

			for (const ext of this.extensionsResult.extensions) {
				const name = path.basename(ext.path);
				extEntries.push({ name, path: ext.path });
			}
			for (const err of this.extensionsResult.errors) {
				const name = path.basename(err.path);
				// Avoid duplicates if same path appears in both arrays
				if (!extEntries.some((e) => e.name === name)) {
					extEntries.push({ name, path: err.path });
				}
			}

			// ── Emit progress events on the eventBus ────────────────
			if (extEntries.length > 0) {
				const emitter = new ProgressEmitter(extEntries);

				// Subscribe emitter to broadcast on the eventBus
				emitter.onProgress((event: ExtensionLoadingProgressEvent) => {
					this.eventBus.emit("extension_loading_progress", event);
				});

				// First mark all as "loading"
				for (const entry of extEntries) {
					emitter.emitProgress(entry.name, "loading");
				}

				// Then mark as done/failed based on actual results
				for (const ext of this.extensionsResult.extensions) {
					const name = path.basename(ext.path);
					emitter.emitProgress(name, "done");
				}
				for (const err of this.extensionsResult.errors) {
					const name = path.basename(err.path);
					emitter.emitProgress(name, "failed", err.error);
				}
			}

			// ── Update splash with final progress and dismiss ────────
			// Clear the spinner/splash lines
			clearSplash(terminalWidth, splashLines.length);

			return result;
		} catch (error) {
			clearInterval(spinnerInterval);
			clearSplash(terminalWidth, splashLines.length);
			throw error;
		}
	};
}

/**
 * Creates a wrapped version of `DefaultResourceLoader.prototype.reload` that
 * shows a splash screen during extension loading and emits progress events.
 *
 * Unlike `setupSplashIntegration()` which mutates the prototype globally,
 * this returns a standalone reload function that can be used directly.
 *
 * @param origReload - The original reload function to wrap.
 * @returns A wrapped reload function with splash integration.
 */
export function createReloadWithSplash(origReload: () => Promise<void>): () => Promise<void> {
	return async function (this: InstanceType<typeof DefaultResourceLoader>) {
		const terminalWidth = process.stdout.columns || 80;

		// ── Show splash before loading ──────────────────────────────
		const splash = new SplashComponent("pi", "0.74.0");
		let splashLines = splash.render(terminalWidth);
		for (const line of splashLines) {
			process.stderr.write(line + "\n");
		}

		// ── Start spinner ───────────────────────────────────────────
		let spinnerIdx = 0;
		const spinnerInterval = setInterval(() => {
			const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
			spinnerIdx++;

			const lines = splash.render(terminalWidth);
			for (let i = 0; i < splashLines.length; i++) {
				process.stderr.write("\r\x1b[K");
				if (i < splashLines.length - 1) {
					process.stderr.write("\x1b[1A");
				}
			}
			const updatedLines = [...lines];
			if (updatedLines.length > 0) {
				const loadingLineIdx = updatedLines.findIndex((l) => l.includes("Loading"));
				if (loadingLineIdx >= 0) {
					updatedLines[loadingLineIdx] = `  ${frame} ${updatedLines[loadingLineIdx].trim()}`;
				}
			}
			for (const line of updatedLines) {
				process.stderr.write(line + "\n");
			}
			splashLines = updatedLines;
		}, 120);

		try {
			// Call the original reload
			await origReload.call(this);

			clearInterval(spinnerInterval);

			// ── Emit progress events ────────────────────────────────
			const extEntries: Array<{ name: string; path: string }> = [];
			for (const ext of this.extensionsResult.extensions) {
				const name = path.basename(ext.path);
				if (!extEntries.some((e) => e.name === name)) {
					extEntries.push({ name, path: ext.path });
				}
			}
			for (const err of this.extensionsResult.errors) {
				const name = path.basename(err.path);
				if (!extEntries.some((e) => e.name === name)) {
					extEntries.push({ name, path: err.path });
				}
			}

			if (extEntries.length > 0) {
				const emitter = new ProgressEmitter(extEntries);
				emitter.onProgress((event: ExtensionLoadingProgressEvent) => {
					this.eventBus.emit("extension_loading_progress", event);
				});

				for (const entry of extEntries) {
					emitter.emitProgress(entry.name, "loading");
				}
				for (const ext of this.extensionsResult.extensions) {
					const name = path.basename(ext.path);
					emitter.emitProgress(name, "done");
				}
				for (const err of this.extensionsResult.errors) {
					const name = path.basename(err.path);
					emitter.emitProgress(name, "failed", err.error);
				}
			}

			clearSplash(terminalWidth, splashLines.length);
		} catch (error) {
			clearInterval(spinnerInterval);
			clearSplash(terminalWidth, splashLines.length);
			throw error;
		}
	};
}
