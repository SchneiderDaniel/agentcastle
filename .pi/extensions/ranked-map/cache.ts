/**
 * ranked-map — Cache management
 *
 * Pure module — no pi SDK imports. Sync file I/O for cache read/write.
 * Read cache from disk, validate HEAD match, return parsed index or null.
 */

import { existsSync, readFileSync } from "node:fs";
import type { CachedIndex, RankedMapConfig, SymbolEntry } from "./types.ts";

/**
 * Compute a deterministic hash from config values for cache invalidation.
 *
 * Serializes only the numeric/config fields (not builtAt or other timestamps)
 * to produce a stable hash that changes when any config value changes.
 */
export function computeConfigHash(config: RankedMapConfig): string {
	const fields = {
		tokenBudget: config.tokenBudget,
		recencyWindowDays: config.recencyWindowDays,
		cacheTtlHours: config.cacheTtlHours,
		autoThreshold: config.autoThreshold,
		wKw: config.weights.keyword,
		wRec: config.weights.recency,
		wFs: config.weights.fileSize ?? 0,
	};
	const str = JSON.stringify(fields, Object.keys(fields).sort());
	// Simple djb2 hash
	let hash = 5381;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(16);
}

/**
 * Load cached index from disk.
 * Returns null if cache missing, malformed, HEAD mismatch, configHash mismatch, targetDir mismatch,
 * or missing required keys.
 *
 * @param cachePath - Path to cached index file
 * @param currentHead - Current git HEAD for staleness check
 * @param configHash - Optional config hash. When provided and cached index has configHash,
 *                     mismatch invalidates the cache. Absent configHash in cached index is
 *                     accepted for backward compatibility.
 * @param targetDir - Optional target directory for cache scope validation.
 *                    When provided and cached index has targetDir, they must match exactly.
 *                    Absent targetDir in cached index is accepted for backward compatibility.
 *                    When omitted, no targetDir validation is performed.
 */
export function loadCachedIndex(
	cachePath: string,
	currentHead: string,
	configHash?: string,
	targetDir?: string,
): CachedIndex | null {
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

		// configHash mismatch → stale (if both present)
		if (
			configHash !== undefined &&
			parsed.configHash !== undefined &&
			parsed.configHash !== configHash
		) {
			return null;
		}

		// targetDir mismatch → stale (if both present, must match exactly)
		if (
			targetDir !== undefined &&
			parsed.targetDir !== undefined &&
			parsed.targetDir !== targetDir
		) {
			return null;
		}

		return {
			head: parsed.head,
			builtAt: parsed.builtAt,
			symbols: parsed.symbols as Record<string, SymbolEntry[]>,
			configHash: typeof parsed.configHash === "string" ? parsed.configHash : undefined,
			targetDir: typeof parsed.targetDir === "string" ? parsed.targetDir : undefined,
		};
	} catch {
		return null;
	}
}
