/**
 * harness-state.ts — In-memory runtime state for agent-harness
 *
 * Read cache, error tracker, call counter.
 * Factory pattern: createHarnessState() produces isolated instance per session.
 * No globals, no singletons.
 *
 * Used by:
 *  - agent-harness extension handlers (pi.on("tool_call"))
 */

// ── Types ──

export interface CacheEntry {
	content: string;
	turn: number;
	timestamp: number;
}

export interface ErrorEntry {
	turn: number;
	toolName: string;
	/** Optional error detail/message. */
	message?: string;
}

export interface ConsecutiveInfo {
	toolName: string;
	count: number;
	sinceTurn: number;
}

export interface ReadCache {
	/** Get cached entry. Returns null on miss or TTL expiry. */
	get(key: string, currentTurn: number): CacheEntry | null;
	/** Set cached entry with current turn and timestamp. */
	set(key: string, content: string, turn: number): void;
	/** Clear all cache entries. */
	clear(): void;
}

export interface ErrorTracker {
	/** Push a new error for a tool. Evicts oldest if over MAX_ERRORS_PER_TOOL. */
	push(toolName: string, entry: ErrorEntry): void;
	/** Get last N errors for a tool (up to MAX_ERRORS_PER_TOOL). */
	getLastErrors(toolName: string): ErrorEntry[];
	/** Clear all error entries. */
	clear(): void;
}

export interface CallCounter {
	/**
	 * Record a tool call. Resets consecutive count if composite key changes.
	 * Composite key = toolName:subKey (when subKey provided) or just toolName.
	 * Different subKey within same tool resets the counter.
	 */
	record(toolName: string, turn: number, subKey?: string): void;
	/**
	 * Get consecutive call info for a composite key.
	 * Returns count 0 if composite key doesn't match the last recorded key.
	 */
	getConsecutive(toolName: string, subKey?: string): ConsecutiveInfo;
	/** Reset all counters. */
	reset(): void;
}

export interface HarnessState {
	readCache: ReadCache;
	errorTracker: ErrorTracker;
	callCounter: CallCounter;
	/**
	 * Current turn counter for cache TTL, error tracking, cascade detection.
	 * Incremented on each tool_call event handled by the extension.
	 */
	currentTurn: number;
}

// ── Constants ──

import { CACHE_TTL_TURNS } from "./harness-rules.ts";
const MAX_ERRORS_PER_TOOL = 3;

// ── Factory ──

/**
 * Create a fresh, isolated harness state instance.
 * Each agent session gets its own state via this factory.
 */
export function createHarnessState(): HarnessState {
	// ── Read Cache ──

	const cacheMap = new Map<string, CacheEntry>();

	const readCache: ReadCache = {
		get(key: string, currentTurn: number): CacheEntry | null {
			const entry = cacheMap.get(key);
			if (!entry) return null;

			const turnDiff = currentTurn - entry.turn;
			if (turnDiff >= CACHE_TTL_TURNS) {
				cacheMap.delete(key);
				return null;
			}

			return entry;
		},

		set(key: string, content: string, turn: number): void {
			cacheMap.set(key, {
				content,
				turn,
				timestamp: Date.now(),
			});
		},

		clear(): void {
			cacheMap.clear();
		},
	};

	// ── Error Tracker ──

	const errorMap = new Map<string, ErrorEntry[]>();

	const errorTracker: ErrorTracker = {
		push(toolName: string, entry: ErrorEntry): void {
			let errors = errorMap.get(toolName);
			if (!errors) {
				errors = [];
				errorMap.set(toolName, errors);
			}
			errors.push(entry);
			// Evict oldest if over limit
			if (errors.length > MAX_ERRORS_PER_TOOL) {
				errors.shift();
			}
		},

		getLastErrors(toolName: string): ErrorEntry[] {
			return errorMap.get(toolName) ?? [];
		},

		clear(): void {
			errorMap.clear();
		},
	};

	// ── Call Counter ──

	let lastKey: string | null = null;
	let consecutiveCount = 0;
	let sinceTurn = 0;

	/** Build composite key from toolName and optional subKey. */
	function makeKey(toolName: string, subKey?: string): string {
		return subKey !== undefined ? `${toolName}\x00${subKey}` : toolName;
	}

	const callCounter: CallCounter = {
		record(toolName: string, turn: number, subKey?: string): void {
			const key = makeKey(toolName, subKey);
			if (key !== lastKey) {
				// Composite key changed — reset counter
				lastKey = key;
				consecutiveCount = 1;
				sinceTurn = turn;
			} else {
				consecutiveCount++;
			}
		},

		getConsecutive(toolName: string, subKey?: string): ConsecutiveInfo {
			const key = makeKey(toolName, subKey);
			if (key !== lastKey) {
				return { toolName: "", count: 0, sinceTurn: 0 };
			}
			return {
				toolName,
				count: consecutiveCount,
				sinceTurn,
			};
		},

		reset(): void {
			lastKey = null;
			consecutiveCount = 0;
			sinceTurn = 0;
		},
	};

	return { readCache, errorTracker, callCounter, currentTurn: 0 };
}
