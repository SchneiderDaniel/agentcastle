/**
 * ranked-map — Configuration loading
 *
 * Loads and validates rankedMap config from .pi/settings.json.
 * Pure module — no pi SDK imports. Zero async I/O dependencies.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RankedMapConfig } from "./types.ts";

/** Default configuration values when settings.json is missing or partial. */
export const DEFAULT_CONFIG: RankedMapConfig = {
	tokenBudget: 4096,
	recencyWindowDays: 30,
	cacheTtlHours: 24,
	autoThreshold: 20000,
	weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
};

/** Maximum allowed recency window in days. */
export const MAX_RECENCY_WINDOW_DAYS = 365;

/**
 * Load ranked map configuration from .pi/settings.json.
 * Falls back to defaults on missing file, parse errors, or missing keys.
 */
export function loadRankedMapConfig(cwd: string): RankedMapConfig {
	try {
		const settingsPath = join(cwd, ".pi", "settings.json");
		const raw = readFileSync(settingsPath, "utf-8");
		const settings = JSON.parse(raw);
		const rm = settings?.rankedMap;

		if (!rm) return { ...DEFAULT_CONFIG };

		let tokenBudget = DEFAULT_CONFIG.tokenBudget;
		if (
			typeof rm.tokenBudget === "number" &&
			Number.isFinite(rm.tokenBudget) &&
			Number.isInteger(rm.tokenBudget) &&
			rm.tokenBudget > 0
		) {
			tokenBudget = rm.tokenBudget;
		}

		let recencyWindowDays = DEFAULT_CONFIG.recencyWindowDays;
		if (
			typeof rm.recencyWindowDays === "number" &&
			Number.isFinite(rm.recencyWindowDays) &&
			Number.isInteger(rm.recencyWindowDays) &&
			rm.recencyWindowDays > 0
		) {
			recencyWindowDays = Math.min(rm.recencyWindowDays, MAX_RECENCY_WINDOW_DAYS);
		}

		let autoThreshold = DEFAULT_CONFIG.autoThreshold;
		if (
			typeof rm.autoThreshold === "number" &&
			Number.isFinite(rm.autoThreshold) &&
			Number.isInteger(rm.autoThreshold) &&
			rm.autoThreshold >= 0
		) {
			autoThreshold = rm.autoThreshold;
		}

		let cacheTtlHours = DEFAULT_CONFIG.cacheTtlHours;
		if (
			typeof rm.cacheTtlHours === "number" &&
			Number.isFinite(rm.cacheTtlHours) &&
			rm.cacheTtlHours > 0
		) {
			cacheTtlHours = rm.cacheTtlHours;
		}

		let kwWeight = DEFAULT_CONFIG.weights.keyword;
		let recWeight = DEFAULT_CONFIG.weights.recency;
		let fsWeight: number = DEFAULT_CONFIG.weights.fileSize ?? 0;

		if (rm.weights && typeof rm.weights === "object") {
			const w = rm.weights;

			if (
				typeof w.keyword === "number" &&
				Number.isFinite(w.keyword) &&
				w.keyword >= 0 &&
				w.keyword <= 1
			) {
				kwWeight = w.keyword;
			}

			if (
				typeof w.recency === "number" &&
				Number.isFinite(w.recency) &&
				w.recency >= 0 &&
				w.recency <= 1
			) {
				recWeight = w.recency;
			}

			// When fileSize is explicitly present, validate it.
			// When absent from the weights object, default to 0 to avoid
			// surprising normalization of user-provided keyword+recency weights.
			if ("fileSize" in w) {
				if (
					typeof w.fileSize === "number" &&
					Number.isFinite(w.fileSize) &&
					w.fileSize >= 0 &&
					w.fileSize <= 1
				) {
					fsWeight = w.fileSize;
				} else {
					// Present but invalid — fall back to default
					fsWeight = DEFAULT_CONFIG.weights.fileSize ?? 0.2;
				}
			} else {
				// Not present in weights object — default to 0
				fsWeight = 0;
			}

			const sum = kwWeight + recWeight + fsWeight;
			if (sum > 1) {
				kwWeight = kwWeight / sum;
				recWeight = recWeight / sum;
				fsWeight = fsWeight / sum;
			}
		}

		return {
			tokenBudget,
			recencyWindowDays,
			cacheTtlHours,
			autoThreshold,
			weights: { keyword: kwWeight, recency: recWeight, fileSize: fsWeight },
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
