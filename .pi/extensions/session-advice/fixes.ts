/**
 * fixes.ts — Known fix suggestions for each waste signal.
 *
 * Maps signal keys to human-readable fix ideas with effort estimates.
 * Used by advice-pipeline.ts to render the "Fix idea" section in waste reports.
 */

export interface FixEntry {
	idea: string;
	effort: "Low" | "Medium" | "High";
}

/** Lookup table: signal key → fix suggestion. */
export const FIXES: Record<string, FixEntry> = {
	"redundant-read": {
		idea: "Cache file contents locally instead of re-reading within 2 turns.",
		effort: "Low",
	},
	"identical-args": {
		idea: "Batch identical tool calls into a single loop or combine arguments.",
		effort: "Medium",
	},
	"bash-grep": {
		idea: "Use `ripgrep_search` (or `ranked_map`) instead of `bash | grep` / `bash | rg` / `bash | find`.",
		effort: "Low",
	},
	"bash-cat": {
		idea: "Use the `read` tool instead of `bash cat` / `bash head` / `bash tail`.",
		effort: "Low",
	},
	"error-loop": {
		idea: "After a tool error, change approach (try a different tool or verify preconditions) instead of retrying the same tool.",
		effort: "Medium",
	},
	"no-batch": {
		idea: "Batch consecutive same-tool calls into fewer turns to reduce turn overhead (~600 tokens per extra turn).",
		effort: "Medium",
	},
	"turn-inefficiency": {
		idea: "Combine multiple read-only tool calls into discovery turns, or skip turns that produce no file changes.",
		effort: "High",
	},
	"structural-search-underuse": {
		idea: "Use `structural_search` (AST-aware query) when working with code files instead of reading/editing multiple files blindly. Reduces token waste from excessive file reads.",
		effort: "Low",
	},
};

/** Fallback fix when signal key is not in FIXES. */
export const DEFAULT_FIX: FixEntry = {
	idea: "Investigate the waste signal and adjust agent behavior accordingly.",
	effort: "Medium",
};
