/**
 * Settings loader for LSP Auditor.
 *
 * Sync I/O (readFileSync/existsSync) acceptable — only called once per
 * audit start, not on hot path.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export interface LspAuditorSettings {
	servers?: Array<{
		extensions: string[];
		command: string;
		args?: string[];
		severityThreshold?: string;
	}>;
}

export interface PiSettings {
	supervisor?: unknown;
	lspAuditor?: LspAuditorSettings;
}

// ─── Reader ──────────────────────────────────────────────────────────

/**
 * Read and parse .pi/settings.json from the worktree.
 * Returns null if file doesn't exist or is unparseable.
 */
export function readSettings(worktreePath: string): PiSettings | null {
	try {
		const settingsPath = resolvePath(worktreePath, ".pi/settings.json");
		if (!existsSync(settingsPath)) return null;
		return JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return null;
	}
}
