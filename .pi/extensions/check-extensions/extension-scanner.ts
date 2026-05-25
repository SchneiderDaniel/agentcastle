/**
 * extension-scanner — Scan .pi/extensions/ directories for API usage
 *
 * Globs .ts files in extension directories, greps for pi./ctx. patterns.
 * Returns Finding[] keyed by extension name.
 */

import { readdirSync, statSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join, basename, dirname } from "node:path";

export interface Finding {
	extensionName: string;
	file: string;
	apiName: string;
	line: number;
	lineContent: string;
	changelogVersion: string;
	isBreaking: boolean;
	category: string;
}

export interface ScanningResult {
	findings: Finding[];
	skipCount: number;
}

/**
 * Default patterns to search for in extension files.
 * Maps human-readable API name → raw text pattern.
 */
export const DEFAULT_PATTERNS: Record<string, string> = {
	"pi.on": "pi.on(",
	"pi.registerCommand": "pi.registerCommand(",
	"pi.registerTool": "pi.registerTool(",
	"pi.exec": "pi.exec(",
	"pi.sendUserMessage": "pi.sendUserMessage(",
	"ctx.ui": "ctx.ui.",
	"ctx.sessionManager": "ctx.sessionManager.",
	"ctx.abort": "ctx.abort(",
	"pi.registerFlag": "pi.registerFlag(",
	"pi.registerShortcut": "pi.registerShortcut(",
	"pi.getFlag": "pi.getFlag(",
	"pi.setActiveTools": "pi.setActiveTools(",
	"pi.sendMessage": "pi.sendMessage(",
	"pi.appendEntry": "pi.appendEntry(",
	"pi.setSessionName": "pi.setSessionName(",
};

/**
 * Scan a directory of extensions for API usage patterns.
 *
 * @param extensionsDir - Path to the .pi/extensions/ directory
 * @param apiNames - Array of API names to search for (e.g. "pi.on", "pi.exec")
 * @returns ScanningResult with findings and skip count
 */
export function scanExtensions(extensionsDir: string, apiNames: string[]): ScanningResult {
	const findings: Finding[] = [];
	let skipCount = 0;

	if (!existsSync(extensionsDir)) {
		return { findings, skipCount };
	}

	// Build search patterns from requested API names
	const searchPatterns: Array<{ apiName: string; pattern: string }> = [];
	for (const name of apiNames) {
		const pattern = DEFAULT_PATTERNS[name];
		if (pattern) {
			searchPatterns.push({ apiName: name, pattern });
		} else {
			// Fallback: use the name itself as a search pattern
			searchPatterns.push({ apiName: name, pattern: name });
		}
	}

	// Read extension directories
	let entries: Dirent[];
	try {
		entries = readdirSync(extensionsDir, { withFileTypes: true });
	} catch {
		return { findings, skipCount };
	}

	// Collect all .ts files from extension directories
	const tsFiles: Array<{ dirName: string; filePath: string }> = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".")) continue;

		const extDir = join(extensionsDir, entry.name);

		// Read files in this extension directory
		let files: string[];
		try {
			files = readdirSync(extDir);
		} catch {
			skipCount++;
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".ts")) continue;
			tsFiles.push({
				dirName: entry.name,
				filePath: join(extDir, file),
			});
		}
	}

	// Also check top-level .ts files in extensions root
	let rootFiles: string[];
	try {
		rootFiles = readdirSync(extensionsDir).filter((f) => f.endsWith(".ts") && !f.startsWith("."));
	} catch {
		rootFiles = [];
	}
	for (const file of rootFiles) {
		tsFiles.push({
			dirName: file.replace(/\.ts$/, ""),
			filePath: join(extensionsDir, file),
		});
	}

	// Scan each file for patterns
	for (const { dirName, filePath } of tsFiles) {
		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			skipCount++;
			continue;
		}

		const lines = content.split("\n");

		for (const { apiName, pattern } of searchPatterns) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i]!;
				if (line.includes(pattern)) {
					findings.push({
						extensionName: dirName,
						file: filePath,
						apiName,
						line: i + 1,
						lineContent: line.trim(),
						changelogVersion: "",
						isBreaking: false,
						category: "",
					});
				}
			}
		}
	}

	return { findings, skipCount };
}
