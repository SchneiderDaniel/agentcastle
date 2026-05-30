// ─── Agent Runner ─────────────────────────────────────────────────
// Dispatcher: tries in-process SDK runner first, falls back to subprocess.
// Subprocess path retained as backward-compatible fallback.
//
// In-process runner lives in agent-session-runner.ts
// Subprocess lifecycle lives in this file (parsing in agent-stream.ts).

import type { AgentRunResult, AgentRunState, AgentPhase, ParsedAgent } from "./types";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
	MAX_FULL_LOG,
	WIDGET_LINES,
	MAX_LIVE_THINKING,
} from "./agent-stream";
import { buildWidgetLines, getWorkingMessage } from "./session-widget";
import { runAgentInProcess } from "./agent-session-runner";

// Re-export DEFAULT_AGENT_TIMEOUT_MS for backward compatibility
export { DEFAULT_AGENT_TIMEOUT_MS } from "./config";

// ─── runAgent (Primary: in-process, Fallback: subprocess) ──────────

export async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
): Promise<AgentRunResult> {
	// Primary: in-process via SDK
	try {
		return await runAgentInProcess(agent, task, ctx, pi, timeoutMs, cwd);
	} catch (err) {
		console.error(`[supervisor] In-process runner failed, falling back to subprocess: ${err}`);
		// Fallback: subprocess (existing code)
		return await runAgentSubprocess(agent, task, ctx, timeoutMs, cwd);
	}
}

// ─── runAgentSubprocess (Fallback) ─────────────────────────────────

export async function runAgentSubprocess(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
): Promise<AgentRunResult> {
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
	// Pass worktree path to worktree-sandbox extension for path confinement
	const sandboxEnv = cwd ? { WORKTREE_SANDBOX_PATH: cwd } : {};

	const rawTools = agent.config.tools || "read,bash,write,edit";
	const tools = resolveTools(rawTools, agent.config.extensions, effectiveCwd);
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
			cwd: effectiveCwd,
			env: { ...process.env, PI_NO_COLOR: "1", ...sandboxEnv },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
		});

		const MAX_RAW_STDOUT = 500_000;
		let rawStdout = "";
		let stderr = "";
		let jsonBuffer = "";
		let childExited = false;

		let flushTimer: NodeJS.Timeout | null = null;

		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			try {
				ctx.ui.setWidget(widgetId, buildWidgetLines(state, agentName, model));
				ctx.ui.setStatus("supervisor", undefined);
			} catch (renderErr: unknown) {
				const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
				console.error(`[supervisor] widget render error for ${agentName}: ${msg}`);
			}
		};

		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 300);
			}
		};

		// Gentle 2s heartbeat — keeps terminal alive during quiet periods.
		// Original freeze was from requestRender(true) + 5s interval, not heartbeat itself.
		// Without heartbeat, terminal stops rendering between events — "stuck until keystroke".
		// flushWidget calls setWidget which calls requestRender (coalesced by TUI to 16ms).
		// Try-catch prevents uncaught exceptions from killing the interval.
		const heartbeatTimer = setInterval(() => {
			try {
				if (!flushTimer) flushWidget();
			} catch (hbErr: unknown) {
				const msg = hbErr instanceof Error ? hbErr.message : String(hbErr);
				console.error(`[supervisor] heartbeat error for ${agentName}: ${msg}`);
			}
		}, 2000);

		// Event-driven flush at 300ms debounce + 2s heartbeat.
		// Try-catch prevents uncaught exceptions from breaking the JSON stream processing.
		const handleLine = (line: string) => {
			try {
				const result = processJsonLine(line, state);
				if (result.flush) scheduleFlush();
				if (result.workingChange) {
					const wm = getWorkingMessage(state, agentName);
					ctx.ui.setWorkingMessage(wm ?? undefined);
				}
			} catch (lineErr: unknown) {
				const msg = lineErr instanceof Error ? lineErr.message : String(lineErr);
				console.error(`[supervisor] JSON line error for ${agentName}: ${msg}`);
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

		// ── Bug 3 fix: Proper child reaping ──
		// Register 'exit' to reap child process entry (prevents zombie).
		// 'close' fires after stdio drains — use it for final resolve with code/signal.
		// Guard with resolved flag to prevent double-resolve.
		let resolved = false;

		const doResolve = (code: number | null, signal: string | null) => {
			if (resolved) return;
			resolved = true;

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
		};

		// 'exit' reaps process table entry — prevents zombie
		child.on("exit", () => {
			childExited = true;
		});

		// 'close' fires after stdio drains — resolve with actual code/signal
		child.on("close", (code, signal) => {
			childExited = true;
			doResolve(code, signal);
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
