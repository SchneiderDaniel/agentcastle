// ─── Agent Session Runner (In-Process SDK) ────────────────────────
// Runs agents in-process via createAgentSession() from the pi SDK.
// Replaces subprocess spawn for complete output capture.
//
// Responsibilities:
//  1. Resolve model from agent config string via ModelRegistry + AuthStorage
//  2. Build tool list: built-in + extension tools
//  3. Create AgentSession with SessionManager.inMemory()
//  4. Subscribe to session events → update TUI widget + collect output
//  5. Run session.prompt(task) with timeout
//  6. Extract complete messages → build AgentRunResult (untruncated)
//  7. Always dispose session on completion

import type { ParsedAgent, AgentRunResult, AgentRunState, AgentPhase } from "./types";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	DefaultResourceLoader,
	ModelRegistry,
	AuthStorage,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { resolveTools, resolveExtensionPaths } from "./extensions";
import {
	formatDuration,
	extractSummaryLine,
	formatTokens,
	buildSubagentStatusLine,
	extractTextFromContent,
} from "./formatting";
import { pushLog, buildWidgetLines, getWorkingMessage } from "./agent-stream";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./config";

// Re-export for backward compatibility
export { DEFAULT_AGENT_TIMEOUT_MS } from "./config";

// ─── Model Resolution ───────────────────────────────────────────────

/**
 * Parse a model string (e.g. "opencode-go/deepseek-v4-flash") into
 * provider and modelId components. Returns null if invalid.
 */
export function resolveModelString(
	modelString: string,
): { provider: string; modelId: string } | null {
	if (!modelString || !modelString.trim()) return null;
	const parts = modelString.split("/");
	if (parts.length !== 2) return null;
	return { provider: parts[0]!, modelId: parts[1]! };
}

/**
 * Resolve a model from agent config via ModelRegistry + AuthStorage.
 * Falls back to first available model if the specified model is not found.
 */
export async function resolveModel(
	modelString: string,
): Promise<{ provider: string; modelId: string } | undefined> {
	const parsed = resolveModelString(modelString);
	if (!parsed) return undefined;

	try {
		const authStorage = AuthStorage.create();
		const registry = ModelRegistry.create(authStorage);
		const model = registry.find(parsed.provider, parsed.modelId);
		if (model) {
			return parsed;
		}
	} catch {
		// Model not found or auth issue — fall back to first available
	}

	// Try to find first available model
	try {
		const authStorage = AuthStorage.create();
		const registry = ModelRegistry.create(authStorage);
		const models = registry.getAll();
		if (models && models.length > 0) {
			const first = models[0];
			const id = first.id || first.model || "";
			const prov = first.provider || "";
			if (prov && id) {
				return { provider: prov, modelId: id };
			}
		}
	} catch {
		// No models available
	}

	return undefined;
}

// ─── Tool List Building ─────────────────────────────────────────────

/**
 * Build a deduplicated array of tool names from agent config.
 * Uses resolveTools from extensions module for consistency.
 */
export function buildToolList(agent: ParsedAgent, cwd: string): string[] {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const toolsStr = resolveTools(rawTools, agent.config.extensions, cwd);
	return toolsStr
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// ─── Event → State Mapping ─────────────────────────────────────────

/**
 * Process a single session event — mirrors processJsonLine logic
 * but receives typed SDK events instead of parsed JSON lines.
 */
function processSessionEvent(
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
						// Push complete thinking lines to log immediately
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
						// Push complete lines to log immediately for persistent display
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
function phasePriority(phase: AgentPhase): number {
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

/** Determine phase from an event */
function getEventPhase(ev: any): AgentPhase {
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

// ─── Result Assembly ────────────────────────────────────────────────

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
function buildAgentRunResult(
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

	return {
		output: rawOutput,
		success,
		agentName,
		toolCount: state.toolCount,
		tokenCount: state.tokenCount,
		durationMs,
		textOutput,
		textOnly,
		summaryLine,
		errorOutput: "",
		thinkingOutput,
	};
}

// ─── Main: runAgentInProcess ────────────────────────────────────────

/**
 * Run an agent in-process via the pi SDK.
 *
 * Creates an ephemeral AgentSession, subscribes to events for live TUI updates,
 * runs the prompt with timeout, and returns a complete untruncated AgentRunResult.
 *
 * Always disposes the session on completion (success, timeout, or error).
 */
export async function runAgentInProcess(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
): Promise<AgentRunResult> {
	const cwd = ctx.cwd || process.cwd();
	const agentName = agent.config.name;
	const widgetId = `agent-${agentName}`;

	ctx.ui.notify(`Running agent (in-process): ${agentName}...`, "info");
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

	// Resolve model
	const modelInfo = await resolveModel(agent.config.model || "");
	let resolvedModel: any;
	if (modelInfo) {
		try {
			resolvedModel = getModel(modelInfo.provider, modelInfo.modelId);
		} catch {
			// getModel threw — try fallback
		}
	}

	// Build tool list
	const tools = buildToolList(agent, cwd);

	// Resolve extension paths for resource loader
	const extPaths = resolveExtensionPaths(agent.config.extensions, cwd);

	let session;
	let unsubscribe: (() => void) | undefined;
	let abortController: AbortController | undefined;
	let flushTimer: NodeJS.Timeout | null = null;

	try {
		// Create resource loader with system prompt override and extension paths
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			settingsManager: SettingsManager.inMemory(),
			systemPromptOverride: () => agent.systemPrompt,
			additionalExtensionPaths: extPaths.length > 0 ? extPaths : undefined,
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.inMemory();

		const sessionResult = await createAgentSession({
			sessionManager,
			resourceLoader,
			settingsManager,
			tools: tools.length > 0 ? tools : undefined,
			noTools: tools.length === 0 ? "builtin" : undefined,
			model: resolvedModel,
		});
		session = sessionResult.session;

		// Subscribe to events for live TUI updates
		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			ctx.ui.setWidget(widgetId, buildWidgetLines(state, agentName));
			ctx.ui.setStatus(
				"supervisor",
				buildSubagentStatusLine(
					agentName,
					state.startedAt,
					state.tokenCount,
					state.toolCount,
					state.contextInfoReceived,
					state.contextWindow,
					Date.now(),
					ctx.ui.theme,
				),
			);
		};

		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 80);
			}
		};

		unsubscribe = session.subscribe((event: any) => {
			const result = processSessionEvent(event, state);
			if (result.flush) scheduleFlush();
			if (result.workingChange) {
				const wm = getWorkingMessage(state, agentName);
				ctx.ui.setWorkingMessage(wm ?? undefined);
			}
		});

		// Run prompt with timeout via AbortSignal
		abortController = new AbortController();
		const timeoutId = setTimeout(() => abortController!.abort(), timeoutMs);

		try {
			await session.prompt(task, {
				signal: abortController.signal,
				streamingBehavior: "steer",
			});
		} catch (promptErr: unknown) {
			// Check if this was a timeout
			if (abortController.signal.aborted) {
				const durationMs = Date.now() - startedAt;
				pushLog(state, `[Timeout: ${agentName} killed after ${formatDuration(durationMs)}]`);

				if (state.liveText.trim()) {
					state.textOutputLines.push(state.liveText.trim());
				}
				if (state.liveThinking.trim()) {
					state.thinkingOutputLines.push(state.liveThinking.trim());
				}

				// Cleanup
				try {
					session?.dispose();
				} catch {}
				try {
					unsubscribe?.();
				} catch {}
				if (flushTimer) clearTimeout(flushTimer);
				ctx.ui.setWidget(widgetId, undefined);
				ctx.ui.setWorkingMessage(undefined);
				ctx.ui.setStatus("supervisor", "");

				const messages = session?.state?.messages || [];
				return buildAgentRunResult(state, agentName, false, durationMs, messages);
			}
			// Re-throw other errors to be caught by outer catch
			throw promptErr;
		} finally {
			clearTimeout(timeoutId);
		}

		// Success path
		if (state.liveText.trim()) {
			state.textOutputLines.push(state.liveText.trim());
		}
		if (state.liveThinking.trim()) {
			state.thinkingOutputLines.push(state.liveThinking.trim());
		}

		// Flush final widget
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}

		// Unsubscribe and dispose
		try {
			unsubscribe?.();
		} catch {}
		try {
			session?.dispose();
		} catch {}

		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", "");

		const durationMs = Date.now() - startedAt;
		const messages = session?.state?.messages || [];

		return buildAgentRunResult(state, agentName, true, durationMs, messages);
	} catch (err: unknown) {
		// Error path — always cleanup
		try {
			session?.dispose();
		} catch {}
		try {
			unsubscribe?.();
		} catch {}
		if (flushTimer) clearTimeout(flushTimer);

		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", "");

		const durationMs = Date.now() - startedAt;
		const errorMsg = err instanceof Error ? err.message : String(err);

		return {
			output: `In-process agent failed: ${errorMsg}`,
			success: false,
			agentName,
			toolCount: state.toolCount,
			tokenCount: state.tokenCount,
			durationMs,
			textOutput: state.fullLog.join("\n").trim(),
			textOnly: state.textOutputLines.join("\n").trim(),
			summaryLine: `Failed: ${errorMsg.slice(0, 120)}`,
			errorOutput: errorMsg,
			thinkingOutput:
				state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined,
		};
	}
}
