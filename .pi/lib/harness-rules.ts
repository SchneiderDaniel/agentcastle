/**
 * harness-rules.ts — Shared tool-call detection rules
 *
 * Pure functions consumed by both:
 *  - agent-harness extension (runtime tool_call blocking)
 *  - session-advice/advisor.ts (post-hoc session analysis)
 *
 * Zero pi dependencies — domain layer only.
 * All functions synchronous, return only primitives, no side effects.
 *
 * Bash-command detection functions now delegate to BashCommand class
 * (bash-command.ts) for single-parse semantics. Consumers may also
 * import BashCommand directly.
 */

// ── Imports from bash-command.ts ──

import { BashCommand, parseBashCmd as parseBashCmdImpl } from "./bash-command.ts";

// ── Re-export BashCommand class for direct use ──

export { BashCommand } from "./bash-command.ts";
export type { BashSegment } from "./bash-command.ts";

// ── Constants ──

/** Bash search signals: grep/rg/find used via pipe or backtick. */
export const BASH_SEARCH_SIGNALS: readonly string[] = [
	"| grep",
	"| rg",
	"| find",
	"`grep",
	"`rg",
	"`find",
	"`rg`",
	"`grep`",
];

/** Bash file-reading commands that should use `read` tool instead. */
export const READ_BASH_CMDS: readonly string[] = ["cat", "head", "tail", "less", "more"];

/** Dedicated search tools available to the agent. */
export const SEARCH_TOOLS = new Set(["ripgrep_search", "structural_search"]);

/** Code file extensions (lowercase). */
const CODE_EXTENSIONS = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go"]);

/** TTL for read cache: number of turns before a cached entry expires. */
export const CACHE_TTL_TURNS = 6;

/** Max consecutive same-tool calls before triggering cascade block. */
export const CASCADE_THRESHOLD = 8;

/**
 * Multi-verb CLIs where first 2 tokens form the sub-key
 * (e.g., "git status" vs "git diff").
 * Single-verb commands use only the first token.
 */
export const MULTI_VERB_TOOLS = new Set([
	"git",
	"npm",
	"yarn",
	"cargo",
	"go",
	"docker",
	"kubectl",
	"gh",
]);

/**
 * Bash commands that modify files — triggers read cache invalidation.
 */
export const FILE_MODIFY_SIGNALS: readonly string[] = [
	"sed",
	"echo",
	"cat",
	"tee",
	"mv",
	"cp",
	"rm",
	"chmod",
	"dd",
];

/** Max errors tracked per tool before triggering retry block. */
export const MAX_ERRORS_PER_TOOL = 3;

// ── Types ──

/** Per-tool metadata for harness configuration. */
export interface ToolMeta {
	/** If true, tool is never blocked by any guard. */
	passThrough?: boolean;
	/** Consecutive-call threshold before cascade block (default 8). */
	cascadeThreshold?: number;
}

/**
 * Per-tool metadata replacing PASS_THROUGH_TOOLS Set.
 * Tools not listed default to passThrough=false, cascadeThreshold=8.
 */
export const TOOL_META: Record<string, ToolMeta> = {
	ask_user: { passThrough: true },
	structural_search: { passThrough: true },
	ripgrep_search: { passThrough: true },
	ranked_map: { passThrough: true },
	bash: { cascadeThreshold: CASCADE_THRESHOLD },
	web_crawl: { cascadeThreshold: 20 },
};

/**
 * Get tool meta with defaults for unlisted tools.
 */
export function getToolMeta(toolName: string): ToolMeta {
	return TOOL_META[toolName] ?? { passThrough: false, cascadeThreshold: CASCADE_THRESHOLD };
}

// ── Bash tokenization (kept for backward compatibility) ──

/**
 * Tokenize a bash command string respecting quotes, pipes, and redirects.
 * Splits by pipe (|) outside single/double quotes.
 * Returns array of segments, each with tokens and optional redirect type.
 *
 * Handles:
 *  - Single and double quoted strings (pipe inside quotes = literal)
 *  - Tab and space token splitting
 *  - > (write) and >> (append) redirect detection
 *
 * Does NOT handle:
 *  - eval, exec, subshells ($(), ``)
 *  - Escaped quotes inside quotes
 *  - Heredoc bodies (<< delimiter is treated as redirect)
 */
export function parseBashCmd(cmd: string): import("./bash-command.ts").BashSegment[] {
	return parseBashCmdImpl(cmd);
}

// ── Detection functions (delegate to BashCommand) ──

/**
 * Quick check if a bash command is a simple standalone call
 * (no pipes, && chains, or semicolons).
 * Returns false for complex commands that should pass through.
 */
export function isStandaloneToolCall(cmd: string): boolean {
	return new BashCommand(cmd).isStandalone();
}

/**
 * Check if a bash command uses grep/rg/find for search.
 * These should be replaced with ripgrep_search.
 *
 * Uses BashCommand.isSearch() which handles:
 *  - `cmd1 | grep foo` → pass through (pipeline)
 *  - `grep foo` → block (standalone)
 *  - Backtick grep/rg → always block
 */
export function isSearchInBash(cmd: string): boolean {
	return new BashCommand(cmd).isSearch();
}

/**
 * Check if a bash command uses cat/head/tail/less/more for file reading.
 * These should be replaced with the read tool.
 *
 * Uses BashCommand.isFileRead() which avoids false positives:
 *  - cat with output redirect (cat > file, cat >> file) → no block
 *  - head/tail in pipe context (cmd1 | head -5) → no block
 *  - Patterns in quoted args (gh issue --title "...cat...") → no block
 *  - cat/head/tail as first command → block (file read)
 */
export function isCatHeadTailInBash(cmd: string): boolean {
	return new BashCommand(cmd).isFileRead();
}

/**
 * Check if a bash command modifies files (triggers cache invalidation).
 * Detects redirect operators and known file-modifying commands.
 */
export function isFileModifyingBash(cmd: string): boolean {
	return new BashCommand(cmd).isFileModify();
}

/**
 * Build a structured redirect message for the LLM.
 * Returns a [SYSTEM OVERRIDE] block with forbidden action and required JSON schema.
 */
export function buildRedirectMessage(toolName: string): string {
	if (toolName === "ripgrep_search") {
		return [
			`[SYSTEM OVERRIDE] Action Blocked. Do not use 'grep' or 'rg' in bash.`,
			`You MUST use the dedicated 'ripgrep_search' tool.`,
			`Required JSON Schema: { "query": "your_search_pattern", "directory": "./target_dir" }`,
		].join("\n");
	}
	if (toolName === "read") {
		return [
			`[SYSTEM OVERRIDE] Action Blocked. Do not use 'cat', 'head', or 'tail' in bash.`,
			`You MUST use the dedicated 'read' tool.`,
			`Required JSON Schema: { "path": "./file.ts", "offset?": 0, "limit?": 100 }`,
		].join("\n");
	}
	return "";
}

/**
 * Check if a bash command uses `ls` for directory listing.
 * Returns true for `ls`, `ls -la`, `ls -l`, etc.
 * Does NOT match `npm ls`, `lsass`, or other commands containing "ls".
 */
export function isLsInBash(cmd: string): boolean {
	return new BashCommand(cmd).isLs();
}

/**
 * Determine if a tool should be blocked based on accumulated error count.
 * Blocks when 2+ errors accumulated (consecutive or not, within the 3-entry window).
 */
export function shouldBlockRetry(errorCount: number): boolean {
	return errorCount >= 2;
}

/**
 * Check if reading the same file path within TTL turns is a redundant read.
 * @param prevPath — previously read path
 * @param currentPath — current read path
 * @param turnDiff — absolute turn difference
 */
export function isRedundantRead(prevPath: string, currentPath: string, turnDiff: number): boolean {
	if (!prevPath || !currentPath) return false;
	if (prevPath !== currentPath) return false;
	return turnDiff < CACHE_TTL_TURNS;
}

/**
 * Check if a file path corresponds to a code file (has recognized extension).
 */
export function isCodeFilePath(path: string): boolean {
	if (!path) return false;
	const lower = path.toLowerCase();
	for (const ext of CODE_EXTENSIONS) {
		if (lower.endsWith(ext)) return true;
	}
	return false;
}

/**
 * Detect tool mismatch in a bash command and suggest alternative.
 * Returns null if no mismatch detected.
 *
 * Uses BashCommand.detectMismatch() for token-aware analysis to avoid
 * false positives from quoted arguments.
 */
export function detectMismatchAndSuggest(
	cmd: string,
): { category: string; suggestion: string } | null {
	return new BashCommand(cmd).detectMismatch();
}

/**
 * Suggest a redirection for a mismatched bash command.
 * Returns the suggested tool name or null if no mismatch.
 * Used by runtime handler to populate redirectTo field.
 *
 * Uses BashCommand.suggestRedirection() for token-aware analysis.
 */
export function suggestRedirection(cmd: string): string | null {
	return new BashCommand(cmd).suggestRedirection();
}

// ── Shared helper (extracted from advisor.ts) ──

/**
 * Check if text contains grep-like patterns.
 * Used by both advisor.ts (post-hoc) and agent-harness (runtime).
 */
export function grepLike(s: string): boolean {
	if (!s) return false;
	const low = s.toLowerCase();
	return low.includes("grep") || low.includes("| rg") || low.includes("`rg");
}
