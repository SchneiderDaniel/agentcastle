/**
 * context-info — Rich status bar with git branch, model info, token usage, and TPS
 *
 * Replaces pi's default footer with an info-dense status line.
 * Shows: git branch, active model, thinking level, session timer,
 * token usage with thresholds, and tokens-per-second during streaming.
 * Works with any theme. Use /explain-extensions to list all active extensions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, readPiSetting } from "./config.js";
import { getWorktreeName } from "./git-helpers.js";
import { tryEmit } from "./telemetry.js";
import { installFooter } from "./footer.js";
import { FooterState } from "./footer-state.js";
import { showWelcomeBanner, readSessionExtState } from "./welcome.js";
import { createExplainCommand } from "./explain-command.js";
import { listLocalExtensions } from "./extensions.js";
import { listLocalPrompts } from "./prompts.js";
import { listLocalSkills } from "./skills.js";

export default function contextInfo(pi: ExtensionAPI): void {
	// FooterState — single source of truth for all mutable state
	// Initialized per session in session_start handler
	let state: FooterState | undefined;

	// ── Commands ────────────────────────────────────────────────────

	createExplainCommand(pi, "explain-extensions", "extension", listLocalExtensions);
	createExplainCommand(pi, "explain-prompts", "prompt", listLocalPrompts);
	createExplainCommand(pi, "explain-skills", "skill", listLocalSkills);

	// ── Hooks ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		state = new FooterState(ctx, installFooter);
		state.resetProperties();
		state.config = loadConfig();

		// Detect worktree each session — git worktree can change across sessions
		state.worktreeName = getWorktreeName(ctx.cwd);
		// Deferred I/O — read pi settings on first session
		if (!state.thinkingLevel) {
			state.thinkingLevel = readPiSetting("defaultThinkingLevel") || "";
		}

		if (state.config === null) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus("contextUsage", undefined);
			ctx.ui.setWidget("agentcastle-welcome", undefined);
			state.stopTimer();
			return;
		}

		const cw = ctx.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			state.lastContextWindow = cw;
		}

		// Install custom footer
		state.callInstallFooter();

		// Start live timer
		state.startTimer();

		// Custom working indicator — subtle dot pulse
		ctx.ui.setWorkingIndicator({
			frames: [
				ctx.ui.theme.fg("dim", "·"),
				ctx.ui.theme.fg("muted", "•"),
				ctx.ui.theme.fg("accent", "●"),
				ctx.ui.theme.fg("muted", "•"),
			],
			intervalMs: 150,
		});

		// ── Session ID ────────────────────────────────────────
		let sessionId = "unknown";
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) {
			// Filename format: <timestamp>_<uuid>.jsonl
			const match = sessionFile.match(/_([0-9a-f-]+)\.jsonl$/i);
			if (match) sessionId = match[1]!;
		}

		// ── Startup welcome banner ──────────────────────────────
		const extState = readSessionExtState();
		const startupRef = {
			get value() {
				return state!.startupWidgetActive;
			},
			set value(v: boolean) {
				state!.startupWidgetActive = v;
			},
		};
		showWelcomeBanner(ctx, startupRef, sessionId, extState.logger, extState.advice);
	});

	// Clear welcome banner and explain-* widgets on first user input
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		if (state && state.startupWidgetActive) {
			ctx.ui.setWidget("agentcastle-welcome", undefined);
			state.startupWidgetActive = false;
		}
		ctx.ui.setWidget("explain-extensions", undefined);
		ctx.ui.setWidget("explain-prompts", undefined);
		ctx.ui.setWidget("explain-skills", undefined);
	});

	pi.on("thinking_level_select", async (event, ctx: ExtensionContext) => {
		if (!state) return;
		state.thinkingLevel = event.level;
		if (state.config) {
			state.callInstallFooter();
		}
	});

	pi.on("model_select", async (event, ctx: ExtensionContext) => {
		if (!state) return;
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			state.lastContextWindow = cw;
		}
		if (state.config) {
			state.callInstallFooter();
		}
		tryEmit(ctx, state);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		if (state && state.config) {
			state.callInstallFooter();
		}
	});

	pi.on("message_end", async (event, ctx: ExtensionContext) => {
		if (!state) return;
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		// Capture cache stats from raw event usage
		const eventUsage = msg.usage;
		if (eventUsage && typeof eventUsage.cacheRead === "number") {
			state.cacheRead = eventUsage.cacheRead;
		}
		if (eventUsage && typeof eventUsage.cacheWrite === "number") {
			state.cacheWrite = eventUsage.cacheWrite;
		}
		const usage = ctx.getContextUsage();
		if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
			tryEmit(ctx, state);
		}
	});

	pi.on("message_update", async (event: any, _ctx: ExtensionContext) => {
		if (!state) return;
		// Sample streaming output tokens for TPS estimation
		const output = event.assistantMessageEvent?.partial?.usage?.output;
		if (typeof output === "number") {
			state.sampleTps(output);
		}
	});

	pi.on("tool_execution_end", async () => {
		if (state) {
			state.addToolCall();
		}
	});

	pi.on("session_shutdown", async () => {
		if (state) {
			state.stopTimer();
		}
	});
}

// Re-export types for consumers
export type { ThresholdEntry, TpsSample, ContextStatusBarConfig } from "./types.js";
