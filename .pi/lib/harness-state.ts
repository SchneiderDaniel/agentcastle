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
	/** Batch ID for parallel call grouping (optional). */
	batchId?: number;
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
	get(key: string, currentTurn: number, currentBatchId?: number): CacheEntry | null;
	/** Set cached entry with current turn and timestamp. */
	set(key: string, content: string, turn: number, batchId?: number): void;
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
	/**
	 * Decay errors: remove 1 oldest error entry per tool.
	 * Called at each turn boundary alongside callCounter.turnBoundaryReset().
	 * Enables auto-recovery: after 2 turns without errors, a tool with 2 errors
	 * decays to 0 and is unblocked.
	 */
	decay(): void;
}

export interface CallCounter {
	/**
	 * Record a tool call. Resets consecutive count if composite key changes.
	 * Composite key = toolName:subKey (when subKey provided) or just toolName.
	 * Different subKey within same tool resets the counter.
	 *
	 * @param toolName - name of the tool being called
	 * @param sessionTurn - current session turn number (for sinceTurn tracking)
	 * @param _toolCallIndex - current tool call index (unused internally, for API symmetry)
	 * @param subKey - optional sub-key for sub-command-aware cascade
	 */
	record(toolName: string, sessionTurn: number, _toolCallIndex: number, subKey?: string): void;
	/**
	 * Get consecutive call info for a composite key.
	 * Returns count 0 if composite key doesn't match the last recorded key.
	 */
	getConsecutive(toolName: string, subKey?: string): ConsecutiveInfo;
	/** Reset all counters. */
	reset(): void;
	/**
	 * Reset consecutive count on turn boundary.
	 * Clears lastKey so the next record() starts a fresh consecutive chain.
	 * Does NOT affect toolCallIndex (cache TTL) — only resets cascade state.
	 */
	turnBoundaryReset(): void;
}

export interface HarnessState {
	readCache: ReadCache;
	errorTracker: ErrorTracker;
	callCounter: CallCounter;
	/**
	 * Tool call index for cache TTL and error tracking.
	 * Incremented on each tool_call event handled by the extension.
	 * Monotonic — never reset by turn boundaries.
	 */
	toolCallIndex: number;
	/**
	 * Session turn number (conversation response cycle).
	 * Incremented by turn_start handler.
	 * Used for cascade detection (sinceTurn tracking).
	 */
	sessionTurn: number;
	/**
	 * Batch ID for parallel call detection.
	 * Set by session manager before dispatching parallel calls.
	 * When undefined, falls back to toolCallIndex (backward compat).
	 */
	batchId?: number;
}

// ── Constants ──

import { CACHE_TTL_TURNS } from "./harness-rules.ts";
const MAX_ERRORS_PER_TOOL = 3;

/** Time-based TTL for cache entries (in ms). 30 seconds. */
export const CACHE_TTL_MS = 30_000;

// ── Factory ──

/**
 * Create a fresh, isolated harness state instance.
 * Each agent session gets its own state via this factory.
 */
export function createHarnessState(): HarnessState {
	// ── Read Cache ──

	const cacheMap = new Map<string, CacheEntry>();

	const readCache: ReadCache = {
		get(key: string, currentTurn: number, currentBatchId?: number): CacheEntry | null {
			const entry = cacheMap.get(key);
			if (!entry) return null;

			// Batch-aware check: if both entry and current call have batchId
			// and they match, the entry is valid regardless of turn diff
			if (currentBatchId !== undefined && entry.batchId !== undefined) {
				if (currentBatchId === entry.batchId) {
					// Same batch — entry is valid (not a different response cycle)
					return entry;
				}
			}

			// Turn-based TTL
			const turnDiff = currentTurn - entry.turn;
			if (turnDiff >= CACHE_TTL_TURNS) {
				cacheMap.delete(key);
				return null;
			}

			// Time-based TTL (monotonic clock, 30s)
			const timeDiff = Date.now() - entry.timestamp;
			if (timeDiff >= CACHE_TTL_MS) {
				cacheMap.delete(key);
				return null;
			}

			return entry;
		},

		set(key: string, content: string, turn: number, batchId?: number): void {
			cacheMap.set(key, {
				content,
				turn,
				timestamp: Date.now(),
				batchId,
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

		decay(): void {
			for (const [, errors] of errorMap) {
				if (errors.length > 0) {
					errors.shift();
				}
			}
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
		record(toolName: string, sessionTurn: number, _toolCallIndex: number, subKey?: string): void {
			const key = makeKey(toolName, subKey);
			if (key !== lastKey) {
				// Composite key changed — reset counter
				lastKey = key;
				consecutiveCount = 1;
				sinceTurn = sessionTurn;
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

		turnBoundaryReset(): void {
			lastKey = null;
			consecutiveCount = 0;
			sinceTurn = 0;
		},
	};

	return { readCache, errorTracker, callCounter, toolCallIndex: 0, sessionTurn: 0 };
}
