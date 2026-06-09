/**
 * ranked-map — Shared type definitions
 *
 * All interfaces and type aliases used across ranked-map modules.
 * Zero pi SDK imports — pure types only.
 */

/** Information about a git submodule for recency scoring. */
export interface SubmoduleInfo {
	/** Relative path from repo root (e.g. "flask_blogs"). */
	path: string;
	/** Optional submodule URL from .gitmodules. */
	url?: string;
	/**
	 * Optional commit SHA. Set to "uninitialized" for submodules
	 * that are registered but not yet initialized.
	 */
	sha?: string;
}

/** Configuration for ranked-map behavior, loaded from .pi/settings.json rankedMap key. */
export interface RankedMapConfig {
	tokenBudget: number;
	recencyWindowDays: number;
	cacheTtlHours: number;
	autoThreshold: number;
	/** Optional synonym map for query term expansion. */
	synonyms?: Record<string, string[]>;
	/** Frequency scaling factor for keyword scoring (default 0.2). */
	frequencyScalingFactor?: number;
	weights: {
		keyword: number;
		recency: number;
		fileSize?: number;
		commitCount?: number;
	};
}

/** On-disk cache format for symbol index. */
export interface CachedIndex {
	head: string;
	builtAt: number;
	symbols: Record<string, SymbolEntry[]>;
	/** Optional config hash for cache invalidation when settings change. */
	configHash?: string;
	/**
	 * Optional target directory used when building the index.
	 * Used for cache scope validation: if the cached index was built with a different
	 * targetDir, it must be rebuilt.
	 */
	targetDir?: string;
}

/** A single symbol entry within a file. */
export interface SymbolEntry {
	type: string;
	name: string;
	line: number;
	/** Optional ctag search pattern (e.g. /^function foo()$/) for preview. */
	pattern?: string;
}

/** Input entry for the shared buildOutputFromEntries helper. */
export interface RankedEntry {
	path: string;
	score: number;
	symbols: SymbolEntry[];
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
