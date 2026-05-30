// ─── Session Result Assembly ──────────────────────────────────────
// Build AgentRunResult from session state and message history.
// Extracted from agent-session-runner.ts to keep files modular.

import type { AgentRunState, AgentRunResult } from "./types";
import { extractTextFromContent, extractSummaryLine } from "./formatting";

/**
 * Build complete raw output string from session message history.
 * NO truncation — full message content is preserved.
 */
function buildRawOutputFromMessages(messages: any[]): string {
	if (!Array.isArray(messages) || messages.length === 0) return "";

	const parts: string[] = [];

	for (const msg of messages) {
		if (!msg) continue;

		const role = msg.role || "unknown";
		const toolName = msg.toolName || "";

		if (msg.content && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (!block || typeof block !== "object") continue;

				switch (block.type) {
					case "text": {
						if (block.text) {
							parts.push(`[${role.toUpperCase()}]`);
							parts.push(block.text);
						}
						break;
					}
					case "thinking": {
						if (block.thinking) {
							const t =
								typeof block.thinking === "string"
									? block.thinking
									: JSON.stringify(block.thinking);
							parts.push(`[${role.toUpperCase()} THINKING]`);
							parts.push(t);
						}
						break;
					}
					case "tool_use": {
						if (block.name) {
							parts.push(`[TOOL_USE: ${block.name}]`);
							if (block.input) {
								parts.push(JSON.stringify(block.input, null, 2));
							}
						}
						break;
					}
					case "tool_result": {
						parts.push(`[TOOL_RESULT${toolName ? `: ${toolName}` : ""}]`);
						const text = extractTextFromContent(block.content || block.result || "");
						if (text) parts.push(text);
						break;
					}
				}
			}
		} else if (typeof msg.content === "string") {
			parts.push(`[${role.toUpperCase()}]`);
			parts.push(msg.content);
		}
	}

	return parts.join("\n");
}

/**
 * Build AgentRunResult from session state and messages.
 * Uses full untruncated message content for rawOutput.
 */
export function buildAgentRunResult(
	state: AgentRunState,
	agentName: string,
	success: boolean,
	durationMs: number,
	messages: any[],
): AgentRunResult {
	const textOutput = state.fullLog.join("\n").trim();
	const textOnly = state.textOutputLines.join("\n").trim();
	const rawOutput = buildRawOutputFromMessages(messages);
	const thinkingOutput =
		state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined;
	const summaryLine = extractSummaryLine(textOutput, success, agentName);

	// Token fallback: scan messages for assistant usage data
	let tokenCount = state.tokenCount;
	if (Array.isArray(messages) && messages.length > 0) {
		const scannedSum = messages
			.filter((m) => m && m.role === "assistant" && m.usage)
			.reduce((sum, m) => {
				const u = m.usage;
				const total = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
				return sum + (typeof total === "number" && !Number.isNaN(total) ? total : 0);
			}, 0);
		tokenCount = Math.max(state.tokenCount, scannedSum);
	}

	return {
		output: rawOutput,
		success,
		agentName,
		toolCount: state.toolCount,
		tokenCount: tokenCount,
		durationMs,
		textOutput,
		textOnly,
		summaryLine,
		errorOutput: "",
		thinkingOutput,
	};
}
