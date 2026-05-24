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
	/** Record a tool call. Resets consecutive count if tool changes. */
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

// ── Constants ──

const CACHE_TTL_TURNS = 3;
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

	let lastToolName = "";
	let consecutiveCount = 0;
	let sinceTurn = 0;

	const callCounter: CallCounter = {
		record(toolName: string, turn: number): void {
			if (toolName !== lastToolName) {
				// Tool changed — reset counter for previous tool
				lastToolName = toolName;
				consecutiveCount = 1;
				sinceTurn = turn;
			} else {
				consecutiveCount++;
			}
		},

		getConsecutive(toolName: string): ConsecutiveInfo {
			if (toolName !== lastToolName) {
				return { toolName: "", count: 0, sinceTurn: 0 };
			}
			return {
				toolName: lastToolName,
				count: consecutiveCount,
				sinceTurn,
			};
		},

		reset(): void {
			lastToolName = "";
			consecutiveCount = 0;
			sinceTurn = 0;
		},
	};

	return { readCache, errorTracker, callCounter };
}
