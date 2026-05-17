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
}
