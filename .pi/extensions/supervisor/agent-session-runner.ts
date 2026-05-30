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

import type { ParsedAgent, AgentRunResult, AgentRunState } from "./types.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	DefaultResourceLoader,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai";
import { resolveExtensionPaths } from "./extensions.ts";
import { formatDuration, extractSummaryLine } from "./formatting.ts";
import { pushLog } from "./agent-stream.ts";
import { buildWidgetComponent, getWorkingMessage } from "./session-widget.ts";
import { resolveModel, buildToolList } from "./session-model.ts";
import { processSessionEvent } from "./session-events.ts";
import { buildAgentRunResult } from "./session-result.ts";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./config.ts";

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
	pi: ExtensionAPI,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
	cwd?: string,
): Promise<AgentRunResult> {
	const effectiveCwd = cwd || ctx.cwd || process.cwd();
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

	// Hoist cleanup variables so they're accessible in try, catch, and finally
	let flushTimer: NodeJS.Timeout | null = null;
	// Event-driven flush only — no heartbeat interval (terminal freeze fix)

	// Resolve model
	const modelInfo = await resolveModel(agent.config.model || "");
	let resolvedModel: any;
	if (modelInfo) {
		try {
			resolvedModel = getModel(modelInfo.provider as any, modelInfo.modelId as any);
		} catch {
			// getModel threw — try fallback
		}
	}

	// Build tool list
	const tools = buildToolList(agent, effectiveCwd);

	// Resolve extension paths for resource loader
	const extPaths = resolveExtensionPaths(agent.config.extensions, effectiveCwd);

	let session;
	let unsubscribe: (() => void) | undefined;

	try {
		// Create resource loader with system prompt override and extension paths
		const resourceLoader = new DefaultResourceLoader({
			cwd: effectiveCwd,
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.inMemory(),
			systemPromptOverride: () => agent.systemPrompt,
			additionalExtensionPaths: extPaths.length > 0 ? extPaths : undefined,
			noExtensions: true,
		});
		await resourceLoader.reload();

		const sessionManager = SessionManager.inMemory(effectiveCwd);
		const settingsManager = SettingsManager.inMemory();

		const sessionResult = await createAgentSession({
			cwd: effectiveCwd,
			sessionManager,
			resourceLoader,
			settingsManager,
			tools: tools.length > 0 ? tools : undefined,
			noTools: tools.length === 0 ? "builtin" : undefined,
			model: resolvedModel,
		});
		session = sessionResult.session;

		// ── Live widget via TUI Component factory ──
		// Uses ctx.ui.setWidget() with a Component factory function that builds
		// a Container from pi's TUI primitives (Container, Text, Spacer).
		// The factory captures state by reference so each render picks up the
		// latest fullLog, tool info, and stats. Styled with theme colors to
		// match the message-renderer look.
		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			// Pass Component factory: TUI calls factory on each render pass.
			// No requestRender call — avoids forced synchronous re-render
			// that freezes terminal input (Bug: terminal freeze fix).
			ctx.ui.setWidget(
				widgetId,
				(_tui, theme) => buildWidgetComponent(state, agentName, agent.config.model, theme),
				{
					placement: "aboveEditor",
				},
			);
			ctx.ui.setStatus("supervisor", undefined);
		};

		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 80);
			}
		};

		// Event-driven flush only — no heartbeat interval.
		// TUI re-renders triggered by session events via scheduleFlush().
		// Terminal freeze fix: stop interval-based forced re-renders.

		unsubscribe = session.subscribe((event: any) => {
			const result = processSessionEvent(event, state);
			if (result.flush) scheduleFlush();
			if (result.workingChange) {
				const wm = getWorkingMessage(state, agentName);
				ctx.ui.setWorkingMessage(wm ?? undefined);
			}
		});

		// ── Bug 2 fix: Properly settle session.prompt() on timeout ──
		// When timeout fires, session.abort() is called but session.prompt()
		// stays pending forever — leaked promise. Fix: wrap prompt so we can
		// await its settlement after the race completes.
		let timedOut = false;
		let promptSettled = false;
		let timeoutRef: NodeJS.Timeout | undefined;

		const timeoutPromise = new Promise<void>((_, reject) => {
			timeoutRef = setTimeout(async () => {
				timedOut = true;
				try {
					await session!.abort();
				} catch {
					// abort already handled — prompt will reject
				}
				reject(new Error(`Agent ${agentName} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});

		// Wrap prompt to track settlement
		const promptPromise = session
			.prompt(task, { streamingBehavior: "steer" })
			.then(() => {
				promptSettled = true;
			})
			.catch(() => {
				promptSettled = true;
			});

		try {
			await Promise.race([promptPromise, timeoutPromise]);
		} catch (promptErr: unknown) {
			// Check if this was a timeout
			if (timedOut) {
				const durationMs = Date.now() - startedAt;
				pushLog(state, `[Timeout: ${agentName} killed after ${formatDuration(durationMs)}]`);

				if (state.liveText.trim()) {
					state.textOutputLines.push(state.liveText.trim());
				}
				if (state.liveThinking.trim()) {
					state.thinkingOutputLines.push(state.liveThinking.trim());
				}

				// Wait for prompt to settle (abort should resolve/reject it)
				// This prevents the leaked promise chain from Bug 2
				if (!promptSettled) {
					try {
						await promptPromise;
					} catch {
						// Prompt settled via abort — expected
					}
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
			if (timeoutRef) clearTimeout(timeoutRef);
			// Ensure prompt is settled even on non-timeout errors
			if (!promptSettled) {
				try {
					await promptPromise;
				} catch {}
			}
		}

		// Success path
		if (state.liveText.trim()) {
			state.textOutputLines.push(state.liveText.trim());
		}
		if (state.liveThinking.trim()) {
			state.thinkingOutputLines.push(state.liveThinking.trim());
		}

		// Flush final widget update then clear it
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		flushWidget();

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
