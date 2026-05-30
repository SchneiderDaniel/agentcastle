/**
 * Configuration loading and backend resolution for ripgrep-search.
 *
 * Loads SearchConfig from .pi/settings.json, resolves the active backend
 * based on user preference and ripgrep availability.
 */

import type { SearchConfig } from "./types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONFIG: SearchConfig = {
	searchBackend: "auto",
	maxLineLength: 200,
};

const MAX_LINE_LENGTH_MAX = 2000;
const MAX_LINE_LENGTH_DEFAULT = 200;

/**
 * Load search configuration from .pi/settings.json.
 * Falls back to defaults on missing file, parse errors, or missing keys.
 */
export function loadSearchConfig(cwd: string): SearchConfig {
	try {
		const settingsPath = join(cwd, ".pi", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw);
		const search = settings?.search;

		if (!search) return { ...DEFAULT_CONFIG };

		let searchBackend: SearchConfig["searchBackend"] = DEFAULT_CONFIG.searchBackend;
		if (
			search.searchBackend === "ripgrep" ||
			search.searchBackend === "grep" ||
			search.searchBackend === "auto"
		) {
			searchBackend = search.searchBackend;
		}

		let maxLineLength = MAX_LINE_LENGTH_DEFAULT;
		if (
			typeof search.maxLineLength === "number" &&
			Number.isInteger(search.maxLineLength) &&
			search.maxLineLength > 0
		) {
			maxLineLength = Math.min(search.maxLineLength, MAX_LINE_LENGTH_MAX);
		}

		return { searchBackend, maxLineLength };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/**
 * Resolve the active search backend based on user config and rg availability.
 * - "ripgrep": forces ripgrep (returns error string if rg not available)
 * - "grep": forces grep (skips rg detection)
 * - "auto": uses ripgrep if available, grep otherwise
 */
export function resolveBackend(
	config: SearchConfig,
	rgAvailable: boolean,
): { backend: "ripgrep" | "grep"; error?: string } {
	if (config.searchBackend === "ripgrep") {
		if (!rgAvailable) {
			return {
				backend: "ripgrep",
				error:
					"ripgrep not found on PATH. Install rg or set searchBackend to 'auto' or 'grep' in .pi/settings.json.",
			};
		}
		return { backend: "ripgrep" };
	}
	if (config.searchBackend === "grep") {
		return { backend: "grep" };
	}
	// auto
	return { backend: rgAvailable ? "ripgrep" : "grep" };
}

/** Detect if ripgrep is available on PATH. */
export async function ripgrepAvailable(
	exec: (
		command: string,
		args: string[],
		options?: { timeout?: number },
	) => Promise<{
		code: number;
		stdout: string;
		stderr: string;
	}>,
): Promise<boolean> {
	try {
		const result = await exec("rg", ["--version"], { timeout: 3_000 });
		return result.code === 0;
	} catch {
		return false;
	}
}
