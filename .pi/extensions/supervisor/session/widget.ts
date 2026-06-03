// ─── Session Widget Builders ──────────────────────────────────────
// Pure functions for TUI widget building — no side effects.
// Extracted from agent-stream.ts to keep files modular.

import type { AgentRunState } from "./types.ts";
import { formatTokens, formatDuration, boldText, getTermWidth } from "./formatting.ts";
import { Container, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { WIDGET_LINES, MAX_LIVE_THINKING } from "./agent-stream.ts";

// Re-export constants for backward compatibility
export { WIDGET_LINES, MAX_LIVE_THINKING } from "./agent-stream.ts";

/**
 * Build widget lines from state. Pure function — no side effects.
 * pi caps string-array widgets at MAX_WIDGET_LINES (10).
 * We reserve space for fixed content + footer so stats are never truncated.
 */
export function buildWidgetLines(
	state: AgentRunState,
	agentName: string,
	model?: string,
	idleWarning?: string | null,
): string[] {
	const now = Date.now();

	// pi caps string-array widgets at 10 lines. Keep footer always visible.
	const MAX = 10;

	// ── Fixed lines (always present) ──
	const fixed: string[] = [];
	fixed.push(`⚙ ${agentName}`);

	if (
		state.contextInfoReceived &&
		state.contextTokens !== undefined &&
		state.contextWindow !== undefined
	) {
		fixed.push(
			`  Context: ${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`,
		);
	} else {
		fixed.push("  Context: computing...");
	}

	// ── Phase-specific lines (0-2) ──
	if (state.phase === "thinking" && state.liveThinking.trim()) {
		fixed.push(`  💭 ${state.liveThinking.trimEnd().slice(-200)}`);
	}
	if (state.currentTool) {
		const toolLabel = state.currentToolArgs
			? `${state.currentTool}: ${state.currentToolArgs.slice(0, 80)}`
			: state.currentTool;
		fixed.push(`  🔧 ${toolLabel}`);
	}

	// ── Live text (0-1 line, between logs and footer) ──
	const hasLiveText = state.phase === "text" && state.liveText.trim();
	const liveTextLine = hasLiveText ? `  ${state.liveText.trimEnd().slice(-200)}` : undefined;

	// ── Idle warning (optional, shown when no events for >15s) ──
	const idleLine = idleWarning ? `  ${idleWarning}` : undefined;

	// ── Cache stats helper ──
	function fmtCacheVal(n: number | undefined | null): string {
		if (n === undefined || n === null) return "--";
		return formatTokens(n);
	}

	// ── Stats footer (always included) ──
	const shortModel = model ? model.split("/").pop() || model : undefined;
	const statsParts: string[] = [`subagent:${agentName}`];
	if (shortModel) statsParts.push(`🧠 ${shortModel}`);
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	const cacheRead = state.cacheRead;
	const cacheWrite = state.cacheWrite;
	if (cacheRead !== undefined || cacheWrite !== undefined) {
		statsParts.push(`📦 ${fmtCacheVal(cacheRead)}/${fmtCacheVal(cacheWrite)}`);
	}
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	statsParts.push(`⏱ ${formatDuration(now - state.startedAt)}`);
	const footer = `  ${statsParts.join(" · ")}`;

	// ── Compute space for log entries ──
	const fixedCount = fixed.length;
	const footerCount = 1;
	const liveTextCount = liveTextLine ? 1 : 0;
	const idleLineCount = idleLine ? 1 : 0;
	const maxLogLines = MAX - fixedCount - liveTextCount - idleLineCount - footerCount;

	const lines: string[] = [...fixed];

	if (maxLogLines > 0 && state.fullLog.length > 0) {
		const recent = state.fullLog.slice(-maxLogLines);
		for (const entry of recent) {
			const display = entry.length > 200 ? entry.slice(0, 197) + "..." : entry;
			lines.push(`  ${display}`);
		}
	}

	if (liveTextLine) lines.push(liveTextLine);
	if (idleLine) lines.push(idleLine);
	lines.push(footer);

	return lines;
}

/**
 * Build a TUI Component (Container) for the live subagent widget.
 * Uses pi's native TUI primitives (Container, Text, Spacer) with theme
 * colors matching the message-renderer style.
 *
 * Called via ctx.ui.setWidget() factory overload: (tui, theme) => Component
 */
export function buildWidgetComponent(
	state: AgentRunState,
	agentName: string,
	model: string | undefined,
	theme: any,
	idleWarning?: string | null,
): Container {
	const now = Date.now();
	const w = Math.max(40, getTermWidth() - 4);
	const fit = (s: string) => truncateToWidth(s, w);

	const c = new Container();

	// ── Header: agent name ──
	c.addChild(new Text(fit(theme.fg("toolTitle", boldText(theme, `⚙ ${agentName}`))), 1, 0));

	// ── Context line ──
	if (
		state.contextInfoReceived &&
		state.contextTokens !== undefined &&
		state.contextWindow !== undefined
	) {
		c.addChild(
			new Text(
				fit(
					theme.fg(
						"dim",
						`  Context: ${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`,
					),
				),
				1,
				0,
			),
		);
	} else {
		c.addChild(new Text(fit(theme.fg("dim", "  Context: computing...")), 1, 0));
	}

	// ── Live thinking (partial line, not yet flushed to fullLog) ──
	if (state.phase === "thinking" && state.liveThinking.trim()) {
		const preview = state.liveThinking.trimEnd().slice(-200);
		c.addChild(new Text(fit(theme.fg("dim", `  💭 ${preview}`)), 1, 0));
	}

	// ── Current tool ──
	if (state.currentTool) {
		const toolLabel = state.currentToolArgs
			? `${state.currentTool}: ${state.currentToolArgs.slice(0, 80)}`
			: state.currentTool;
		c.addChild(new Text(fit(theme.fg("toolTitle", `  🔧 ${toolLabel}`)), 1, 0));
	}

	// ── Log lines with color coding (mirrors message-renderer.ts) ──
	const MAX_WIDGET_LOG = 50;
	const recent = state.fullLog.slice(-MAX_WIDGET_LOG);
	for (const entry of recent) {
		let styledLine: string;
		if (entry.startsWith("🔧 ")) {
			styledLine = theme.fg(
				"toolTitle",
				`  ${entry.length > 200 ? entry.slice(0, 197) + "..." : entry}`,
			);
		} else if (entry.startsWith("✓ ")) {
			styledLine = theme.fg("success", `  ${entry}`);
		} else if (entry.startsWith("✗ ")) {
			styledLine = theme.fg("error", `  ${entry}`);
		} else if (entry.startsWith("💭 ")) {
			styledLine = theme.fg("dim", `  ${entry.slice(0, 200)}`);
		} else if (entry.startsWith("📋 ") || entry.startsWith("📊 ")) {
			styledLine = theme.fg("dim", `  ${entry.slice(0, 200)}`);
		} else {
			styledLine = `  ${entry.length > 200 ? entry.slice(0, 197) + "..." : entry}`;
		}
		for (const wrapped of wrapTextWithAnsi(styledLine, w)) {
			c.addChild(new Text(wrapped, 1, 0));
		}
	}

	// ── Live text (partial line, not yet flushed) ──
	if (state.phase === "text" && state.liveText.trim()) {
		const partial = state.liveText.trimEnd().slice(-200);
		c.addChild(new Text(fit(`  ${partial}`), 1, 0));
	}

	// ── Idle warning (optional) ──
	if (idleWarning) {
		c.addChild(new Text(fit(theme.fg("warning", `  ${idleWarning}`)), 1, 0));
	}

	// ── Cache stats helper ──
	function fmtCacheVal(n: number | undefined | null): string {
		if (n === undefined || n === null) return "--";
		return formatTokens(n);
	}

	// ── Stats footer ──
	const statsParts: string[] = [];
	const shortModel = model ? model.split("/").pop() || model : undefined;
	statsParts.push(`subagent:${agentName}`);
	if (shortModel) statsParts.push(`🧠 ${shortModel}`);
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	const cacheRead = state.cacheRead;
	const cacheWrite = state.cacheWrite;
	if (cacheRead !== undefined || cacheWrite !== undefined) {
		statsParts.push(`📦 ${fmtCacheVal(cacheRead)}/${fmtCacheVal(cacheWrite)}`);
	}
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	const elapsed = formatDuration(now - state.startedAt);
	statsParts.push(`⏱ ${elapsed}`);
	if (statsParts.length > 0) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(fit(theme.fg("dim", `  ${statsParts.join(" · ")}`)), 1, 0));
	}

	return c;
}

/** Build working message from phase. Priority: tool > thinking > text. */
export function getWorkingMessage(state: AgentRunState, agentName: string): string | null {
	switch (state.phase) {
		case "tool":
			if (state.currentTool) return `${agentName}: ${state.currentTool}`;
			return `${agentName}: working...`;
		case "thinking":
			return `${agentName}: thinking...`;
		case "text":
			return `${agentName}: responding...`;
		default:
			return null;
	}
}
