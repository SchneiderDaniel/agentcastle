/**
 * harness-rules.ts — Agent Harness Detection Rules
 *
 * Domain layer: pure detection functions with zero dependencies.
 * No pi, no I/O, no side effects. Used by both:
 *  - agent-harness extension (runtime tool_call interception)
 *  - session-advice advisor.ts (post-hoc analysis)
 *
 * Every function is synchronous, returns only primitives, no side effects.
 *
 * @packageDocumentation
 */

// ── Detection helpers ──

const BASH_SEARCH_SIGNALS = ["| grep", "| rg", "| find", "`grep", "`rg", "`find", "`rg`", "`grep`"];
const READ_BASH_CMDS = ["cat", "head", "tail", "less", "more"];
const CODE_FILE_EXTENSIONS = [".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go"];

/**
 * Detect if a bash command contains search patterns (grep/rg/find via pipe or backtick).
 * Used for tool-mismatch detection — these should use ripgrep_search instead.
 */
export function isSearchInBash(command: string): boolean {
	if (!command) return false;
	const lower = command.toLowerCase();
	return BASH_SEARCH_SIGNALS.some((signal) => lower.includes(signal));
}

/**
 * Detect if a bash command uses file-reading commands (cat/head/tail/less/more).
 * These should use the `read` tool instead.
 */
export function isCatHeadTailInBash(command: string): boolean {
	if (!command) return false;
	const trimmed = command.trim().toLowerCase();
	// Check if command starts with one of the read commands
	// or contains " cat " / " head " etc as a word (for piped contexts)
	return READ_BASH_CMDS.some((cmd) => {
		if (trimmed === cmd) return true;
		if (trimmed.startsWith(cmd + " ")) return true;
		if (trimmed.startsWith(cmd + "\t")) return true;
		if (trimmed.includes(" " + cmd + " ")) return true;
		if (trimmed.includes(" " + cmd + "\t")) return true;
		return false;
	});
}

/**
 * Detect if a bash command is `ls` (plain directory listing).
 * npm ls, git ls-files, etc should NOT match.
 */
export function isLsInBash(command: string): boolean {
	if (!command) return false;
	const trimmed = command.trim().toLowerCase();
	// Match only bare `ls`, `ls <args>`, not `npm ls`, `git ls-files`, etc
	if (trimmed === "ls") return true;
	if (trimmed.startsWith("ls ") && !trimmed.startsWith("ls ") && trimmed.split(" ").length >= 1) {
		// Check the first word is exactly "ls"
		const firstWord = trimmed.split(/\s+/)[0];
		if (firstWord === "ls") return true;
	}
	// More robust: check first token
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	return tokens.length > 0 && tokens[0] === "ls";
}

/**
 * Should block retry of a tool after N errors.
 * Returns true if errorCount >= 2 (second consecutive error triggers block).
 */
export function shouldBlockRetry(errorCount: number): boolean {
	return errorCount >= 2;
}

/**
 * Detect if a read call is redundant (same path recently read).
 * turnDiff = currentTurn - lastReadTurn.
 * Returns true if same path within 2 turns (TTL = 3 turns, meaning diff ≤ 2).
 */
export function isRedundantRead(currentPath: string, lastPath: string, turnDiff: number): boolean {
	if (currentPath !== lastPath) return false;
	return turnDiff >= 0 && turnDiff <= 2;
}

/**
 * Check if a file path is a code file (should use structural_search).
 */
export function isCodeFilePath(path: string): boolean {
	if (!path) return false;
	const lower = path.toLowerCase();
	return CODE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export interface MismatchResult {
	category: "tool-mismatch";
	suggestion: string;
}

/**
 * Detect tool mismatches in a bash command and return suggestion.
 * Returns null if no mismatch is detected.
 */
export function detectMismatchAndSuggest(command: string): MismatchResult | null {
	if (!command) return null;

	if (isSearchInBash(command)) {
		return {
			category: "tool-mismatch",
			suggestion: "Replace bash grep/rg with ripgrep_search tool for structured search results",
		};
	}

	if (isCatHeadTailInBash(command)) {
		return {
			category: "tool-mismatch",
			suggestion: "Replace bash cat/head/tail with read tool for file inspection",
		};
	}

	if (isLsInBash(command)) {
		return {
			category: "tool-mismatch",
			suggestion: "Use bash ls for directory listing only; use ripgrep_search to find files",
		};
	}

	return null;
}

/**
 * Suggest a redirection for a bash command that should use a dedicated tool.
 * Returns a suggestion string or null if no redirection needed.
 */
export function suggestRedirection(command: string): string | null {
	if (!command) return null;

	if (isSearchInBash(command)) {
		return "Use ripgrep_search with query instead of bash grep/rg";
	}

	if (isCatHeadTailInBash(command)) {
		return "Use read(path, offset?, limit?) instead of bash cat/head/tail";
	}

	if (isLsInBash(command)) {
		return "Use bash ls for directory listing; use ripgrep_search to find files";
	}

	return null;
}
