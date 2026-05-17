// ─── Agent Stream Helpers ──────────────────────────────────────────
// Pure functions for JSON event parsing, widget building, phase tracking.
// No side effects, no subprocess imports — fully testable.

import type { AgentRunState, AgentPhase } from "./types";
import { formatTokens, formatDuration } from "./formatting";

// ─── Constants ──────────────────────────────────────────────────────

export const MAX_FULL_LOG = 500;
export const WIDGET_LINES = 12;
export const MAX_LIVE_THINKING = 500;

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Filter known non-error patterns from stderr output.
 * Prevents telemetry noise from polluting error detection.
 */
export function filterStderr(raw: string): string {
	return raw
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith('{"type":"context_info"')) return false;
			if (!trimmed) return false;
			return true;
		})
		.join("\n")
		.trim();
}

/** Numeric priority for phase ordering. Higher = more important. */
export function phasePriority(phase: AgentPhase): number {
	switch (phase) {
		case "tool":
			return 3;
		case "thinking":
			return 2;
		case "text":
			return 1;
		case "idle":
			return 0;
	}
}

export function pushLog(state: AgentRunState, entry: string): void {
	state.fullLog.push(entry);
	if (state.fullLog.length > MAX_FULL_LOG) state.fullLog.shift();
}

/** Determine phase from a JSON event. Tool > thinking > text > idle. */
export function getPhaseFromEvent(ev: any): AgentPhase {
	if (!ev) return "idle";

	if (ev.type === "tool_execution_start") return "tool";
	if (ev.type === "tool_execution_end") return "idle";

	if (ev.type === "message_update") {
		const delta = ev.delta;
		if (!delta) return "idle";
		switch (delta.type) {
			case "thinking_delta":
				if (delta.thinking_delta) return "thinking";
				break;
			case "thinking_start":
				return "thinking";
			case "text_delta":
				if (delta.text_delta) return "text";
				break;
			case "text_start":
				return "text";
			case "thinking_end":
			case "text_end":
				return "idle";
		}
	}

	if (ev.type === "message_end") return "idle";
	return "idle";
}

/**
 * Process a single JSON line from pi's stdout.
 * Mutates state in place. Returns flush + workingChange flags.
 */
export function processJsonLine(
	line: string,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	if (!line.trim()) return { flush: false, workingChange: false };
	try {
		const ev = JSON.parse(line);
		switch (ev.type) {
			case "session":
				break;

			case "context_info": {
				const tokens = ev.contextTokens;
				const window = ev.contextWindow;
				if (typeof tokens === "number" && typeof window === "number" && window > 0) {
					state.contextTokens = tokens;
					state.contextWindow = window;
					state.contextInfoReceived = true;
					pushLog(state, `📊 Context: ${formatTokens(tokens)}/${formatTokens(window)} (initial)`);
					return { flush: true, workingChange: false };
				}
				break;
			}

			case "tool_execution_start": {
				const prevPhase = state.phase;
				state.currentTool = ev.toolName || "tool";
				state.currentToolArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : undefined;
				state.lastToolName = ev.toolName;
				state.phase = "tool";
				const logArgs = ev.args ? JSON.stringify(ev.args).slice(0, 200) : "";
				pushLog(state, `🔧 ${ev.toolName}${logArgs ? ` ${logArgs}` : ""}`);
				return { flush: true, workingChange: prevPhase !== "tool" };
			}

			case "tool_execution_end": {
				state.toolCount++;
				state.currentTool = undefined;
				state.currentToolArgs = undefined;
				state.phase = "idle";
				pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
				return { flush: true, workingChange: true };
			}

			case "message_update": {
				const delta = ev.delta;
				if (!delta) break;

				const prevPhase = state.phase;
				const eventPhase = getPhaseFromEvent(ev);
				if (eventPhase !== "idle" && phasePriority(eventPhase) >= phasePriority(state.phase)) {
					state.phase = eventPhase;
				}

				switch (delta.type) {
					case "thinking_start": {
						state.thinkingPushedThisTurn = false;
						return { flush: true, workingChange: prevPhase !== "thinking" };
					}
					case "text_start": {
						state.textPushedThisTurn = false;
						return { flush: true, workingChange: prevPhase !== "text" };
					}
					case "thinking_delta": {
						const td = delta.thinking_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveThinking += td;
							if (state.liveThinking.length > MAX_LIVE_THINKING * 2) {
								state.liveThinking = state.liveThinking.slice(-MAX_LIVE_THINKING);
							}
							return { flush: true, workingChange: prevPhase !== "thinking" };
						}
						break;
					}

					case "text_delta": {
						const td = delta.text_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveText += td;
							if (state.liveText.length > 10_000) {
								state.liveText = state.liveText.slice(-8_000);
							}
							return { flush: true, workingChange: prevPhase !== "text" };
						}
						break;
					}

					case "thinking_end": {
						if (state.liveThinking.trim()) {
							state.thinkingOutputLines.push(state.liveThinking.trim());
							for (const t of state.liveThinking.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, `💭 ${trimmed.slice(0, 500)}`);
							}
							state.thinkingPushedThisTurn = true;
						}
						state.liveThinking = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}

					case "text_end": {
						if (state.liveText.trim()) {
							state.textOutputLines.push(state.liveText.trim());
							for (const t of state.liveText.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, trimmed);
							}
							state.textPushedThisTurn = true;
						}
						if (ev.usage) {
							state.tokenCount =
								ev.usage.totalTokens || ev.usage.input + ev.usage.output || state.tokenCount;
						}
						state.liveText = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}
				}
				break;
			}

			case "message_end": {
				const msg = ev.message;
				if (!msg) break;

				if (msg.role === "assistant") {
					if (!state.thinkingPushedThisTurn && Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "thinking" && block.thinking) {
								const thinkingText =
									typeof block.thinking === "string"
										? block.thinking
										: JSON.stringify(block.thinking).slice(0, 500);
								for (const t of thinkingText.split("\n")) {
									if (t.trim()) pushLog(state, `💭 ${t.slice(0, 500)}`);
								}
							}
						}
					}
					if (!state.textPushedThisTurn) {
						const text = extractTextFromContent(msg.content);
						if (text && text.trim()) {
							state.textOutputLines.push(text.trim());
							for (const t of text.split("\n")) {
								if (t.trim()) pushLog(state, t);
							}
						}
					}
					if (msg.usage) {
						state.tokenCount = msg.usage.totalTokens || msg.usage.input + msg.usage.output;
					}
				} else if (msg.role === "toolResult") {
					const resultText = extractTextFromContent(msg.content);
					const label = msg.toolName || state.lastToolName || "tool";
					if (resultText && resultText.trim()) {
						const resultLines = resultText.split("\n");
						pushLog(state, `📋 ${label}: ${resultLines[0]?.slice(0, 300) || "(no output)"}`);
						for (let i = 1; i < Math.min(resultLines.length, 6); i++) {
							if (resultLines[i].trim()) pushLog(state, `   ${resultLines[i].slice(0, 200)}`);
						}
					} else {
						pushLog(state, `📋 ${label}: (no output)`);
					}
					state.lastToolName = undefined;
				}
				state.phase = "idle";
				state.thinkingPushedThisTurn = false;
				state.textPushedThisTurn = false;
				return { flush: true, workingChange: true };
			}

			case "agent_end":
			case "turn_end":
				break;
		}
	} catch (parseErr: unknown) {
		const preview = line.length > 200 ? line.slice(0, 200) + "…" : line;
		if (line.trim()) {
			console.error(
				`[supervisor] JSON parse error: ${String(parseErr).slice(0, 200)} | line: ${preview}`,
			);
		}
	}
	return { flush: false, workingChange: false };
}

/**
 * Build widget lines from state. Pure function — no side effects.
 * Returns at most WIDGET_LINES (12) lines.
 */
export function buildWidgetLines(state: AgentRunState, agentName: string): string[] {
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

	// Live thinking
	if (state.phase === "thinking" && state.liveThinking.trim()) {
		const live = state.liveThinking.slice(-MAX_LIVE_THINKING);
		const condensed = live.replace(/\s+/g, " ").trim().slice(-100);
		if (condensed) lines.push(`  ... ${condensed}`);
	}

	// Live text
	if (state.phase === "text" && state.liveText.trim()) {
		const live = state.liveText.slice(-500);
		const condensed = live.replace(/\s+/g, " ").trim().slice(-100);
		if (condensed) lines.push(`  ${condensed}`);
	}

	// Current tool display
	if (state.currentTool) {
		const toolLabel = state.currentToolArgs
			? `${state.currentTool}: ${state.currentToolArgs.slice(0, 80)}`
			: state.currentTool;
		lines.push(`  🔧 ${toolLabel}`);
	}

	// Recent fullLog entries
	const remaining = WIDGET_LINES - lines.length - 1;
	if (remaining > 0 && state.fullLog.length > 0) {
		const recent = state.fullLog.slice(-remaining);
		for (const entry of recent) {
			const display = entry.replace(/^[^\s]+\s/, "").slice(0, 90);
			lines.push(`  ${display}`);
		}
	}

	// Stats footer
	const statsParts: string[] = [];
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	const elapsed = formatDuration(now - state.startedAt);
	statsParts.push(`⏱ ${elapsed}`);
	if (statsParts.length > 0) {
		lines.push(`  ${statsParts.join(" · ")}`);
	}

	return lines.slice(0, WIDGET_LINES);
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

// Imported here to keep agent-stream.ts self-contained
function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text" && b.text)
		.map((b: any) => b.text)
		.join("\n");
}
