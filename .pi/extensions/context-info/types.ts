/**
 * Types for context-info extension
 */

export interface ThresholdEntry {
	maxTokens: number | null;
}

export interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

export interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
	/** Auto-dismiss welcome banner after N ms. 0 = no timeout (wait for user interaction). */
	welcomeTimeoutMs: number;
}

/**
 * FooterConfig — Data-only interface for footer rendering state.
 *
 * Fields using `{ value: T }` wrappers are mutated in-place from event
 * handlers and read at render time via the same object reference.
 * Adding a new footer field means adding a property here and using it
 * in installFooter() — no call sites change.
 */
export interface FooterConfig {
	worktreeName: string | null;
	thinkingLevel: string;
	tpsSamples: TpsSample[];
	lastComputedTps: { value: number | null };
	lastContextWindow: { value: number | undefined };
	toolCallCount: { value: number };
	cacheRead: number | undefined;
	cacheWrite: number | undefined;
	sessionId: string;
}
