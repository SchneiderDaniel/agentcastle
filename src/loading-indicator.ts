/**
 * loading-indicator — Shows a simple status line during extension loading.
 *
 * Usage:
 *   import { setupLoadingIndicator } from "./loading-indicator.js";
 *   setupLoadingIndicator();  // patches DefaultResourceLoader before pi starts
 *
 * Output (single line on stderr):
 *   loading extensions...          ← during load
 *   ✓ 12 loaded                    ← after load (same line, overwritten)
 *   ✗ extension load failed        ← on error
 */

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * Patch DefaultResourceLoader.prototype.reload to show a status line.
 * Call before pi's main().
 */
export function setupLoadingIndicator(): void {
	const origReload = DefaultResourceLoader.prototype.reload;

	DefaultResourceLoader.prototype.reload = async function () {
		process.stderr.write("loading extensions...\n");
		try {
			await origReload.call(this);

			const count = this.extensionsResult.extensions.length;
			const errors = this.extensionsResult.errors.length;
			const icon = errors > 0 ? "⚠" : "✓";
			const suffix = errors > 0 ? ` (${errors} failed)` : "";
			process.stderr.write(`\r\x1b[K${icon} ${count} loaded${suffix}\n`);
		} catch (e) {
			process.stderr.write("\r\x1b[K✗ extension load failed\n");
			throw e;
		}
	};
}
