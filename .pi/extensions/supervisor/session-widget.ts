// ─── Session Widget Builders ──────────────────────────────────────
// Pure functions for TUI widget building — no side effects.
// Extracted from agent-stream.ts to keep files modular.

import type { AgentRunState } from "./types";
import { formatTokens, formatDuration, boldText, getTermWidth } from "./formatting.ts";
import { Container, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { WIDGET_LINES, MAX_LIVE_THINKING, pushLog } from "./agent-stream.ts";

// Re-export constants for backward compatibility
export { WIDGET_LINES, MAX_LIVE_THINKING } from "./agent-stream.ts";

/**
 * Build widget lines from state. Pure function — no side effects.
 * Returns at most WIDGET_LINES (20) lines. Kept for backward compat (subprocess path).
 */
export function buildWidgetLines(
	state: AgentRunState,
	agentName: string,
	model?: string,
): string[] {
	const lines: string[] = [];
	const now = Date.now();

	// Header
	lines.push(`⚙ ${agentName}`);

	// Context line
	if (
		state.contextInfoReceived &&
		state.contextTokens !== undefined &&
		state.contextWindow !== undefined
	) {
		lines.push(
			`  Context: ${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`,
		);
	} else {
		lines.push("  Context: computing...");
	}

	// Live thinking (unconsumed part — stays in buffer until newline)
	if (state.phase === "thinking" && state.liveThinking.trim()) {
		const preview = state.liveThinking.trimEnd().slice(-200);
		lines.push(`  💭 ${preview}`);
	}

	// Current tool display
	if (state.currentTool) {
		const toolLabel = state.currentToolArgs
			? `${state.currentTool}: ${state.currentToolArgs.slice(0, 80)}`
			: state.currentTool;
		lines.push(`  🔧 ${toolLabel}`);
	}

	// Recent fullLog entries (lines streamed in real-time)
	const remaining = WIDGET_LINES - lines.length - 1;
	if (remaining > 0 && state.fullLog.length > 0) {
		const recent = state.fullLog.slice(-remaining);
		for (const entry of recent) {
			const display = entry.length > 200 ? entry.slice(0, 197) + "..." : entry;
			lines.push(`  ${display}`);
		}
	}

	// Live text (unconsumed part — partial line waiting for newline)
	if (state.phase === "text" && state.liveText.trim()) {
		const partial = state.liveText.trimEnd().slice(-200);
		lines.push(`  ${partial}`);
	}

	// Stats footer
	const statsParts: string[] = [];
	const shortModel = model ? model.split("/").pop() || model : undefined;
	statsParts.push(`subagent:${agentName}`);
	if (shortModel) statsParts.push(`🧠 ${shortModel}`);
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	const elapsed = formatDuration(now - state.startedAt);
	statsParts.push(`⏱ ${elapsed}`);
	if (statsParts.length > 0) {
		lines.push(`  ${statsParts.join(" · ")}`);
	}

	return lines.slice(0, WIDGET_LINES);
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

	// ── Stats footer ──
	const statsParts: string[] = [];
	const shortModel = model ? model.split("/").pop() || model : undefined;
	statsParts.push(`subagent:${agentName}`);
	if (shortModel) statsParts.push(`🧠 ${shortModel}`);
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
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
