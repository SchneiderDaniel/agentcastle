// ─── Agent Runner ─────────────────────────────────────────────────
// Spawns pi subprocess, parses JSON event stream, maintains live state,
// renders widgets. Subprocess lifecycle only — parsing lives in
// agent-stream.ts.

import type { AgentRunResult, AgentRunState, AgentPhase, ParsedAgent } from "./types";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { resolveTools, resolveExtensions } from "./extensions";
import { formatDuration, extractSummaryLine, formatTokens } from "./formatting";
import { resolveTimeoutMs, DEFAULT_AGENT_TIMEOUT_MS } from "./config";
import {
	processJsonLine,
	getPhaseFromEvent,
	filterStderr,
	phasePriority,
	pushLog,
	buildWidgetLines,
	getWorkingMessage,
	MAX_FULL_LOG,
	WIDGET_LINES,
	MAX_LIVE_THINKING,
} from "./agent-stream";

// Re-export DEFAULT_AGENT_TIMEOUT_MS for backward compatibility
export { DEFAULT_AGENT_TIMEOUT_MS } from "./config";

// ─── runAgent ────────────────────────────────────────────────────────

export async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
): Promise<AgentRunResult> {
	const cwd = ctx.cwd || process.cwd();

	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = resolveTools(rawTools, agent.config.extensions, cwd);
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
	if (agent.config.thinking && agent.config.thinking.trim()) {
		args.push("--thinking", agent.config.thinking.trim());
	}

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
			cwd,
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
			if (state.tokenCount > 0) {
				let tokenStr = `${formatTokens(state.tokenCount)} tokens`;
				// Color token count based on context window % thresholds (same as main footer)
				if (
					state.contextInfoReceived &&
					state.contextWindow !== undefined &&
					state.contextWindow > 0
				) {
					const pct = (state.tokenCount / state.contextWindow) * 100;
					if (pct > 90) {
						tokenStr = `${ctx.ui.theme.fg("error", formatTokens(state.tokenCount))} tokens`;
					} else if (pct > 70) {
						tokenStr = `${ctx.ui.theme.fg("warning", formatTokens(state.tokenCount))} tokens`;
					}
				}
				parts.push(`📊 ${tokenStr}`);
			}
			if (state.toolCount > 0) parts.push(`🔧 ${state.toolCount} tools`);
			ctx.ui.setStatus("supervisor", `subagent: ${agentName}  ${parts.join(" · ")}`);
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
			const filteredStderr = filterStderr(stderr);

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
				errorOutput: filteredStderr,
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
