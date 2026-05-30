/**
 * ranked-map — Cache management
 *
 * Pure module — no pi SDK imports. Sync file I/O for cache read/write.
 * Read cache from disk, validate HEAD match, return parsed index or null.
 */

import { existsSync, readFileSync } from "node:fs";
import type { CachedIndex, SymbolEntry } from "./types.ts";

/**
 * Load cached index from disk.
 * Returns null if cache missing, malformed, HEAD mismatch, or missing required keys.
 */
export function loadCachedIndex(cachePath: string, currentHead: string): CachedIndex | null {
	try {
		if (!existsSync(cachePath)) return null;
		const raw = readFileSync(cachePath, "utf-8");
		const parsed = JSON.parse(raw);

		if (!parsed || typeof parsed !== "object") return null;
		if (typeof parsed.head !== "string") return null;
		if (typeof parsed.builtAt !== "number") return null;
		if (!parsed.symbols || typeof parsed.symbols !== "object") return null;

		// HEAD mismatch → stale
		if (parsed.head !== currentHead) return null;

		return {
			head: parsed.head,
			builtAt: parsed.builtAt,
			symbols: parsed.symbols as Record<string, SymbolEntry[]>,
		};
	} catch {
		return null;
	}
}
