/**
 * manifest-reader — Read extension manifest files for pi version info
 *
 * Reads optional extension.json or package.json from extension directories.
 * Falls back to UNKNOWN when no manifest found.
 *
 * Infrastructure layer — filesystem I/O.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Extension manifest with pi version info */
export interface ExtensionManifest {
	/** pi SDK version this extension is built for */
	piVersion: string;
	/** pi SDK version the extension was last tested against */
	testedWithVersion: string;
}

/**
 * Read extension manifest from a directory.
 * Checks extension.json first, then package.json as fallback.
 *
 * @param extensionDir - Path to the extension directory
 * @returns ExtensionManifest with piVersion and testedWithVersion
 *          (both default to "UNKNOWN" if not found)
 */
export function readManifest(extensionDir: string): ExtensionManifest {
	const manifest: ExtensionManifest = {
		piVersion: "UNKNOWN",
		testedWithVersion: "UNKNOWN",
	};

	// Try extension.json first
	const extJsonPath = join(extensionDir, "extension.json");
	if (existsSync(extJsonPath)) {
		try {
			const content = readFileSync(extJsonPath, "utf-8");
			const data = JSON.parse(content);
			if (data.piVersion) manifest.piVersion = String(data.piVersion);
			if (data.testedWithVersion) manifest.testedWithVersion = String(data.testedWithVersion);
			return manifest;
		} catch {
			// Invalid JSON — fall through to package.json
		}
	}

	// Try package.json as fallback
	const pkgJsonPath = join(extensionDir, "package.json");
	if (existsSync(pkgJsonPath)) {
		try {
			const content = readFileSync(pkgJsonPath, "utf-8");
			const data = JSON.parse(content);
			if (data.piVersion) manifest.piVersion = String(data.piVersion);
			if (data.testedWithVersion) manifest.testedWithVersion = String(data.testedWithVersion);
			return manifest;
		} catch {
			// Invalid JSON — return defaults
		}
	}

	return manifest;
}
