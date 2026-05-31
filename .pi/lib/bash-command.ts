/**
 * bash-command.ts — Parse-and-query a bash command once.
 *
 * Wraps parseBashCmd() output and exposes query methods so callers
 * never need to parse the same command string more than once.
 *
 * Replacements for harness-rules.ts flat functions:
 *   isSearchInBash()       → BashCommand(cmd).isSearch()
 *   isCatHeadTailInBash()  → BashCommand(cmd).isFileRead()
 *   isFileModifyingBash()  → BashCommand(cmd).isFileModify()
 *   isStandaloneToolCall() → BashCommand(cmd).isStandalone()
 *   isLsInBash()           → BashCommand(cmd).isLs()
 *   detectMismatchAndSuggest() → BashCommand(cmd).detectMismatch()
 *   suggestRedirection()   → BashCommand(cmd).suggestRedirection()
 *
 * All constants remain in harness-rules.ts for shared access.
 */

// ── Re-export the segment type ──

/** A single segment of a piped bash command. */
export interface BashSegment {
	/** Command tokens (cmd + args parsed outside quotes). */
	tokens: string[];
	/** Output redirect detected on segment (e.g., > or >>). */
	redirect?: "write" | "append" | "read";
}

/** Bash file-reading commands that should use `read` tool instead. */
const READ_BASH_CMDS: readonly string[] = ["cat", "head", "tail", "less", "more"];

/**
 * Bash commands that modify files — triggers read cache invalidation.
 */
const FILE_MODIFY_SIGNALS: readonly string[] = [
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

// ── Tokenizer (extracted from harness-rules.ts) ──

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

// ── BashCommand class ──

/**
 * Parse a bash command once and query its structure.
 *
 * Example:
 * ```ts
 * const cmd = new BashCommand("grep foo bar.ts");
 * cmd.isSearch();     // true
 * cmd.isStandalone(); // true
 * ```
 */
export class BashCommand {
	/** The original command string. */
	readonly raw: string;
	/** Parsed segments (pipe-delimited parts of the command). */
	readonly segments: BashSegment[];

	/** Pre-computed lower-cased command. */
	private readonly lower: string;

	constructor(cmd: string) {
		this.raw = cmd;
		this.lower = cmd.toLowerCase();
		this.segments = parseBashCmd(cmd);
	}

	/**
	 * True if this is a pure, un-piped grep/rg call that should use
	 * the ripgrep_search tool instead.
	 *
	 * Logic matches harness-rules.ts isSearchInBash():
	 *  - Backtick grep/rg → always search
	 *  - Standalone grep/rg as first token → search
	 *  - Piped, && chained, ; chained → not search (pass through)
	 */
	isSearch(): boolean {
		if (!this.raw) return false;

		// Backtick patterns: `grep`, `rg` — these are always search
		if (this.lower.includes("`grep") || this.lower.includes("`rg")) {
			return true;
		}

		// Only standalone calls — complex pipelines pass through
		if (!this.isStandalone()) {
			return false;
		}

		// For standalone commands, check first segment only
		if (this.segments.length === 0) return false;

		const firstSeg = this.segments[0];
		if (!firstSeg || firstSeg.tokens.length === 0) return false;

		const first = firstSeg.tokens[0];
		return first === "grep" || first === "rg";
	}

	/**
	 * True if the command is a bash file-read that should use the
	 * `read` tool instead (cat/head/tail/less/more as first command).
	 *
	 * Logic matches harness-rules.ts isCatHeadTailInBash():
	 *  - Checks FIRST segment only (pipe-chain head)
	 *  - Redirect (write/append) → not a read
	 *  - Piped context → not a read
	 */
	isFileRead(): boolean {
		if (!this.raw) return false;

		if (this.segments.length === 0) return false;

		// Check the FIRST segment only (pipe-chain head)
		const firstSeg = this.segments[0];
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
	 * True if the command modifies files (triggers cache invalidation).
	 *
	 * Logic matches harness-rules.ts isFileModifyingBash():
	 *  - Redirect operators (>, >>) always modify files
	 *  - Known file-modifying commands (sed, mv, cp, rm, ...)
	 */
	isFileModify(): boolean {
		if (!this.raw) return false;

		// Redirect operators (>, >>) always modify files
		if (this.lower.includes(">")) return true;

		if (this.segments.length === 0) return false;

		// Check first token of first segment against known file-modifying commands
		const firstSeg = this.segments[0];
		if (!firstSeg || firstSeg.tokens.length === 0) return false;

		const firstToken = firstSeg.tokens[0];
		return (FILE_MODIFY_SIGNALS as readonly string[]).includes(firstToken);
	}

	/**
	 * True if the command is a simple standalone call
	 * (no pipes, && chains, or semicolons).
	 *
	 * Logic matches harness-rules.ts isStandaloneToolCall().
	 */
	isStandalone(): boolean {
		if (!this.raw) return false;
		// Complex commands with pipes, &&, or ; are not standalone
		if (this.raw.includes("|") || this.raw.includes("&&") || this.raw.includes(";")) {
			return false;
		}
		return true;
	}

	/**
	 * True if the command is `ls` or `ls <flags>`.
	 * Does NOT match `npm ls`, `lsass`, etc.
	 *
	 * Logic matches harness-rules.ts isLsInBash().
	 */
	isLs(): boolean {
		if (!this.raw) return false;

		// Exact match for bare "ls"
		if (this.raw.trim().toLowerCase() === "ls") return true;

		// Starts with "ls " followed by flags/paths — check first token is "ls"
		const tokens = this.raw.trim().split(/\s+/);
		if (tokens.length > 0 && tokens[0] === "ls") return true;

		return false;
	}

	/**
	 * Detect tool mismatch and suggest alternative.
	 * Returns null if no mismatch detected.
	 *
	 * Logic matches harness-rules.ts detectMismatchAndSuggest().
	 */
	detectMismatch(): { category: string; suggestion: string } | null {
		if (!this.raw) return null;

		// Backtick search patterns are always search
		if (this.lower.includes("`grep") || this.lower.includes("`rg")) {
			return {
				category: "tool-mismatch",
				suggestion: "Use ripgrep_search tool for text search instead of bash grep/rg",
			};
		}

		if (this.segments.length === 0) return null;

		// Search in bash (grep/rg as first token — standalone only, not piped)
		if (this.isStandalone()) {
			for (const seg of this.segments) {
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
		}

		// File read in bash (cat/head/tail — first segment, no redirect)
		const firstSeg = this.segments[0];
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
		if (this.isLs()) {
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
	 *
	 * Logic matches harness-rules.ts suggestRedirection().
	 */
	suggestRedirection(): string | null {
		if (!this.raw) return null;

		// Backtick search patterns → ripgrep_search
		if (this.lower.includes("`grep") || this.lower.includes("`rg")) {
			return "ripgrep_search";
		}

		if (this.segments.length === 0) return null;

		// grep/rg as first token — standalone only, not piped
		if (this.isStandalone()) {
			for (const seg of this.segments) {
				if (seg.redirect) continue;
				if (seg.tokens.length >= 1) {
					const first = seg.tokens[0];
					if (first === "grep" || first === "rg") {
						return "ripgrep_search";
					}
				}
			}
		}

		// cat/head/tail as first token in first segment, no redirect → read
		const firstSeg = this.segments[0];
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
}
