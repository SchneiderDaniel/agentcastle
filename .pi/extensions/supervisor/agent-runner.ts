// ─── Agent Runner ─────────────────────────────────────────────────
// Spawns pi subprocess, parses JSON event stream, maintains live state,
// renders widgets. The biggest module.

import type { AgentRunState, AgentPhase, AgentRunResult, ParsedAgent } from "./types";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolveTools, resolveExtensions } from "./extensions";
import {
	formatTokens,
	formatDuration,
	extractTextFromContent,
	extractSummaryLine,
} from "./formatting";
import { resolveTimeoutMs, DEFAULT_AGENT_TIMEOUT_MS } from "./config";

// Re-export DEFAULT_AGENT_TIMEOUT_MS for backward compatibility
export { DEFAULT_AGENT_TIMEOUT_MS } from "./config";

// ─── Constants ──────────────────────────────────────────────────────

export const MAX_FULL_LOG = 500;
export const WIDGET_LINES = 12;
export const MAX_LIVE_THINKING = 500;

// ─── Pure helpers ───────────────────────────────────────────────────

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

			// ── message_update (streaming events) ────────────
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
								if (trimmed) pushLog(state, `💭 ${trimmed.slice(0, 200)}`);
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

			// ── message_end ──────────────────────────────────
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
									if (t.trim()) pushLog(state, `💭 ${t.slice(0, 200)}`);
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

// ─── runAgent ────────────────────────────────────────────────────────

export async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
): Promise<AgentRunResult> {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = resolveTools(rawTools, agent.config.extensions);
	const model = agent.config.model || "";
	const extFlags = resolveExtensions(agent.config.extensions);

	const args: string[] = [
		"-p",
		"--mode",
		"json",
		task,
		"--system-prompt",
		agent.systemPrompt,
		"--tools",
		tools,
		...extFlags,
		"--no-skills",
		"--no-context-files",
	];
	if (model) args.push("--model", model);

	const widgetId = `agent-${agent.config.name}`;
	const agentName = agent.config.name;
	ctx.ui.notify(`Running agent: ${agentName}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

	const startedAt = Date.now();

	const state: AgentRunState = {
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		phase: "idle",
		startedAt,
		contextInfoReceived: false,
		thinkingPushedThisTurn: false,
		textPushedThisTurn: false,
	};

	return new Promise((resolve) => {
		const child = spawn("/usr/bin/pi", args, {
			cwd: process.cwd(),
			env: { ...process.env, PI_NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});

		const MAX_RAW_STDOUT = 500_000;
		let rawStdout = "";
		let stderr = "";
		let jsonBuffer = "";

		let flushTimer: NodeJS.Timeout | null = null;

		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			ctx.ui.setWidget(widgetId, buildWidgetLines(state, agentName));
			const now = Date.now();
			const parts: string[] = [];
			parts.push(`⏱ ${formatDuration(now - state.startedAt)}`);
			if (state.tokenCount > 0) parts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
			if (state.toolCount > 0) parts.push(`🔧 ${state.toolCount} tools`);
			ctx.ui.setStatus("supervisor", `${agentName}  ${parts.join(" · ")}`);
		};

		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 80);
			}
		};

		const handleLine = (line: string) => {
			const result = processJsonLine(line, state);
			if (result.flush) scheduleFlush();
			if (result.workingChange) {
				const wm = getWorkingMessage(state, agentName);
				ctx.ui.setWorkingMessage(wm ?? undefined);
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (rawStdout.length + chunk.length > MAX_RAW_STDOUT) {
				const keep = MAX_RAW_STDOUT - chunk.length;
				rawStdout = rawStdout.slice(-Math.max(keep, 0)) + chunk;
			} else {
				rawStdout += chunk;
			}
			jsonBuffer += chunk;
			const lines = jsonBuffer.split("\n");
			jsonBuffer = lines.pop() || "";
			for (const line of lines) handleLine(line);
		});

		child.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (stderr.length + chunk.length <= MAX_RAW_STDOUT) {
				stderr += chunk;
			}
		});

		child.on("close", (code, signal) => {
			if (jsonBuffer.trim()) handleLine(jsonBuffer);
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}

			if (state.liveText.trim()) {
				state.textOutputLines.push(state.liveText.trim());
			}
			if (state.liveThinking.trim()) {
				state.thinkingOutputLines.push(state.liveThinking.trim());
			}

			const durationMs = Date.now() - startedAt;
			const textOutput = state.fullLog.join("\n").trim();
			const textOnly = state.textOutputLines.join("\n").trim();
			const rawOutput = rawStdout + (stderr ? "\n[STDERR]\n" + stderr : "");
			const killed = signal !== null;
			const success = code === 0 && !killed;
			if (killed) {
				pushLog(
					state,
					`[Timeout: ${agentName} killed by ${signal} after ${formatDuration(durationMs)}]`,
				);
			}

			const thinkingOutput =
				state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined;

			const summaryLine = extractSummaryLine(textOutput, success, agentName);

			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus("supervisor", "");

			resolve({
				output: rawOutput,
				success,
				agentName,
				toolCount: state.toolCount,
				tokenCount: state.tokenCount,
				durationMs,
				textOutput,
				textOnly,
				summaryLine,
				errorOutput: stderr,
				thinkingOutput,
			});
		});

		child.on("error", (err) => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus("supervisor", "");
			resolve({
				output: `Failed to start pi: ${err.message}`,
				success: false,
				agentName: agent.config.name,
				toolCount: 0,
				tokenCount: 0,
				durationMs: Date.now() - startedAt,
				textOutput: "",
				textOnly: "",
				summaryLine: `Failed to start: ${err.message}`,
				errorOutput: err.message,
			});
		});
	});
}
