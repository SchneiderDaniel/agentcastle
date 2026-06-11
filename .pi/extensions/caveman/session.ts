/**
 * Session-level resolver — pure function, no side effects
 *
 * Extracts session-start decision into pure function so it's
 * testable without mock infrastructure. Part of use-case layer.
 */

import type { Level, CavemanConfig } from "./types.ts";
import { LEVELS } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Shape of session entries that resolveSessionLevel inspects.
 *
 * Accepts a broader type than the pi agent's SessionEntry union so that
 * callers (index.ts) can pass ctx.sessionManager.getEntries() directly
 * without a cast. The function only accesses .type, .customType, and .data,
 * narrowing at runtime to entries matching its contract.
 */
export type SessionEntry = {
	type: string;
	customType?: string;
	data?: unknown;
};

export interface ResolvedSessionLevel {
	level: Level;
	shouldAppendEntry: boolean;
}

// ---------------------------------------------------------------------------
// Resolve session level
// ---------------------------------------------------------------------------

/**
 * Determine the caveman level for the current session based on config
 * and any persisted session entries.
 *
 * @param config — current caveman config (with defaultLevel)
 * @param sessionEntries — entries from session manager
 * @returns resolved level and whether to log an entry
 */
export function resolveSessionLevel(
	config: CavemanConfig,
	sessionEntries: SessionEntry[],
): ResolvedSessionLevel {
	// Check for session-level override first (resuming a session)
	// Iterate backward to find the MOST RECENT caveman-level entry (fixes bug #475)
	for (let i = sessionEntries.length - 1; i >= 0; i--) {
		const entry = sessionEntries[i];
		if (entry.type === "custom" && entry.customType === "caveman-level") {
			const data = entry.data;
			if (
				typeof data === "object" &&
				data !== null &&
				"level" in data &&
				typeof data.level === "string" &&
				LEVELS.includes(data.level as Level)
			) {
				return { level: data.level as Level, shouldAppendEntry: false };
			}
		}
	}

	// New session — apply default from config
	const level = config.defaultLevel;
	const shouldAppendEntry = level !== "off";
	return { level, shouldAppendEntry };
}

// ---------------------------------------------------------------------------
// Reset session level on shutdown
// ---------------------------------------------------------------------------

/**
 * Gate whether to append a caveman-level entry based on project trust.
 *
 * Prevents extension state from leaking into untrusted sessions where
 * session entries are visible to the LLM during context assembly.
 *
 * @returns true only when both conditions are met
 */
export function shouldAppendCavemanEntry(shouldAppendEntry: boolean, isTrusted: boolean): boolean {
	return shouldAppendEntry && isTrusted;
}

/**
 * Reset caveman level to "off" on session shutdown.
 * Prevents stale state from leaking across sessions.
 */
export function resetSessionLevel(_currentLevel: Level): Level {
	return "off";
}
