/**
 * In-memory result cache for ripgrep-search.
 *
 * Caches search results keyed by normalized query+directory tuple.
 * Cache is cleared on session_shutdown.
 * Supports max-entries eviction (FIFO).
 */

import type { RgResult } from "./types.ts";

/** Cache entry stored for each unique query+directory */
export interface CacheEntry {
	result: RgResult;
	rawStdout: string;
}

/** @internal Exported for testability */
export const resultCache = new Map<string, CacheEntry>();

const MAX_CACHE_ENTRIES = 100;

/** Normalize a directory path for consistent cache keying. */
function normalizeDirectory(dir: string): string {
	return dir.replace(/\/+$/, "").replace(/^\.\//, "") || ".";
}

/** Build a cache key from query and directory (normalizes the directory). */
export function buildCacheKey(query: string, directory: string): string {
	return `${query}::${normalizeDirectory(directory)}`;
}

/** Look up a cached search result. Returns undefined on miss. */
export function getCachedResult(query: string, directory: string): CacheEntry | undefined {
	return resultCache.get(buildCacheKey(query, directory));
}

/**
 * Store a search result in the cache.
 * Evicts oldest entry (by insertion order) when at max capacity and key is new.
 */
export function setCachedResult(query: string, directory: string, entry: CacheEntry): void {
	const key = buildCacheKey(query, directory);

	// If at max capacity and this is a new key, evict oldest by insertion order
	if (resultCache.size >= MAX_CACHE_ENTRIES && !resultCache.has(key)) {
		const oldestKey = resultCache.keys().next().value;
		if (oldestKey !== undefined) {
			resultCache.delete(oldestKey);
		}
	}

	resultCache.set(key, entry);
}

/** Clear all cached results (called on session_shutdown). */
export function clearCache(): void {
	resultCache.clear();
}

/** Get the current number of cached entries. */
export function getCacheSize(): number {
	return resultCache.size;
}
