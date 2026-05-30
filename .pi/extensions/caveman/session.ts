/**
 * Session-level resolver — pure function, no side effects
 *
 * Extracts session-start decision into pure function so it's
 * testable without mock infrastructure. Part of use-case layer.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Level, CavemanConfig } from "./types.ts";
import { LEVELS } from "./types.ts";

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
	for (const entry of sessionEntries) {
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
 * Reset caveman level to "off" on session shutdown.
 * Prevents stale state from leaking across sessions.
 */
export function resetSessionLevel(_currentLevel: Level): Level {
	return "off";
}
