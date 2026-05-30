/**
 * ranked-map — Shared type definitions
 *
 * All interfaces and type aliases used across ranked-map modules.
 * Zero pi SDK imports — pure types only.
 */

/** Configuration for ranked-map behavior, loaded from .pi/settings.json rankedMap key. */
export interface RankedMapConfig {
	tokenBudget: number;
	recencyWindowDays: number;
	cacheTtlHours: number;
	autoThreshold: number;
	weights: { keyword: number; recency: number };
}

/** On-disk cache format for symbol index. */
export interface CachedIndex {
	head: string;
	builtAt: number;
	symbols: Record<string, SymbolEntry[]>;
}

/** A single symbol entry within a file. */
export interface SymbolEntry {
	type: string;
	name: string;
	line: number;
}

/** Scored file entry for tool output. */
export interface RankedFileScore {
	path: string;
	score: number;
	symbols: string;
	preview: string;
}

/** Tool output shape for ranked_map. */
export interface RankedMapResult {
	files: RankedFileScore[];
	total_tokens: number;
	budget: number;
	truncated: boolean;
	mode: "ranked" | "full_dump";
}

/** Raw ctags JSONL tag object (internal parse target). */
export interface CtagsTag {
	_type: string;
	name: string;
	kind: string;
	path: string;
	pattern: string;
	line?: number;
}

/**
 * Exec function signature for adapter pattern.
 *
 * Matches pi.exec() signature: runs a command with args, returns result.
 * Used to keep adapter modules (search.ts, git.ts) testable by accepting
 * a mock exec function.
 */
export type ExecFn = (
	command: string,
	args: string[],
	opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
