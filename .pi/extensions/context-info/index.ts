/**
 * context-info — Agent Castle Terminal Revamp
 *
 * Replaces pi's default footer with a rich Neovim/lain-inspired status bar.
 *
 * Status bar shows (L → R):
 *    branch [worktree]  │  🧠 model · reasoning  │  ◉ 12.5K/200K [6%]
 *
 * Also emits telemetry JSON on first assistant response.
 *
 * Theme: requires "agentcastle" theme for best visuals, but works with any theme.
 * Install: pi install --theme .pi/themes/agentcastle.json
 *
 * Config (.pi/settings.json, optional):
 *   "contextStatusBar": {
 *     "enabled": true,
 *     "thresholds": [
 *       { "maxTokens": 100000 },
 *       { "maxTokens": 150000 },
 *       { "maxTokens": null }
 *     ]
 *   }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStatusBarConfig, TpsSample } from "./types.js";
import { loadConfig, readPiSetting } from "./config.js";
import { getWorktreeName } from "./git-helpers.js";
import { tryEmit } from "./telemetry.js";
import { processStartTime, installFooter } from "./footer.js";
import { showWelcomeBanner } from "./welcome.js";

export default function contextInfo(pi: ExtensionAPI): void {
	// State — enclosed in closure, not module scope
	let config: ContextStatusBarConfig | null = null;
	let lastContextWindow: number | undefined;
	let emitted = false;
	let thinkingLevel = ""; // empty = unknown until first thinking_level_select
	let worktreeName: string | null = null;
	let timerInterval: ReturnType<typeof setInterval> | null = null;

	// ── Startup widget state ───────────────────────────────────────
	const startupWidgetActive = { value: false };

	// ── TPS state ──────────────────────────────────────────────────
	const tpsSamples: TpsSample[] = [];
	const lastComputedTps: { value: number | null } = { value: null };
	let lastSampledOutput: number | undefined = undefined;
	const lastContextWindowRef: { value: number | undefined } = { value: undefined };
	const telemetryState: { emitted: boolean; lastContextWindow?: number } = { emitted: false };

	function syncTelemetryState() {
		telemetryState.lastContextWindow = lastContextWindow;
	}

	function sampleTps(output: number | undefined) {
		if (typeof output !== "number" || output < 0) return;
		// Detect reset between responses (new response starts from 0)
		if (typeof lastSampledOutput === "number" && output < lastSampledOutput) {
			tpsSamples.length = 0;
		}
		lastSampledOutput = output;
		const now = Date.now();
		tpsSamples.push({ time: now, cumulativeTokens: output });
		// Prune samples older than 30s
		const cutoff = now - 30_000;
		while (tpsSamples.length > 0 && tpsSamples[0]!.time < cutoff) {
			tpsSamples.shift();
		}
	}

	// ── Timer helpers ──────────────────────────────────────────────
	function startTimer(ctx: ExtensionContext) {
		stopTimer();
		timerInterval = setInterval(() => {
			if (config) {
				installFooter(
					ctx,
					config,
					worktreeName,
					thinkingLevel,
					tpsSamples,
					lastComputedTps,
					lastContextWindowRef,
					{ value: lastSampledOutput },
				);
			}
		}, 1000);
	}

	function stopTimer() {
		if (timerInterval !== null) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
	}

	// ── Hooks ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		config = loadConfig();
		lastContextWindow = undefined;
		emitted = false;
		telemetryState.emitted = false;
		// Reset TPS state on new session
		tpsSamples.length = 0;
		lastComputedTps.value = null;
		lastSampledOutput = undefined;

		// Deferred I/O — detect worktree on first session
		if (worktreeName === null) {
			worktreeName = getWorktreeName(ctx.cwd);
		}
		// Deferred I/O — read pi settings on first session
		if (!thinkingLevel) {
			thinkingLevel = readPiSetting("defaultThinkingLevel") || "";
		}

		if (config === null) {
			ctx.ui.setFooter(undefined);
			ctx.ui.setStatus("contextUsage", undefined);
			ctx.ui.setWidget("agentcastle-welcome", undefined);
			stopTimer();
			return;
		}

		const cw = ctx.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			lastContextWindow = cw;
			lastContextWindowRef.value = cw;
		}

		syncTelemetryState();

		// Install custom footer
		installFooter(
			ctx,
			config,
			worktreeName,
			thinkingLevel,
			tpsSamples,
			lastComputedTps,
			lastContextWindowRef,
			{ value: lastSampledOutput },
		);

		// Start live timer
		startTimer(ctx);

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

		// ── Startup welcome banner ──────────────────────────────
		showWelcomeBanner(ctx, startupWidgetActive);
	});

	// Clear welcome banner on first user input
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		if (startupWidgetActive.value) {
			ctx.ui.setWidget("agentcastle-welcome", undefined);
			startupWidgetActive.value = false;
		}
	});

	pi.on("thinking_level_select", async (event, ctx: ExtensionContext) => {
		thinkingLevel = event.level;
		if (config)
			installFooter(
				ctx,
				config,
				worktreeName,
				thinkingLevel,
				tpsSamples,
				lastComputedTps,
				lastContextWindowRef,
				{ value: lastSampledOutput },
			);
	});

	pi.on("model_select", async (event, ctx: ExtensionContext) => {
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			lastContextWindow = cw;
			lastContextWindowRef.value = cw;
		}
		syncTelemetryState();
		if (config)
			installFooter(
				ctx,
				config,
				worktreeName,
				thinkingLevel,
				tpsSamples,
				lastComputedTps,
				lastContextWindowRef,
				{ value: lastSampledOutput },
			);
		tryEmit(ctx, telemetryState);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		if (config)
			installFooter(
				ctx,
				config,
				worktreeName,
				thinkingLevel,
				tpsSamples,
				lastComputedTps,
				lastContextWindowRef,
				{ value: lastSampledOutput },
			);
	});

	pi.on("message_end", async (event, ctx: ExtensionContext) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		syncTelemetryState();
		const usage = ctx.getContextUsage();
		if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
			tryEmit(ctx, telemetryState);
		}
	});

	pi.on("message_update", async (event: any, _ctx: ExtensionContext) => {
		// Sample streaming output tokens for TPS estimation
		const output = event.assistantMessageEvent?.partial?.usage?.output;
		if (typeof output === "number") {
			sampleTps(output);
		}
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});
}

// Re-export types for consumers
export type { ThresholdEntry, TpsSample, ContextStatusBarConfig } from "./types.js";
