/**
 * harness-state.ts — Agent Harness Runtime State
 *
 * Use case layer: in-memory mutable state shared across tool_call handlers.
 * Depends only on domain rules (harness-rules.ts) — zero pi dependencies.
 *
 * State is isolated per-session (no globals, no singletons).
 * Each call to createHarnessState() creates a fresh instance.
 *
 * @packageDocumentation
 */

// ── Types ──

export interface CacheEntry {
	content: string;
	turn: number;
	timestamp: number;
}

export interface ErrorRecord {
	turn: number;
	toolName: string;
}

export interface ConsecutiveInfo {
	toolName: string;
	count: number;
	sinceTurn: number;
}

export interface ReadCache {
	/** Get cached entry. Returns null if miss or TTL (3 turns) exceeded. */
	get(key: string, currentTurn: number): CacheEntry | null;
	/** Store an entry in the cache. */
	set(key: string, content: string, turn: number): void;
	/** Clear all cached entries. */
	clear(): void;
}

export interface ErrorTracker {
	/** Push an error record for a tool. Keeps max 3 per tool (oldest evicted). */
	push(toolName: string, error: ErrorRecord): void;
	/** Get last N errors for a tool (max 3). Returns empty array if none. */
	getLastErrors(toolName: string): ErrorRecord[];
	/** Clear all error records. */
	clear(): void;
}

export interface CallCounter {
	/** Record a tool call at the given turn. Tracks consecutive calls. */
	record(toolName: string, turn: number): void;
	/** Get consecutive call info for a tool. */
	getConsecutive(toolName: string): ConsecutiveInfo;
	/** Reset all counters. */
	reset(): void;
}

export interface HarnessState {
	readCache: ReadCache;
	errorTracker: ErrorTracker;
	callCounter: CallCounter;
}

// ── Cache TTL ──

const CACHE_TTL_TURNS = 3; // Cache expires after 3 turns (at turn diff >= 3)

// ── Factory ──

/**
 * Create a fresh harness state instance.
 * Each session gets its own instance via createHarnessState().
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
				cacheMap.delete(key); // evict stale entry
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

	const errorMap = new Map<string, ErrorRecord[]>();
	const MAX_ERRORS_PER_TOOL = 3;

	const errorTracker: ErrorTracker = {
		push(toolName: string, error: ErrorRecord): void {
			let errors = errorMap.get(toolName);
			if (!errors) {
				errors = [];
				errorMap.set(toolName, errors);
			}

			errors.push(error);

			// Keep max 3 entries (remove oldest)
			if (errors.length > MAX_ERRORS_PER_TOOL) {
				errors.shift();
			}
		},

		getLastErrors(toolName: string): ErrorRecord[] {
			return errorMap.get(toolName) ?? [];
		},

		clear(): void {
			errorMap.clear();
		},
	};

	// ── Call Counter ──

	let lastToolName = "";
	let consecutiveCount = 0;
	let sinceTurn = 0;

	const callCounter: CallCounter = {
		record(toolName: string, turn: number): void {
			if (toolName === lastToolName) {
				consecutiveCount++;
			} else {
				lastToolName = toolName;
				consecutiveCount = 1;
				sinceTurn = turn;
			}
		},

		getConsecutive(toolName: string): ConsecutiveInfo {
			if (toolName !== lastToolName) {
				return { toolName, count: 0, sinceTurn: 0 };
			}
			return { toolName: lastToolName, count: consecutiveCount, sinceTurn };
		},

		reset(): void {
			lastToolName = "";
			consecutiveCount = 0;
			sinceTurn = 0;
		},
	};

	return { readCache, errorTracker, callCounter };
}
