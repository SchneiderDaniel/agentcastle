/**
 * integrate-splash — Wires the splash screen into the pi extension loading pipeline.
 *
 * This module patches `DefaultResourceLoader.prototype.reload` to:
 * 1. Show a loading indicator during extension startup
 * 2. Emit progress events on the eventBus via `ProgressEmitter` after loading
 *
 * Usage:
 *   import { setupSplashIntegration } from "./integrate-splash.js";
 *   setupSplashIntegration();  // patches DefaultResourceLoader before pi starts
 *
 * Architecture:
 *   - The patched reload uses `runReloadWithSplash()` which shows a spinner
 *     during extension loading and emits progress events via `ProgressEmitter`
 *     after extensions have loaded.
 *   - `createReloadWithSplash()` was removed — it was dead code (never imported
 *     from any production path). Use `setupSplashIntegration()` instead.
 *   - `clearSplash()` was moved here from `run-with-splash.ts` (which was removed
 *     along with the dead `runWithSplash()` function).
 */

import { DefaultResourceLoader, VERSION } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { SplashComponent } from "./splash-component.js";
import { ProgressEmitter } from "./progress-emitter.js";
import type { ExtensionLoadingProgressEvent } from "./extension-progress-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Spinner frames for terminal animation
// ─────────────────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Clear the splash output by moving cursor up and clearing lines.
 * Fallback: writes empty lines to overwrite.
 */
export function clearSplash(width: number, lineCount: number): void {
	if (lineCount <= 0) return;
	// Move cursor up through each splash line, clearing as we go
	for (let i = 0; i < lineCount; i++) {
		process.stderr.write("\r\x1b[K\x1b[1A");
	}
	// Clear the line the cursor ends up on (first splash line)
	process.stderr.write("\r\x1b[K");
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper: runs a reload with splash screen and progress emission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a DefaultResourceLoader.reload() with a splash screen and spinner.
 *
 * This is the shared implementation used by `setupSplashIntegration()`. It:
 * 1. Creates a SplashComponent and renders initial lines
 * 2. Starts a spinner animation via setInterval
 * 3. Calls the original reload
 * 4. Stops the spinner
 * 5. Emits progress events via ProgressEmitter on the eventBus
 * 6. Clears the splash output
 *
 * @param this - DefaultResourceLoader instance (bound via .call())
 * @param origReload - The original reload function to wrap
 */
async function runReloadWithSplash(
	this: DefaultResourceLoader,
	origReload: () => Promise<void>,
): Promise<void> {
	const terminalWidth = process.stdout.columns || 80;

	// ── Show splash before loading ──────────────────────────────
	const splash = new SplashComponent("pi", VERSION);
	let splashLines = splash.render(terminalWidth);
	for (const line of splashLines) {
		process.stderr.write(line + "\n");
	}

	// ── Start spinner animation during loading ──────────────────
	let spinnerIdx = 0;
	const spinnerInterval = setInterval(() => {
		const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
		spinnerIdx++;

		const lines = splash.render(terminalWidth);
		// Move up through splash lines, clearing each one
		for (let i = 0; i < splashLines.length; i++) {
			process.stderr.write("\r\x1b[K\x1b[1A");
		}
		// Clear the line the cursor ends up on (first splash line)
		process.stderr.write("\r\x1b[K");
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
		// ── Call original reload (extensions load internally) ────
		await origReload.call(this);

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
			if (!extEntries.some((e) => e.name === name)) {
				extEntries.push({ name, path: err.path });
			}
		}

		// ── Emit progress events on the eventBus ────────────────
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

		// ── Clear the spinner/splash lines ───────────────────────
		clearSplash(terminalWidth, splashLines.length);
	} catch (error) {
		clearInterval(spinnerInterval);
		clearSplash(terminalWidth, splashLines.length);
		throw error;
	}
}

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
		await runReloadWithSplash.call(this, origReload);
		// Return undefined — the original reload always returns void (Promise<void>)
	};
}
