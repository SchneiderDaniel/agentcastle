// ─── Agent Session Runner (In-Process) ────────────────────────────
// Runs an agent directly inside the supervisor process using createAgentSession()
// from the pi SDK. Replaces the subprocess spawn as the primary execution path.
//
// Responsibilities:
// 1. Resolve model from agent config via ModelRegistry + AuthStorage
// 2. Build tool list (built-in + extension tools)
// 3. Create AgentSession with SessionManager.inMemory()
// 4. Subscribe to session events → TUI widget + collect all output
// 5. Run session.prompt(task) with timeout
// 6. Extract messages → build AgentRunResult (full untruncated output)

import type { AgentRunResult, AgentRunState, AgentPhase, ParsedAgent } from "./types";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	AuthStorage,
	SessionManager,
	SettingsManager,
	ModelRegistry,
	DefaultResourceLoader,
	createAgentSession,
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
} from "@earendil-works/pi-coding-agent";
import { resolveTools, resolveExtensions } from "./extensions";
import {
	formatDuration,
	extractSummaryLine,
	formatTokens,
	buildSubagentStatusLine,
} from "./formatting";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./config";
import {
	pushLog,
	buildWidgetLines,
	getWorkingMessage,
	MAX_FULL_LOG,
	WIDGET_LINES,
	MAX_LIVE_THINKING,
} from "./agent-stream";

// Re-export for backward compatibility
export { DEFAULT_AGENT_TIMEOUT_MS } from "./config";

// ─── Built-in tools ────────────────────────────────────────────────

const BUILT_IN_TOOLS = [createReadTool(), createBashTool(), createWriteTool(), createEditTool()];

// ─── resolveModel ──────────────────────────────────────────────────

/**
 * Resolve a model from agent config string (e.g. "opencode-go/deepseek-v4-flash").
 * Falls back to first available model if resolution fails.
 */
export function resolveModel(modelString: string): { provider: string; modelId: string } | null {
	if (!modelString || !modelString.trim()) return null;
	const parts = modelString.split("/");
	if (parts.length !== 2) return null;
	return { provider: parts[0]!, modelId: parts[1]! };
}

// ─── buildToolList ────────────────────────────────────────────────

/**
 * Build tool list for an agent session: built-in tools + extension tools
 * resolved from agent frontmatter.
 */
export function buildToolList(agent: ParsedAgent, cwd: string): string[] {
	const rawTools = agent.config.tools || "read,bash,write,edit";
	const toolsStr = resolveTools(rawTools, agent.config.extensions, cwd);
	// resolveTools returns comma-separated tool names
	return toolsStr
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

// ─── runAgentInProcess ─────────────────────────────────────────────

/**
 * Run an agent in-process using createAgentSession() from the pi SDK.
 *
 * Returns AgentRunResult matching the same shape as the subprocess path.
 * Throws on failure — caller (agent-runner.ts) catches and falls back to subprocess.
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

	// ── State (same shape as subprocess path) ──
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

	// ── Flush widget helper ──
	const flushWidget = () => {
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

	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	const scheduleFlush = () => {
		if (!flushTimer) {
			flushTimer = setTimeout(() => {
				flushTimer = null;
				flushWidget();
			}, 80);
		}
	};

	const setWorkingMessage = () => {
		const wm = getWorkingMessage(state, agentName);
		ctx.ui.setWorkingMessage(wm ?? undefined);
	};

	// ── Session reference for timeout ──
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let abortedByTimeout = false;
	const timeoutTimer = setTimeout(() => {
		abortedByTimeout = true;
		// Attempt to abort the session prompt
		session?.abort().catch(() => {});
	}, timeoutMs);

	try {
		// ── Resolve auth & model ──
		const authStorage = AuthStorage.create();
		const modelRegistry = ModelRegistry.create(authStorage);

		let resolvedModel = undefined;
		const modelParts = resolveModel(agent.config.model || "");
		if (modelParts) {
			resolvedModel = modelRegistry.find(modelParts.provider, modelParts.modelId);
		}
		// Fallback: first available model
		if (!resolvedModel) {
			const available = modelRegistry.getAvailable();
			if (available.length > 0) resolvedModel = available[0]!;
		}

		// ── Build resource loader with system prompt override ──
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			settingsManager: SettingsManager.inMemory(),
			systemPromptOverride: () => agent.systemPrompt,
		});
		await resourceLoader.reload();

		// ── Load agent-specific extensions ──
		const extFlags = resolveExtensions(agent.config.extensions);

		// ── Create session ──
		const sessionResult = await createAgentSession({
			cwd,
			authStorage,
			modelRegistry,
			model: resolvedModel,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
			tools: buildToolList(agent, cwd),
			noTools: "builtin", // we provide explicit tool allowlist above
		});
		session = sessionResult.session;

		// Apply thinking level from agent config
		if (agent.config.thinking && agent.config.thinking.trim()) {
			try {
				session.setThinkingLevel(agent.config.thinking.trim() as any);
			} catch {
				// ignore invalid thinking levels
			}
		}

		// ── Subscribe to session events ──
		const unsubscribe = session.subscribe((event) => {
			let needsFlush = false;
			let workingChanged = false;

			switch (event.type) {
				case "context_info": {
					const tokens = (event as any).contextTokens;
					const window = (event as any).contextWindow;
					if (typeof tokens === "number" && typeof window === "number" && window > 0) {
						state.contextTokens = tokens;
						state.contextWindow = window;
						state.contextInfoReceived = true;
						pushLog(state, `📊 Context: ${formatTokens(tokens)}/${formatTokens(window)} (initial)`);
						needsFlush = true;
					}
					break;
				}

				case "tool_execution_start": {
					const prevPhase = state.phase;
					state.currentTool = event.toolName || "tool";
					state.currentToolArgs = event.args ? JSON.stringify(event.args).slice(0, 200) : undefined;
					state.lastToolName = event.toolName;
					state.phase = "tool";
					const logArgs = event.args ? JSON.stringify(event.args).slice(0, 200) : "";
					pushLog(state, `🔧 ${event.toolName}${logArgs ? ` ${logArgs}` : ""}`);
					needsFlush = true;
					if (prevPhase !== "tool") workingChanged = true;
					break;
				}

				case "tool_execution_end": {
					state.toolCount++;
					state.currentTool = undefined;
					state.currentToolArgs = undefined;
					state.phase = "idle";
					pushLog(state, `${event.isError ? "✗" : "✓"} ${event.toolName}`);
					needsFlush = true;
					workingChanged = true;
					break;
				}

				case "message_update": {
					const msg = event.message;
					const assistantEvent = event.assistantMessageEvent;
					if (!assistantEvent || !assistantEvent.delta) break;

					const delta = assistantEvent.delta;
					const prevPhase = state.phase;

					switch (delta.type) {
						case "thinking_start": {
							state.thinkingPushedThisTurn = false;
							if (prevPhase !== "thinking") {
								state.phase = "thinking";
								workingChanged = true;
							}
							needsFlush = true;
							break;
						}
						case "text_start": {
							state.textPushedThisTurn = false;
							if (prevPhase !== "text") {
								state.phase = "text";
								workingChanged = true;
							}
							needsFlush = true;
							break;
						}
						case "thinking_delta": {
							const td = delta.thinking_delta;
							if (typeof td === "string" && td.length > 0) {
								state.liveThinking += td;
								if (state.liveThinking.length > MAX_LIVE_THINKING * 2) {
									state.liveThinking = state.liveThinking.slice(-MAX_LIVE_THINKING);
								}
								if (state.phase !== "thinking") {
									state.phase = "thinking";
									workingChanged = true;
								}
								needsFlush = true;
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
								if (state.phase !== "text") {
									state.phase = "text";
									workingChanged = true;
								}
								needsFlush = true;
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
							needsFlush = true;
							workingChanged = true;
							break;
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
							if (assistantEvent.usage) {
								state.tokenCount =
									assistantEvent.usage.totalTokens ||
									assistantEvent.usage.input + assistantEvent.usage.output ||
									state.tokenCount;
							}
							state.liveText = "";
							state.phase = "idle";
							needsFlush = true;
							workingChanged = true;
							break;
						}
					}
					break;
				}

				case "message_end": {
					const msg = event.message;
					if (!msg) break;

					if (msg.role === "assistant") {
						const content = Array.isArray(msg.content) ? msg.content : [];
						if (!state.thinkingPushedThisTurn) {
							for (const block of content) {
								if ((block as any).type === "thinking" && (block as any).thinking) {
									const thinkingText =
										typeof (block as any).thinking === "string"
											? (block as any).thinking
											: JSON.stringify((block as any).thinking).slice(0, 500);
									for (const t of thinkingText.split("\n")) {
										if (t.trim()) pushLog(state, `💭 ${t.slice(0, 500)}`);
									}
								}
							}
						}
						if (!state.textPushedThisTurn) {
							const text = extractTextFromContent2(content);
							if (text && text.trim()) {
								state.textOutputLines.push(text.trim());
								for (const t of text.split("\n")) {
									if (t.trim()) pushLog(state, t);
								}
							}
						}
						if ((msg as any).usage) {
							state.tokenCount =
								(msg as any).usage.totalTokens ||
								(msg as any).usage.input + (msg as any).usage.output;
						}
					} else if (msg.role === "toolResult") {
						const resultText = extractTextFromContent2(
							Array.isArray(msg.content) ? msg.content : [],
						);
						const label = (msg as any).toolName || state.lastToolName || "tool";
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
					needsFlush = true;
					workingChanged = true;
					break;
				}

				case "agent_end":
				case "turn_end":
					break;
			}

			if (needsFlush) scheduleFlush();
			if (workingChanged) setWorkingMessage();
		});

		// ── Run the prompt ──
		if (!session) throw new Error("Session creation failed");
		await session.prompt(task);

		// ── Unsubscribe and finalize ──
		unsubscribe();

		// Flush remaining live state
		if (state.liveText.trim()) {
			state.textOutputLines.push(state.liveText.trim());
		}
		if (state.liveThinking.trim()) {
			state.thinkingOutputLines.push(state.liveThinking.trim());
		}

		const durationMs = Date.now() - startedAt;
		const textOutput = state.fullLog.join("\n").trim();
		const textOnly = state.textOutputLines.join("\n").trim();

		// Build rawOutput from all messages in the session
		const messages = session.state?.messages || [];
		const rawOutput = buildRawOutputFromMessages(messages, agentName);

		const thinkingOutput =
			state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined;

		const summaryLine = extractSummaryLine(textOutput, true, agentName);

		// Clean up
		clearTimeout(timeoutTimer);
		flushWidget();
		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", "");

		// Dispose session
		try {
			session.dispose();
		} catch {
			// Best-effort cleanup
		}

		return {
			output: rawOutput,
			success: true,
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
	} catch (err: unknown) {
		clearTimeout(timeoutTimer);
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}

		const durationMs = Date.now() - startedAt;
		const errorMsg = err instanceof Error ? err.message : String(err);
		const isTimeout =
			abortedByTimeout || errorMsg.includes("AbortError") || errorMsg.includes("aborted");

		ctx.ui.setWidget(widgetId, undefined);
		ctx.ui.setWorkingMessage(undefined);
		ctx.ui.setStatus("supervisor", "");

		if (isTimeout) {
			return {
				output: `[Timeout: ${agentName} killed after ${formatDuration(durationMs)}]`,
				success: false,
				agentName,
				toolCount: state.toolCount,
				tokenCount: state.tokenCount,
				durationMs,
				textOutput: state.fullLog.join("\n").trim(),
				textOnly: state.textOutputLines.join("\n").trim(),
				summaryLine: `${agentName} timed out after ${formatDuration(durationMs)}`,
				errorOutput: `Timeout after ${formatDuration(durationMs)}`,
				thinkingOutput:
					state.thinkingOutputLines.length > 0 ? state.thinkingOutputLines.join("\n\n") : undefined,
			};
		}

		// Re-throw so caller falls back to subprocess
		throw err;
	}
}

// ─── Helpers ───────────────────────────────────────────────────────

function extractTextFromContent2(content: any[]): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text" && b.text)
		.map((b: any) => b.text)
		.join("\n");
}

/**
 * Build a complete raw output string from all session messages.
 * Captures every assistant response, tool call, and tool result.
 */
function buildRawOutputFromMessages(messages: any[], agentName: string): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const text = extractTextFromContent2(Array.isArray(msg.content) ? msg.content : []);
			if (text) parts.push(`[USER]\n${text}`);
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					parts.push(`[ASSISTANT]\n${block.text}`);
				}
				if (block.type === "thinking" && block.thinking) {
					const thinking =
						typeof block.thinking === "string" ? block.thinking : JSON.stringify(block.thinking);
					if (thinking) parts.push(`[THINKING]\n${thinking}`);
				}
				if (block.type === "toolCall") {
					parts.push(`[TOOL_CALL] ${block.toolName}(${JSON.stringify(block.args)})`);
				}
			}
		} else if (msg.role === "toolResult") {
			const text = extractTextFromContent2(Array.isArray(msg.content) ? msg.content : []);
			if (text) {
				parts.push(`[TOOL_RESULT] ${msg.toolName || "tool"}:\n${text.slice(0, 2000)}`);
			}
		} else if (msg.role === "custom") {
			if (msg.content) parts.push(`[CUSTOM] ${msg.content}`);
		}
	}
	return parts.join("\n\n");
}
