// ─── Session Event Processors ────────────────────────────────────
// Event processing for both in-process SDK events and subprocess JSON lines.
// Extracted from agent-session-runner.ts to keep files modular.

import type { AgentRunState, AgentPhase } from "./types";
import { pushLog } from "./agent-stream";
import { extractTextFromContent } from "./formatting";

// ─── Event → State Mapping ─────────────────────────────────────────

/**
 * Process a single session event — mirrors processJsonLine logic
 * but receives typed SDK events instead of parsed JSON lines.
 */
export function processSessionEvent(
	ev: any,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	const prevPhase = state.phase;

	switch (ev.type) {
		case "context_info":
			// context_info event removed in new agent-core — skip
			break;

		case "tool_execution_start": {
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
			const ae = ev.assistantMessageEvent;
			if (!ae) break;

			const eventPhase = getEventPhase(ev);
			if (eventPhase !== "idle" && phasePriority(eventPhase) >= phasePriority(state.phase)) {
				state.phase = eventPhase;
			}

			switch (ae.type) {
				case "thinking_start": {
					state.thinkingPushedThisTurn = false;
					return { flush: true, workingChange: prevPhase !== "thinking" };
				}
				case "text_start": {
					state.textPushedThisTurn = false;
					return { flush: true, workingChange: prevPhase !== "text" };
				}
				case "thinking_delta": {
					const td = ae.delta;
					if (typeof td === "string" && td.length > 0) {
						state.liveThinking += td;
						if (state.liveThinking.length > 1000) {
							state.liveThinking = state.liveThinking.slice(-1000);
						}
						let nlIdx;
						while ((nlIdx = state.liveThinking.indexOf("\n")) !== -1) {
							const line = state.liveThinking.slice(0, nlIdx);
							state.liveThinking = state.liveThinking.slice(nlIdx + 1);
							if (line.trim()) pushLog(state, `💭 ${line}`);
						}
						return { flush: true, workingChange: prevPhase !== "thinking" };
					}
					break;
				}
				case "text_delta": {
					const td = ae.delta;
					if (typeof td === "string" && td.length > 0) {
						state.liveText += td;
						if (state.liveText.length > 10_000) {
							state.liveText = state.liveText.slice(-8_000);
						}
						let nlIdx;
						while ((nlIdx = state.liveText.indexOf("\n")) !== -1) {
							const line = state.liveText.slice(0, nlIdx);
							state.liveText = state.liveText.slice(nlIdx + 1);
							if (line.trim()) pushLog(state, line);
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
							if (trimmed) pushLog(state, `💭 ${trimmed}`);
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
					if (ev.message?.usage) {
						state.tokenCount =
							ev.message.usage.totalTokens ||
							ev.message.usage.input + ev.message.usage.output ||
							state.tokenCount;
					}
					state.liveText = "";
					state.phase = "idle";
					return { flush: true, workingChange: true };
				}
				case "done": {
					const msg = ae.message;
					if (msg?.usage) {
						state.tokenCount =
							msg.usage.totalTokens || msg.usage.input + msg.usage.output || state.tokenCount;
					}
					if (msg?.content && Array.isArray(msg.content)) {
						const textParts: string[] = [];
						const thinkingParts: string[] = [];
						for (const block of msg.content) {
							if (block.type === "text" && block.text) {
								textParts.push(block.text);
							}
							if (block.type === "thinking" && block.thinking) {
								const t =
									typeof block.thinking === "string"
										? block.thinking
										: JSON.stringify(block.thinking);
								thinkingParts.push(t);
							}
						}
						if (!state.textPushedThisTurn && textParts.length > 0) {
							const allText = textParts.join("\n").trim();
							if (allText) {
								state.textOutputLines.push(allText);
								for (const t of allText.split("\n")) {
									if (t.trim()) pushLog(state, t);
								}
							}
						}
						if (!state.thinkingPushedThisTurn && thinkingParts.length > 0) {
							const allThinking = thinkingParts.join("\n").trim();
							if (allThinking) {
								state.thinkingOutputLines.push(allThinking);
								for (const t of allThinking.split("\n")) {
									if (t.trim()) pushLog(state, `💭 ${t}`);
								}
							}
						}
					}
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
									: JSON.stringify(block.thinking);
							for (const t of thinkingText.split("\n")) {
								if (t.trim()) pushLog(state, `💭 ${t.trim()}`);
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

		case "turn_start":
		case "turn_end":
		case "agent_start":
		case "agent_end":
			break;
	}

	return { flush: false, workingChange: false };
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

/** Determine phase from a session event */
export function getEventPhase(ev: any): AgentPhase {
	if (!ev) return "idle";
	if (ev.type === "tool_execution_start") return "tool";
	if (ev.type === "tool_execution_end") return "idle";
	if (ev.type === "message_update") {
		const ae = ev.assistantMessageEvent;
		if (!ae) return "idle";
		switch (ae.type) {
			case "thinking_delta":
				if (ae.delta) return "thinking";
				break;
			case "thinking_start":
				return "thinking";
			case "text_delta":
				if (ae.delta) return "text";
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
