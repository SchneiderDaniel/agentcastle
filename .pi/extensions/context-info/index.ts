/**
 * context-info — Rich status bar with git branch, model info, token usage, and TPS
 *
 * Replaces pi's default footer with an info-dense status line.
 * Shows: git branch, active model, thinking level, session timer,
 * token usage with thresholds, and tokens-per-second during streaming.
 * Works with any theme. Use /explain-extensions to list all active extensions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextStatusBarConfig, TpsSample } from "./types.ts";
import { loadConfig, readPiSetting } from "./config.ts";
import { getWorktreeName } from "./git-helpers.ts";
import { tryEmit } from "./telemetry.ts";
import { processStartTime, installFooter } from "./footer.ts";
import { showWelcomeBanner } from "./welcome.ts";
import { listLocalExtensions } from "./extensions.ts";
import { listLocalPrompts } from "./prompts.ts";
import { listLocalSkills } from "./skills.ts";

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

	// ── Tool call counter state ────────────────────────────────────
	const toolCallCount = { value: 0 };

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
					toolCallCount,
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

	// ── Commands ────────────────────────────────────────────────────

	pi.registerCommand("explain-prompts", {
		description: "List all project-local prompts with descriptions",
		handler: async (_args, ctx) => {
			const prompts = listLocalPrompts();
			if (prompts.length === 0) {
				ctx.ui.notify("No prompts found", "info");
				return;
			}

			ctx.ui.setWidget("explain-prompts", (_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);

				interface PromptLine {
					name: string;
					desc: string;
				}

				const items: PromptLine[] = prompts.map((pr) => ({
					name: pr.name,
					desc: (pr.description ?? "(no description)").split("\n")[0].trim(),
				}));

				function wordWrap(text: string, maxWidth: number): string[] {
					if (visibleWidth(text) <= maxWidth) return [text];
					const result: string[] = [];
					let remaining = text;
					while (remaining.length > 0) {
						if (visibleWidth(remaining) <= maxWidth) {
							result.push(remaining);
							break;
						}
						// Find last space within maxWidth
						let cut = maxWidth;
						while (cut > 0 && remaining[cut] !== " " && remaining[cut] !== undefined) {
							cut--;
						}
						if (cut <= 0) cut = maxWidth; // no space found, hard cut
						result.push(remaining.slice(0, cut).trimEnd());
						remaining = remaining.slice(cut).trimStart();
					}
					return result;
				}

				return {
					render: (width: number) => {
						const lines: string[] = [];
						const descWidth = Math.max(20, width - 6);

						for (const item of items) {
							lines.push(accent("  " + item.name));
							const wrapped = wordWrap(item.desc, descWidth);
							for (const seg of wrapped) {
								lines.push(dim("    " + seg));
							}
						}

						lines.push("");
						lines.push(
							dim("  ─ ") +
								dim(String(prompts.length)) +
								dim(" prompts ─ disappears when you type"),
						);

						return lines.map((line) => {
							if (line === "" || line.trim() === "") return "";
							return line;
						});
					},
					invalidate: () => {},
				};
			});
		},
	});

	pi.registerCommand("explain-skills", {
		description: "List all project-local skills with descriptions",
		handler: async (_args, ctx) => {
			const skills = listLocalSkills();
			if (skills.length === 0) {
				ctx.ui.notify("No skills found", "info");
				return;
			}

			ctx.ui.setWidget("explain-skills", (_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);

				interface SkillLine {
					name: string;
					desc: string;
				}

				const items: SkillLine[] = skills.map((sk) => ({
					name: sk.name,
					desc: (sk.description ?? "(no description)").split("\n")[0].trim(),
				}));

				function wordWrap(text: string, maxWidth: number): string[] {
					if (visibleWidth(text) <= maxWidth) return [text];
					const result: string[] = [];
					let remaining = text;
					while (remaining.length > 0) {
						if (visibleWidth(remaining) <= maxWidth) {
							result.push(remaining);
							break;
						}
						// Find last space within maxWidth
						let cut = maxWidth;
						while (cut > 0 && remaining[cut] !== " " && remaining[cut] !== undefined) {
							cut--;
						}
						if (cut <= 0) cut = maxWidth; // no space found, hard cut
						result.push(remaining.slice(0, cut).trimEnd());
						remaining = remaining.slice(cut).trimStart();
					}
					return result;
				}

				return {
					render: (width: number) => {
						const lines: string[] = [];
						const descWidth = Math.max(20, width - 6);

						for (const item of items) {
							lines.push(accent("  " + item.name));
							const wrapped = wordWrap(item.desc, descWidth);
							for (const seg of wrapped) {
								lines.push(dim("    " + seg));
							}
						}

						lines.push("");
						lines.push(
							dim("  ─ ") + dim(String(skills.length)) + dim(" skills ─ disappears when you type"),
						);

						return lines.map((line) => {
							if (line === "" || line.trim() === "") return "";
							return line;
						});
					},
					invalidate: () => {},
				};
			});
		},
	});

	pi.registerCommand("explain-extensions", {
		description: "List all project-local extensions with descriptions",
		handler: async (_args, ctx) => {
			const extensions = listLocalExtensions();
			if (extensions.length === 0) {
				ctx.ui.notify("No extensions found", "info");
				return;
			}

			ctx.ui.setWidget("explain-extensions", (_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);

				const lines: string[] = [];

				for (const ext of extensions) {
					if (ext.error) {
						lines.push(accent("  " + ext.name) + dim("  error: " + ext.error));
						continue;
					}
					// First line only from JSDoc — no embedded newlines
					const firstLine = (ext.description ?? "(no description)").split("\n")[0].trim();
					lines.push(accent("  " + ext.name) + dim("  " + firstLine));
				}

				lines.push(
					dim("  ─ ") +
						dim(String(extensions.length)) +
						dim(" extensions ─ disappears when you type"),
				);

				return {
					render: (width: number) =>
						lines.map((line) => {
							if (line === "" || line.trim() === "") return "";
							return truncateToWidth(line, width);
						}),
					invalidate: () => {},
				};
			});
		},
	});

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
		toolCallCount.value = 0;

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
			toolCallCount,
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

		// ── Session ID ────────────────────────────────────────
		let sessionId = "unknown";
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) {
			// Filename format: <timestamp>_<uuid>.jsonl
			const match = sessionFile.match(/_([0-9a-f-]+)\.jsonl$/i);
			if (match) sessionId = match[1]!;
		}

		// ── Startup welcome banner ──────────────────────────────
		showWelcomeBanner(ctx, startupWidgetActive, sessionId);
	});

	// Clear welcome banner and explain-* widgets on first user input
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		if (startupWidgetActive.value) {
			ctx.ui.setWidget("agentcastle-welcome", undefined);
			startupWidgetActive.value = false;
		}
		ctx.ui.setWidget("explain-extensions", undefined);
		ctx.ui.setWidget("explain-prompts", undefined);
		ctx.ui.setWidget("explain-skills", undefined);
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
				toolCallCount,
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
				toolCallCount,
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
				toolCallCount,
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

	pi.on("tool_execution_end", async () => {
		toolCallCount.value += 1;
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});
}

// Re-export types for consumers
export type { ThresholdEntry, TpsSample, ContextStatusBarConfig } from "./types.ts";
