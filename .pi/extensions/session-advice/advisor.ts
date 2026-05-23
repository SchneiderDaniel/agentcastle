/**
 * advisor.ts — Session advice detection rules
 *
 * Pure functions, no pi dependencies. Scans parsed session data
 * for patterns that indicate poor tool usage, loops, or inefficiency.
 *
 * Used by both:
 *  - session-advice pi extension (real-time at shutdown)
 *  - scripts/session-advice.sh (post-hoc batch analysis)
 */

import { readFileSync } from "node:fs";

// ── Types ──

export interface AdviceEntry {
	severity: "error" | "warning" | "info";
	category: string;
	detail: string;
	recommendation: string;
	turns?: number[];
}

export interface AdviceResult {
	sessionId: string;
	score: number; // 0.0 (clean) — 1.0 (needs improvement)
	entries: AdviceEntry[];
}

/** Parsed entry consumed by detection rules. Augmented with turn index. */
export interface SessionEntry {
	type: string;
	toolName?: string;
	isError?: boolean;
	args?: Record<string, unknown>;
	text?: string;
	turnIndex: number;
}

export interface SessionData {
	sessionId: string;
	entries: SessionEntry[];
}

// ── JSONL parser ──

/**
 * Parse a .jsonl session file into SessionData.
 * Computes turn indices by walking entries (user message = new turn).
 */
export function parseJsonlFile(filepath: string): SessionData | null {
	const raw = readFileSync(filepath, "utf-8").trim();
	if (!raw) return null;

	const lines = raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	if (lines.length === 0) return null;

	const header = lines[0];
	const sessionId: string = header.id ?? "unknown";

	const entries: SessionEntry[] = [];
	let turnIndex = -1;

	for (const rawEntry of lines) {
		const type = rawEntry.type;

		if (type === "session") continue; // skip header

		// Turn boundaries: user messages start a new turn
		if (type === "message" && rawEntry.message?.role === "user") {
			turnIndex++;
			continue;
		}

		if (type === "message" && rawEntry.message?.role === "assistant") {
			// Ensure we have a turn started (assistant can appear before any user in branched sessions)
			if (turnIndex < 0) turnIndex = 0;

			// Extract tool calls from assistant message content
			const content = rawEntry.message?.content ?? [];
			for (const c of content) {
				if (c.type === "toolCall") {
					const args = c.arguments ?? {};
					// Check for bash search signals
					const cmd = (args.command ?? "") as string;
					entries.push({
						type: "tool_use",
						toolName: c.name ?? "?",
						args,
						text: cmd,
						turnIndex,
					});
				}
			}
		}

		if (type === "message" && rawEntry.message?.role === "toolResult") {
			if (turnIndex < 0) turnIndex = 0;

			const text = rawEntry.message?.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");

			const toolName = rawEntry.message?.toolName ?? "?";
			const isError = rawEntry.message?.isError ?? false;

			entries.push({
				type: "tool_result",
				toolName,
				isError,
				text,
				turnIndex,
			});

			// Also emit tool usage from toolResult if not already captured
			// (some JSONLs may have toolResult without preceding assistant toolCall)
			const alreadyEmitted = entries.some(
				(e) => e.type === "tool_use" && e.toolName === toolName && e.turnIndex === turnIndex,
			);
			if (!alreadyEmitted) {
				entries.push({
					type: "tool_use",
					toolName,
					text,
					turnIndex,
				});
			}
		}
	}

	return { sessionId, entries };
}

// ── Constants ──

const BASH_SEARCH_SIGNALS = ["| grep", "| rg", "| find", "`grep", "`rg", "`find", "`rg`", "`grep`"];
const READ_BASH_CMDS = ["cat", "head", "tail", "less", "more"];
const SEARCH_TOOLS = new Set(["ripgrep_search", "structural_search"]);

// ── Detection rules ──

/**
 * Rule 1: Same-tool cascade
 * 3+ consecutive same tool calls.
 */
function detectSameToolCascade(data: SessionData): AdviceEntry[] {
	const results: AdviceEntry[] = [];
	const tools = data.entries.filter((e) => e.toolName);

	let runStart = 0;
	for (let i = 1; i <= tools.length; i++) {
		const a = tools[i]?.toolName;
		const b = tools[i - 1]?.toolName;
		if (a === b) continue;

		const runLen = i - runStart;
		if (runLen >= 3 && b) {
			const startTurn = tools[runStart]?.turnIndex ?? 0;
			const endTurn = tools[i - 1]?.turnIndex ?? 0;
			if (startTurn === endTurn) continue; // same-turn batching is not a cascade
			results.push({
				severity: "warning",
				category: "same-tool-cascade",
				detail: `\`${b}\` called ${runLen}x consecutively (turns ${startTurn}–${endTurn})`,
				recommendation:
					b === "bash"
						? "Combine bash calls with `&&` or script files. Use `ripgrep_search` for search, `read` for file inspection."
						: b === "read"
							? "Batch reads — read larger portions in one call. Use `offset`/`limit` instead of separate calls."
							: `Batch ${b} calls to reduce turns and token overhead.`,
				turns: [startTurn, endTurn],
			});
		}
		runStart = i;
	}

	return results;
}

/**
 * Rule 2: Tool mismatch — bash used where search/read tools exist.
 */
function detectToolMismatch(data: SessionData): AdviceEntry[] {
	const results: AdviceEntry[] = [];

	for (const entry of data.entries) {
		if (entry.toolName !== "bash") continue;

		const cmd = (entry.text ?? "").toLowerCase();

		// Check for grep/rg/find in bash
		if (
			cmd.includes("| grep") ||
			cmd.includes("`grep") ||
			cmd.includes("| rg") ||
			cmd.includes("`rg")
		) {
			results.push({
				severity: "error",
				category: "tool-mismatch",
				detail: `\`bash\` used with grep/rg — use \`ripgrep_search\` tool (turn ${entry.turnIndex}): \`${(entry.text ?? "").slice(0, 100)}\``,
				recommendation:
					"Replace `bash | grep/rg` with `ripgrep_search`. Use dedicated search tool for structured JSON results.",
				turns: [entry.turnIndex],
			});
		}

		// Check for file reads in bash
		for (const c of READ_BASH_CMDS) {
			if (cmd.startsWith(c + " ") || cmd.includes(" " + c + " ")) {
				results.push({
					severity: "error",
					category: "tool-mismatch",
					detail: `\`bash\` used with \`${c}\` — use \`read\` tool (turn ${entry.turnIndex}): \`${(entry.text ?? "").slice(0, 100)}\``,
					recommendation: `Replace \`bash ${c}\` with \`read\` tool. Use \`read(path, offset, limit)\` for file inspection.`,
					turns: [entry.turnIndex],
				});
				break;
			}
		}

		// Check for ls
		if (cmd === "ls" || cmd.startsWith("ls ") || cmd.startsWith("ls\t")) {
			results.push({
				severity: "info",
				category: "tool-mismatch",
				detail: `\`bash\` used with \`ls\` (turn ${entry.turnIndex}): \`${(entry.text ?? "").slice(0, 100)}\``,
				recommendation:
					"Use `bash ls` only for directory listing. For file contents, use `read`. For finding files, use `ripgrep_search`.",
				turns: [entry.turnIndex],
			});
		}
	}

	return results;
}

/**
 * Rule 3: Redundant reads — same file path read within 2 turns.
 */
function detectRedundantReads(data: SessionData): AdviceEntry[] {
	const results: AdviceEntry[] = [];
	const reads: Array<{ path: string; turnIndex: number }> = [];

	for (const entry of data.entries) {
		if (entry.toolName !== "read") continue;

		const p = (entry.args?.path ?? entry.text ?? "") as string;
		if (!p) continue;
		const ti = entry.turnIndex;

		const recent = reads.filter(
			(r) => r.path === p && Math.abs(r.turnIndex - ti) <= 2 && r.turnIndex !== ti,
		);
		if (recent.length > 0) {
			results.push({
				severity: "warning",
				category: "redundant-read",
				detail: `\`${shortPath(p)}\` read ${reads.filter((r) => r.path === p).length + 1}x (last at turn ${ti})`,
				recommendation: `For \`${shortPath(p)}\`, use \`read(path, offset, limit)\` to page. Read once, cache results.`,
				turns: [Math.min(...recent.map((r) => r.turnIndex), ti), ti],
			});
		}

		reads.push({ path: p, turnIndex: ti });
	}

	return results;
}

/**
 * Rule 4: Error not actioned — tool error followed by same tool retry.
 */
function detectErrorNotActioned(data: SessionData): AdviceEntry[] {
	const results: AdviceEntry[] = [];
	const errors = data.entries.filter((e) => e.isError);

	for (const err of errors) {
		const errIdx = data.entries.indexOf(err);
		if (errIdx < 0) continue;

		// Look for same tool in next 8 entries
		const window = data.entries.slice(errIdx + 1, errIdx + 9);
		const sameToolRetries = window.filter((e) => e.toolName === err.toolName);

		if (sameToolRetries.length >= 2) {
			results.push({
				severity: "error",
				category: "error-not-actioned",
				detail: `\`${err.toolName}\` errored turn ${err.turnIndex}, retried ${sameToolRetries.length}x same tool`,
				recommendation:
					"After tool error, change approach — different args, different tool, or ask user. Same-tool retry wastes tokens and often fails same way.",
				turns: [err.turnIndex, ...sameToolRetries.map((e) => e.turnIndex)],
			});
		}
	}

	return results;
}

/**
 * Rule 5: Tool coverage gap — code files present but structural_search never used.
 */
function detectToolCoverageGap(data: SessionData): AdviceEntry[] {
	const toolsUsed = new Set(data.entries.filter((e) => e.toolName).map((e) => e.toolName));
	const hasStructural = [...SEARCH_TOOLS].some((t) => toolsUsed.has(t));

	// Check if any tool call touched code files (read/edit/write)
	const touchedCode = data.entries.some((e) => {
		const p = (e.args?.path ?? "") as string;
		return /\.(ts|js|tsx|jsx|py|rs|go)$/i.test(p);
	});

	const hasBashSearch = data.entries.some((e) => e.toolName === "bash" && grepLike(e.text ?? ""));

	if (!touchedCode) return [];
	if (hasStructural) return [];

	return [
		{
			severity: hasBashSearch ? "warning" : "info",
			category: "tool-coverage-gap",
			detail: hasBashSearch
				? "Code files exist, `structural_search` unused — used `bash | grep` instead"
				: "Code files exist but `structural_search` never used",
			recommendation:
				"Use `structural_search` for AST-aware code queries (function defs, class declarations, method calls, try/catch blocks). More precise than text grep.",
		},
	];
}

function grepLike(s: string): boolean {
	const low = s.toLowerCase();
	return low.includes("grep") || low.includes("| rg") || low.includes("`rg");
}

/**
 * Rule 6: Excessive turns + high error rate.
 */
function detectExcessiveTurns(data: SessionData): AdviceEntry[] {
	const toolCalls = data.entries.filter((e) => e.toolName);
	const errors = data.entries.filter((e) => e.isError);
	const uniqueTools = new Set(toolCalls.map((e) => e.toolName));
	const editedFiles = new Set(
		data.entries
			.filter((e) => e.toolName === "edit" || e.toolName === "write")
			.map((e) => (e.args?.path ?? "") as string),
	).size;

	if (toolCalls.length < 6) return [];

	const errorRate = errors.length / toolCalls.length;

	const issues: AdviceEntry[] = [];

	if (errorRate > 0.25 && errors.length >= 2) {
		const highErrorTools = [...new Set(errors.map((e) => e.toolName))].join(", ");
		issues.push({
			severity: "error",
			category: "high-error-rate",
			detail: `${errors.length}/${toolCalls.length} tool calls errored (${Math.round(errorRate * 100)}%). Error-prone tools: ${highErrorTools}.`,
			recommendation:
				"High error rate suggests wrong tool choices or invalid assumptions. Verify file paths, env state, and tool capabilities before calling.",
		});
	}

	if (toolCalls.length > 15 && editedFiles <= 1 && uniqueTools.size <= 2) {
		issues.push({
			severity: "warning",
			category: "excessive-turns",
			detail: `${toolCalls.length} tool calls, only ${editedFiles} file(s) changed, only ${uniqueTools.size} tool(s) used`,
			recommendation:
				"Too many calls for too little output. Batch work, use scripts, or rethink approach. Consider if you're re-reading same data.",
		});
	}

	return issues;
}

/**
 * Rule 7: Identical call loop — same tool+same args 3+ times in last 10 calls.
 */
function detectIdenticalCallLoop(data: SessionData): AdviceEntry[] {
	const results: AdviceEntry[] = [];
	const calls = data.entries
		.filter((e) => e.toolName && e.args)
		.map((e) => ({
			key: `${e.toolName}|${JSON.stringify(e.args)}`,
			toolName: e.toolName!,
			turnIndex: e.turnIndex,
		}));

	const window: string[] = [];
	for (let i = 0; i < calls.length; i++) {
		const key = calls[i].key;
		window.push(key);
		if (window.length > 12) window.shift();

		const count = window.filter((k) => k === key).length;
		if (count >= 3) {
			results.push({
				severity: "error",
				category: "identical-call-loop",
				detail: `\`${calls[i].toolName}\` identical args ${count}x in last ${window.length} calls — loop (turn ${calls[i].turnIndex})`,
				recommendation:
					"Identical calls in a loop waste tokens. Cache results, batch work, or restructure logic to avoid re-querying same data.",
				turns: [calls[Math.max(0, i - window.length)]?.turnIndex ?? 0, calls[i].turnIndex],
			});
			window.length = 0; // avoid re-reporting same loop
		}
	}

	return results;
}

// ── Helpers ──

function shortPath(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx >= 0 ? p.slice(idx + 1) : p;
}

// ── Main analysis ──

export function analyzeSession(data: SessionData): AdviceResult {
	const allEntries: AdviceEntry[] = [
		...detectSameToolCascade(data),
		...detectToolMismatch(data),
		...detectRedundantReads(data),
		...detectErrorNotActioned(data),
		...detectToolCoverageGap(data),
		...detectExcessiveTurns(data),
		...detectIdenticalCallLoop(data),
	];

	// Dedup by category+detail
	const seen = new Set<string>();
	const entries = allEntries.filter((e) => {
		const key = `${e.category}:${JSON.stringify(e.detail)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	// Score: weighted by category severity
	const weights: Record<string, number> = {
		"tool-mismatch": 0.35,
		"error-not-actioned": 0.35,
		"identical-call-loop": 0.35,
		"same-tool-cascade": 0.2,
		"redundant-read": 0.15,
		"high-error-rate": 0.3,
		"excessive-turns": 0.15,
		"tool-coverage-gap": 0.1,
	};

	const severityMultiplier: Record<string, number> = {
		error: 1.0,
		warning: 0.6,
		info: 0.3,
	};

	let weightedSum = 0;
	let maxWeight = 0;

	for (const e of entries) {
		const w = weights[e.category] ?? 0.1;
		const s = severityMultiplier[e.severity] ?? 0.5;
		weightedSum += w * s;
	}

	// Cap at realistic max (all 8 categories as errors)
	maxWeight = Object.keys(weights).length * 0.35 * 1.0;
	const rawScore = maxWeight > 0 ? Math.min(1, weightedSum / maxWeight) : 0;
	const score = Math.round(rawScore * 100) / 100;

	return { sessionId: data.sessionId, score, entries };
}

/** Format advice result as markdown. */
export function renderAdviceToMarkdown(result: AdviceResult): string {
	if (result.entries.length === 0) {
		return `# Advice: ${result.sessionId}\n\n*No issues detected. Score: 0.00*\n`;
	}

	const sections: string[] = [];
	sections.push(`# Advice: ${result.sessionId}`);
	sections.push(``);
	sections.push(`**Improvement score: ${result.score.toFixed(2)}** (0 = clean, 1 = needs work)`);
	sections.push(`**Issues found: ${result.entries.length}**`);
	sections.push(``);

	const bySeverity: Record<string, AdviceEntry[]> = { error: [], warning: [], info: [] };
	for (const e of result.entries) {
		(bySeverity[e.severity] ?? bySeverity.info).push(e);
	}

	for (const [severity, label] of [
		["error", "Errors"],
		["warning", "Warnings"],
		["info", "Info"],
	] as const) {
		const group = bySeverity[severity] ?? [];
		if (group.length === 0) continue;

		sections.push(`## ${label}`);
		sections.push(``);
		for (const e of group) {
			const icon = severity === "error" ? "⚠️" : severity === "warning" ? "⚡" : "ℹ️";
			sections.push(`### ${icon} ${e.category}`);
			sections.push(`- **Detail:** ${e.detail}`);
			sections.push(`- **Fix:** ${e.recommendation}`);
			if (e.turns?.length) {
				sections.push(`- **Turns:** ${[...new Set(e.turns)].sort((a, b) => a - b).join(", ")}`);
			}
			sections.push(``);
		}
	}

	return sections.join("\n");
}

/** Parse JSONL file and run analysis. Convenience for post-hoc scripts. */
export function analyzeSessionFile(filepath: string): AdviceResult | null {
	const data = parseJsonlFile(filepath);
	if (!data) return null;
	return analyzeSession(data);
}
