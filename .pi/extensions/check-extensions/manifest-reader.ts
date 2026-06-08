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
 * Try to read manifest fields from a JSON file.
 *
 * Checks if the file exists, reads it, parses JSON, and extracts
 * piVersion and testedWithVersion into the provided manifest object.
 * Returns true if the file was successfully read and parsed,
 * false if the file doesn't exist or contains invalid JSON.
 *
 * @param filePath - Path to the JSON file to read
 * @param manifest - Manifest object to populate
 * @returns true if file was read and parsed successfully, false otherwise
 */
export function tryReadManifestFile(filePath: string, manifest: ExtensionManifest): boolean {
	if (!existsSync(filePath)) return false;
	try {
		const content = readFileSync(filePath, "utf-8");
		const data = JSON.parse(content);
		if (data.piVersion) manifest.piVersion = String(data.piVersion);
		if (data.testedWithVersion) manifest.testedWithVersion = String(data.testedWithVersion);
		return true;
	} catch {
		return false;
	}
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
	if (tryReadManifestFile(join(extensionDir, "extension.json"), manifest)) {
		return manifest;
	}

	// Try package.json as fallback
	if (tryReadManifestFile(join(extensionDir, "package.json"), manifest)) {
		return manifest;
	}

	return manifest;
}
