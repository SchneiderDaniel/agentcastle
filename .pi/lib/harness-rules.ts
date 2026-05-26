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
export const CACHE_TTL_TURNS = 6;

/** Max consecutive same-tool calls before triggering cascade block. */
export const CASCADE_THRESHOLD = 8;

/** Max errors tracked per tool before triggering retry block. */
export const MAX_ERRORS_PER_TOOL = 3;

// ── Types ──

/** A single segment of a piped bash command. */
export interface BashSegment {
	/** Command tokens (cmd + args parsed outside quotes). */
	tokens: string[];
	/** Output redirect detected on segment (e.g., > or >>). */
	redirect?: "write" | "append" | "read";
}

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
};

/**
 * Get tool meta with defaults for unlisted tools.
 */
export function getToolMeta(toolName: string): ToolMeta {
	return TOOL_META[toolName] ?? { passThrough: false, cascadeThreshold: CASCADE_THRESHOLD };
}

// ── Bash tokenization ──

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
export function parseBashCmd(cmd: string): BashSegment[] {
	if (!cmd) return [];

	const segments: BashSegment[] = [];
	let currentSegment: string[] = [];
	let currentToken = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;

	function flushToken() {
		if (currentToken) {
			currentSegment.push(currentToken);
			currentToken = "";
		}
	}

	function flushSegment() {
		flushToken();
		if (currentSegment.length === 0) return;

		const seg: BashSegment = { tokens: [...currentSegment] };

		// Check for redirect operators in tokens
		const idx = seg.tokens.findIndex((t) => t === ">" || t === ">>");
		if (idx >= 0) {
			const op = seg.tokens[idx];
			seg.redirect = op === ">>" ? "append" : "write";
			seg.tokens = seg.tokens.slice(0, idx);
		}

		segments.push(seg);
		currentSegment = [];
	}

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];

		// Handle quote toggling
		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			currentToken += ch;
			continue;
		}
		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			currentToken += ch;
			continue;
		}

		// Inside quotes: collect everything literally
		if (inSingleQuote || inDoubleQuote) {
			currentToken += ch;
			continue;
		}

		// Pipe separator (outside quotes)
		if (ch === "|") {
			flushSegment();
			continue;
		}

		// Whitespace (space/tab) separator outside quotes
		if (ch === " " || ch === "\t") {
			flushToken();
			continue;
		}

		currentToken += ch;
	}

	// Flush remaining
	flushSegment();

	return segments;
}

// ── Detection functions ──

/**
 * Check if a bash command uses grep/rg/find for search.
 * These should be replaced with ripgrep_search.
 *
 * Uses parseBashCmd to avoid false positives:
 *  - Patterns in quoted args (gh issue --body '...| grep...') → no block
 *  - Patterns in pipe outside quotes → block
 *  - Backtick grep/rg → block
 */
export function isSearchInBash(cmd: string): boolean {
	if (!cmd) return false;
	const lower = cmd.toLowerCase();

	// Backtick patterns: `grep`, `rg` — these are always search
	if (lower.includes("`grep")) {
		return true;
	}
	if (lower.includes("`rg")) {
		return true;
	}

	// Use parseBashCmd to split by pipe outside quotes
	const segments = parseBashCmd(lower);

	// Check segments for grep/rg as the first token (piped command)
	for (const seg of segments) {
		if (seg.redirect) continue;
		if (seg.tokens.length >= 1) {
			// grep/rg as first token in segment → cmd1 | grep foo
			const first = seg.tokens[0];
			if (first === "grep" || first === "rg") {
				return true;
			}
		}
	}

	return false;
}

/**
 * Check if a bash command uses cat/head/tail/less/more for file reading.
 * These should be replaced with the read tool.
 *
 * Uses parseBashCmd to avoid false positives:
 *  - cat with output redirect (cat > file, cat >> file) → no block
 *  - head/tail in pipe context (cmd1 | head -5) → no block
 *  - Patterns in quoted args (gh issue --title "...cat...") → no block
 *  - cat/head/tail as first command → block (file read)
 */
export function isCatHeadTailInBash(cmd: string): boolean {
	if (!cmd) return false;
	const lower = cmd.toLowerCase().trim();

	const segments = parseBashCmd(lower);
	if (segments.length === 0) return false;

	// Check the FIRST segment only (pipe-chain head)
	const firstSeg = segments[0];
	if (!firstSeg || firstSeg.tokens.length === 0) return false;

	// If first segment has redirect (write/append), it's not a read
	if (firstSeg.redirect) return false;

	// Check first token against READ_BASH_CMDS
	const firstToken = firstSeg.tokens[0];
	if (READ_BASH_CMDS.includes(firstToken as (typeof READ_BASH_CMDS)[number])) {
		return true;
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
 *
 * Uses parseBashCmd for token-aware analysis to avoid false positives
 * from quoted arguments.
 */
export function detectMismatchAndSuggest(
	cmd: string,
): { category: string; suggestion: string } | null {
	if (!cmd) return null;
	const lower = cmd.toLowerCase();

	// Backtick search patterns are always search
	if (lower.includes("`grep") || lower.includes("`rg")) {
		return {
			category: "tool-mismatch",
			suggestion: "Use ripgrep_search tool for text search instead of bash grep/rg",
		};
	}

	const segments = parseBashCmd(lower);
	if (segments.length === 0) return null;

	// Search in bash (grep/rg as first token in piped segment)
	for (const seg of segments) {
		if (seg.redirect) continue;
		if (seg.tokens.length >= 1) {
			const first = seg.tokens[0];
			if (first === "grep" || first === "rg") {
				return {
					category: "tool-mismatch",
					suggestion: "Use ripgrep_search tool for text search instead of bash grep/rg",
				};
			}
		}
	}

	// File read in bash (cat/head/tail — first segment, no redirect)
	const firstSeg = segments[0];
	if (firstSeg && firstSeg.tokens.length >= 1 && !firstSeg.redirect) {
		const first = firstSeg.tokens[0];
		for (const c of READ_BASH_CMDS) {
			if (first === c) {
				return {
					category: "tool-mismatch",
					suggestion: `Use read tool instead of bash ${c} for file inspection`,
				};
			}
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
 *
 * Uses parseBashCmd for token-aware analysis.
 */
export function suggestRedirection(cmd: string): string | null {
	if (!cmd) return null;
	const lower = cmd.toLowerCase();

	// Backtick search patterns → ripgrep_search
	if (lower.includes("`grep") || lower.includes("`rg")) {
		return "ripgrep_search";
	}

	const segments = parseBashCmd(lower);
	if (segments.length === 0) return null;

	// grep/rg as first token in any segment → ripgrep_search
	for (const seg of segments) {
		if (seg.redirect) continue;
		if (seg.tokens.length >= 1) {
			const first = seg.tokens[0];
			if (first === "grep" || first === "rg") {
				return "ripgrep_search";
			}
		}
	}

	// cat/head/tail as first token in first segment, no redirect → read
	const firstSeg = segments[0];
	if (firstSeg && firstSeg.tokens.length >= 1 && !firstSeg.redirect) {
		const first = firstSeg.tokens[0];
		for (const c of READ_BASH_CMDS) {
			if (first === c) {
				return "read";
			}
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
