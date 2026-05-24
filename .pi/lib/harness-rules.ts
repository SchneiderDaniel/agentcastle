/**
 * harness-rules.ts — Shared tool-call detection rules
 *
 * Pure functions consumed by both:
 *  - agent-harness extension (runtime tool_call blocking)
 *  - session-advice/advisor.ts (post-hoc session analysis)
 *
 * Zero pi dependencies — domain layer only.
 * All functions synchronous, return only primitives, no side effects.
 */

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
export const CACHE_TTL_TURNS = 3;

/** Max consecutive same-tool calls before triggering cascade block. */
export const CASCADE_THRESHOLD = 4;

/** Max errors tracked per tool before triggering retry block. */
export const MAX_ERRORS_PER_TOOL = 3;

// ── Detection functions ──

/**
 * Check if a bash command uses grep/rg/find for search.
 * These should be replaced with ripgrep_search.
 */
export function isSearchInBash(cmd: string): boolean {
	if (!cmd) return false;
	const lower = cmd.toLowerCase();
	return BASH_SEARCH_SIGNALS.some((signal) => lower.includes(signal));
}

/**
 * Check if a bash command uses cat/head/tail/less/more for file reading.
 * These should be replaced with the read tool.
 */
export function isCatHeadTailInBash(cmd: string): boolean {
	if (!cmd) return false;
	const lower = cmd.toLowerCase().trim();
	// Check if command starts with one of the read-like commands
	for (const c of READ_BASH_CMDS) {
		if (lower.startsWith(c + " ") || lower.startsWith(c + "\t")) {
			return true;
		}
		// Also detect when used in pipe (e.g., "cat file | grep x")
		if (lower.includes(" " + c + " ") || lower.includes("\t" + c + "\t")) {
			return true;
		}
	}
	return false;
}

/**
 * Check if a bash command uses `ls` for directory listing.
 * Returns true for `ls`, `ls -la`, `ls -l`, etc.
 * Does NOT match `npm ls`, `lsass`, or other commands containing "ls".
 */
export function isLsInBash(cmd: string): boolean {
	if (!cmd) return false;
	const trimmed = cmd.trim().toLowerCase();

	// Exact match for bare "ls"
	if (trimmed === "ls") return true;

	// Starts with "ls " followed by flags/paths — ensure it's not "npm ls" etc
	// Check the first token is "ls"
	const tokens = trimmed.split(/\s+/);
	if (tokens.length > 0 && tokens[0] === "ls") return true;

	return false;
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
 */
export function detectMismatchAndSuggest(
	cmd: string,
): { category: string; suggestion: string } | null {
	if (!cmd) return null;
	const lower = cmd.toLowerCase();

	// Search in bash (grep/rg)
	if (
		lower.includes("| grep") ||
		lower.includes("`grep") ||
		lower.includes("| rg") ||
		lower.includes("`rg")
	) {
		return {
			category: "tool-mismatch",
			suggestion: "Use ripgrep_search tool for text search instead of bash grep/rg",
		};
	}

	// File read in bash (cat/head/tail)
	for (const c of READ_BASH_CMDS) {
		if (lower.startsWith(c + " ") || lower.startsWith(c + "\t")) {
			return {
				category: "tool-mismatch",
				suggestion: `Use read tool instead of bash ${c} for file inspection`,
			};
		}
	}

	// ls (informational only)
	if (isLsInBash(cmd)) {
		return {
			category: "tool-mismatch",
			suggestion:
				"Use bash ls for directory listing. For file contents, use read tool. For finding files, use ripgrep_search.",
		};
	}

	return null;
}

/**
 * Suggest a redirection for a mismatched bash command.
 * Returns the suggested tool name or null if no mismatch.
 * Used by runtime handler to populate redirectTo field.
 */
export function suggestRedirection(cmd: string): string | null {
	if (!cmd) return null;
	const lower = cmd.toLowerCase();

	// grep/rg → ripgrep_search
	if (
		lower.includes("| grep") ||
		lower.includes("`grep") ||
		lower.includes("| rg") ||
		lower.includes("`rg")
	) {
		return "ripgrep_search";
	}

	// cat/head/tail → read
	for (const c of READ_BASH_CMDS) {
		if (lower.startsWith(c + " ") || lower.startsWith(c + "\t")) {
			return "read";
		}
	}

	return null;
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
