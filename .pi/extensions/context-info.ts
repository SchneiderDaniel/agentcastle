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
 *
 * Colors are hardcoded hex values (not theme tokens) for reliable rendering.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

interface ThresholdEntry {
	maxTokens: number | null;
}

interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000 },
	{ maxTokens: 150_000 },
	{ maxTokens: null },
];

/** Hex colors for threshold levels (index-matched to thresholds array) */
const THRESHOLD_HEX_COLORS = [
	"#50fa7b", // green (neonMint)
	"#ff6d00", // orange (safetyOrange)
	"#ff5252", // red (coral)
];

// ─── Helpers ─────────────────────────────────────────────────────────

/** Module-scope process start time — captures true pi process launch time */
const processStartTime = Date.now();

/** Format elapsed ms → "⏱ Xh Ym Zs" */
function formatSessionTimer(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `\u23f1 ${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `\u23f1 ${minutes}m ${seconds}s`;
	return `\u23f1 ${seconds}s`;
}

/** Format token count: 1200 → "1.2K", 1200000 → "1.2M" */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Apply hex foreground color via ANSI truecolor */
function fgHex(hex: string, text: string): string {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) return text;
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return text;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

/** Pick threshold for given token count and return hex color */
function pickThresholdHex(tokens: number, thresholds: ThresholdEntry[]): string {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	const colors = THRESHOLD_HEX_COLORS;
	for (let i = 0; i < sorted.length; i++) {
		const entry = sorted[i];
		if (entry.maxTokens === null) return colors[Math.min(i, colors.length - 1)] ?? "#ff5252";
		if (tokens <= entry.maxTokens) return colors[Math.min(i, colors.length - 1)] ?? "#ff5252";
	}
	return colors[colors.length - 1] ?? "#ff5252";
}

// ─── TPS helpers ────────────────────────────────────────────────────

/** Compute tokens per second from rolling buffer (30s window) */
function computeTps(samples: TpsSample[]): number | null {
	if (samples.length < 2) return null;

	const now = Date.now();
	const cutoff = now - 30_000;

	// Filter to 30s window
	const active = samples.filter((s) => s.time >= cutoff);
	if (active.length < 2) return null;

	const first = active[0]!;
	const last = active[active.length - 1]!;
	const tokenDelta = last.cumulativeTokens - first.cumulativeTokens;
	const timeDelta = last.time - first.time;

	if (timeDelta <= 0) return null;
	if (tokenDelta <= 0) return null;

	return (tokenDelta / timeDelta) * 1000;
}

/** Format TPS value to display string */
function formatTps(tps: number | null): string {
	if (tps === null) return "-- t/s";
	if (tps < 0.1) return "0.0 t/s";
	if (tps > 999.9) return `${Math.round(tps)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

// ─── Git helpers ─────────────────────────────────────────────────────

/** Detect if we're in a git worktree and return its name */
function getWorktreeName(cwd: string): string | null {
	try {
		const gitFile = `${cwd}/.git`;
		if (!existsSync(gitFile)) return null;
		const content = readFileSync(gitFile, "utf-8");
		const match = content.match(/^gitdir:\s*(.+)$/m);
		if (!match) return null; // regular repo, not a worktree
		const gitDir = match[1]!.trim();
		// Parse worktree name from path: .../.git/worktrees/<name>
		const wtMatch = gitDir.match(/worktrees\/(.+?)(\/|$)/);
		return wtMatch ? wtMatch[1]! : "worktree";
	} catch {
		return null;
	}
}

/** Read a single value from pi's global settings.json */
function readPiSetting(key: string): string | undefined {
	try {
		const settingsPath = joinPath(homedir(), ".pi/agent/settings.json");
		if (!existsSync(settingsPath)) return undefined;
		const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
		if (typeof raw === "object" && raw !== null && key in raw) {
			const val = (raw as Record<string, unknown>)[key];
			return typeof val === "string" ? val : undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// ─── Config loading ──────────────────────────────────────────────────

function loadConfig(): ContextStatusBarConfig | null {
	const defaults: ContextStatusBarConfig = {
		enabled: true,
		thresholds: DEFAULT_THRESHOLDS,
		showTimer: true,
		showTps: true,
	};
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) return defaults;

	let settings: Record<string, unknown>;
	try {
		settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return defaults;
	}

	const raw = settings["contextStatusBar"];
	if (raw === undefined) return defaults;
	if (typeof raw !== "object" || raw === null) return defaults;

	const cfg = raw as Record<string, unknown>;

	let enabled = true;
	if ("enabled" in cfg && typeof cfg.enabled === "boolean") {
		enabled = cfg.enabled;
	}
	if (!enabled) return null;

	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		thresholds = DEFAULT_THRESHOLDS;
	} else {
		const parsed: ThresholdEntry[] = [];
		for (const entry of cfg.thresholds) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			const maxTokens =
				e.maxTokens === null || e.maxTokens === undefined ? null : Number(e.maxTokens);
			if (maxTokens !== null && !Number.isFinite(maxTokens)) continue;
			parsed.push({ maxTokens: maxTokens as number | null });
		}
		thresholds = parsed.length > 0 ? parsed : DEFAULT_THRESHOLDS;
	}

	// Parse showTimer
	let showTimer = true;
	if ("showTimer" in cfg && typeof cfg.showTimer === "boolean") {
		showTimer = cfg.showTimer;
	}

	// Parse showTps
	let showTps = true;
	if ("showTps" in cfg && typeof cfg.showTps === "boolean") {
		showTps = cfg.showTps;
	}

	return { enabled, thresholds, showTimer, showTps };
}

// ─── Thinking level → icon ───────────────────────────────────────────

function thinkingIcon(level: string | undefined): string {
	switch (level) {
		case "off":
			return "○";
		case "minimal":
			return "◐";
		case "low":
			return "◑";
		case "medium":
			return "◒";
		case "high":
			return "◓";
		case "xhigh":
			return "●";
		default:
			return "·";
	}
}

function thinkingColor(level: string | undefined): string {
	switch (level) {
		case "off":
			return "dim";
		case "minimal":
			return "dim";
		case "low":
			return "muted";
		case "medium":
			return "accent";
		case "high":
			return "warning";
		case "xhigh":
			return "error";
		default:
			return "dim";
	}
}

// ─── Extension ───────────────────────────────────────────────────────

export default function contextInfo(pi: ExtensionAPI): void {
	// State — enclosed in closure, not module scope
	let config: ContextStatusBarConfig | null = null;
	let lastContextWindow: number | undefined;
	let emitted = false;
	let thinkingLevel = ""; // empty = unknown until first thinking_level_select
	let worktreeName: string | null = null;
	let timerInterval: ReturnType<typeof setInterval> | null = null;

	// ── Startup widget state ───────────────────────────────────────
	let startupWidgetActive = false;

	// ── TPS state ──────────────────────────────────────────────────
	const tpsSamples: TpsSample[] = [];
	let lastComputedTps: number | null = null;
	let lastSampledOutput: number | undefined = undefined;

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
			// Request footer re-render to update timer display
			// No direct requestRender access — installFooter's render will re-run
			// on each tick because getContextUsage etc. return fresh data
			// We call installFooter again to trigger re-render with new elapsed time
			if (config) installFooter(ctx);
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
		// Reset TPS state on new session
		tpsSamples.length = 0;
		lastComputedTps = null;
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
		}

		// Install custom footer
		installFooter(ctx);

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
		showWelcomeBanner(ctx);
	});

	// Clear welcome banner on first user input
	pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
		if (startupWidgetActive) {
			ctx.ui.setWidget("agentcastle-welcome", undefined);
			startupWidgetActive = false;
		}
	});

	pi.on("thinking_level_select", async (event, ctx: ExtensionContext) => {
		thinkingLevel = event.level;
		if (config) installFooter(ctx);
	});

	pi.on("model_select", async (event, ctx: ExtensionContext) => {
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			lastContextWindow = cw;
		}
		if (config) installFooter(ctx);
		tryEmit(ctx);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		if (config) installFooter(ctx);
	});

	pi.on("message_end", async (event, ctx: ExtensionContext) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		const usage = ctx.getContextUsage();
		if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
			tryEmit(ctx);
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

	// ── Telemetry emit ─────────────────────────────────────────────

	function isJsonMode(): boolean {
		const idx = process.argv.indexOf("--mode");
		if (idx !== -1 && idx + 1 < process.argv.length) {
			return process.argv[idx + 1] === "json";
		}
		return false;
	}

	function tryEmit(ctx: ExtensionContext) {
		if (emitted) return;
		if (!lastContextWindow || lastContextWindow <= 0) return;
		const usage = ctx.getContextUsage();
		if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) return;
		emitted = true;
		// In JSON mode pi redirects extension console.log to stderr.
		// This pollutes stderr and confuses the supervisor pipeline.
		// The supervisor already gets token/context data from JSON protocol events.
		if (isJsonMode()) return;
		console.log(
			JSON.stringify({
				type: "context_info",
				contextTokens: usage.tokens,
				contextWindow: lastContextWindow,
			}),
		);
	}

	// ── Footer installation ────────────────────────────────────────

	function installFooter(ctx: ExtensionContext) {
		if (!config || config.enabled === false) {
			ctx.ui.setFooter(undefined);
			return;
		}

		const showTimer = config.showTimer;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubBranch,
				invalidate() {},
				render(width: number): string[] {
					// ── Compute token usage ───────────────────────
					const usage = ctx.getContextUsage();
					const tokens = usage?.tokens ?? null;
					const cw = usage?.contextWindow ?? lastContextWindow;
					if (cw && cw > 0) lastContextWindow = cw;

					// ── LEFT: Git info ───────────────────────────
					const branch = footerData.getGitBranch();
					let leftStr = "";
					if (branch) {
						leftStr = theme.fg("accent", " ") + theme.fg("muted", branch);
						if (worktreeName) {
							leftStr += " " + theme.fg("dim", `[${worktreeName}]`);
						}
					} else {
						leftStr = theme.fg("dim", "⋄ no git");
					}

					// ── Extension statuses (caveman, etc.) ───────
					const extStatuses = footerData.getExtensionStatuses();
					let extStr = "";
					if (extStatuses.size > 0) {
						const parts: string[] = [];
						for (const [, text] of extStatuses) {
							if (text) parts.push(text);
						}
						if (parts.length > 0) extStr = parts.join(" ");
					}

					// ── CENTER: Model + reasoning ────────────────
					const modelId = ctx.model?.id ?? "?";
					let centerStr = theme.fg("dim", "🧠 ") + theme.fg("accent", modelId);
					if (thinkingLevel) {
						const tIcon = thinkingIcon(thinkingLevel);
						const tColor = thinkingColor(thinkingLevel);
						const reasoningStr = theme.fg(tColor, `${tIcon} ${thinkingLevel}`);
						centerStr += " " + theme.fg("dim", "·") + " " + reasoningStr;
					}

					// ── RIGHT: Session timer + token usage + percentage ──
					let rightStr = "";

					// Compute timer string
					let timerStr = "";
					if (showTimer) {
						const elapsed = Date.now() - processStartTime;
						const rawTimer = formatSessionTimer(elapsed);
						timerStr = theme.fg("dim", rawTimer);
					}

					// Compute token display string
					let tokenDisplay = "";
					if (tokens !== null && tokens !== undefined) {
						const currentFmt = formatTokens(tokens);
						const maxFmt = lastContextWindow ? formatTokens(lastContextWindow) : "?";
						const pct =
							lastContextWindow && lastContextWindow > 0
								? Math.round((tokens / lastContextWindow) * 100)
								: null;

						const usageHex = pickThresholdHex(tokens, config.thresholds);

						const tokenText = `${currentFmt}/${maxFmt}`;
						tokenDisplay = theme.fg("dim", "◉ ") + fgHex(usageHex, tokenText);

						if (pct !== null) {
							const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "dim";
							tokenDisplay += " " + theme.fg(pctColor, `[${pct}%]`);
						}
					} else if (lastContextWindow) {
						tokenDisplay = theme.fg("dim", `◉ .../${formatTokens(lastContextWindow)}`);
					} else {
						tokenDisplay = theme.fg("dim", "◉ .../?");
					}

					// Combine timer and token display
					if (timerStr && tokenDisplay) {
						rightStr = `${timerStr} \u00b7 ${tokenDisplay}`;
					} else if (timerStr) {
						rightStr = timerStr;
					} else {
						rightStr = tokenDisplay;
					}

					// ── TPS computation ───────────────────────────
					const computed = computeTps(tpsSamples);
					if (computed !== null) {
						lastComputedTps = computed;
					}

					// ── Separator character ──────────────────────
					const sep = theme.fg("dim", "│");

					// ── Left side only (git info) ─────────────
					const fullLeft = leftStr;

					// ── Build row 1 (existing status bar) ────────
					const leftW = visibleWidth(fullLeft);
					const centerW = visibleWidth(centerStr);
					const rightW = visibleWidth(rightStr);

					// Calculate spacing
					const totalContent = leftW + centerW + rightW;
					const sepCount = 2;
					const sepWidth = 3 + sepCount * 2; // " │ " per separator

					let row1: string;
					if (totalContent + sepWidth <= width) {
						// All fits — distribute remaining space
						const remaining = width - totalContent - sepWidth;
						const padLeft = Math.floor(remaining / 2);
						const padRight = remaining - padLeft;

						row1 =
							fullLeft +
							" ".repeat(padLeft + 1) +
							sep +
							" ".repeat(1) +
							centerStr +
							" ".repeat(padRight + 1) +
							sep +
							" ".repeat(1) +
							rightStr;
					} else if (leftW + rightW + sepWidth <= width) {
						// Narrow terminal — compact mode: left+ext | right (drop center)
						const remaining = width - leftW - rightW - sepWidth;
						row1 = fullLeft + " ".repeat(remaining + 2) + sep + " ".repeat(1) + rightStr;
					} else {
						// Very narrow — just right-aligned tokens
						row1 = " ".repeat(Math.max(0, width - rightW)) + rightStr;
					}

					row1 = truncateToWidth(row1, width);

					// ── Build row 2 (ext statuses left, TPS right) ──
					if (extStr || config.showTps) {
						const left2 = extStr || "";
						let right2 = "";
						if (config.showTps) {
							const tpsDisplay = formatTps(lastComputedTps);
							right2 = theme.fg("dim", tpsDisplay);
						}
						const leftW = visibleWidth(left2);
						const rightW = visibleWidth(right2);
						const gap = Math.max(0, width - leftW - rightW);
						const row2 = right2
							? left2 + " ".repeat(gap) + right2
							: left2 + " ".repeat(Math.max(0, width - leftW));
						return [row1, truncateToWidth(row2, width)];
					}

					return [row1];
				},
			};
		});

		// Also keep the status key clear (footer replaces it)
		ctx.ui.setStatus("contextUsage", undefined);
	}

	// ── Welcome banner ───────────────────────────────────────────

	function listNames(dir: string, suffix: string): string[] {
		try {
			if (!existsSync(dir)) return [];
			const results: string[] = [];
			const walk = (d: string) => {
				const entries = readdirSync(d, { withFileTypes: true });
				for (const entry of entries) {
					const fullPath = joinPath(d, entry.name);
					if (entry.isDirectory()) {
						if (entry.name !== "." && entry.name !== "..") {
							walk(fullPath);
						}
					} else if (entry.isFile() && entry.name.endsWith(suffix)) {
						results.push(entry.name.replace(new RegExp(`${suffix.replace(".", "\\.")}$`), ""));
					}
				}
			};
			walk(dir);
			return results.sort();
		} catch {
			return [];
		}
	}

	function countExtensions(): number {
		try {
			if (!existsSync(".pi/extensions")) return 0;
			const entries = readdirSync(".pi/extensions", { withFileTypes: true });
			let count = 0;
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith(".ts")) {
					count++;
				} else if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
					count++;
				}
			}
			return count;
		} catch {
			return 0;
		}
	}

	function showWelcomeBanner(ctx: ExtensionContext) {
		const extCount = countExtensions();
		const promptCount = listNames(".pi/prompts", ".md").length;
		const themeCount = listNames(".pi/themes", ".json").length;

		ctx.ui.setWidget("agentcastle-welcome", (_tui, theme) => {
			return {
				dispose() {},
				invalidate() {},
				render(_width: number): string[] {
					const dim = (s: string) => theme.fg("dim", s);
					const muted = (s: string) => theme.fg("muted", s);
					const accent = (s: string) => theme.fg("accent", s);

					const modelId = ctx.model?.id ?? "?";
					const cw = ctx.model?.contextWindow;
					const cwStr = typeof cw === "number" && cw > 0 ? formatTokens(cw) : "?";

					const baseW = 64;

					// ── Centered title ────────────────────────
					const titleText = "\ud83c\udff0 Agent Castle";
					const titleVis = visibleWidth(titleText);
					const titlePad = Math.max(0, Math.floor((baseW - titleVis) / 2));
					const titleLine =
						" ".repeat(titlePad) + accent(titleText) + " ".repeat(baseW - titlePad - titleVis);

					// ── Castle art (towers + walls) ────────────
					const castle: string[] = [
						"       #_||_#               #_||_#               #_||_#",
						"       \\####/               \\####/               \\####/",
						"        |  |                 |  |                 |  |",
						"  # # # |  | # # # # # # # # |  | # # # # # # # # |  | # # #",
						"  |-----|  |-----|-------|---|  |---|-------|-----|  |-----|",
						"  |     /  \\     |       |   /  \\   |       |     /  \\     |",
						" /     |    |     \\  /\\  /   |    |   \\  /\\  /     |    |     \\",
						"|      |    |      \\/  \\/    |    |    \\/  \\/      |    |      |",
						"|______[____]________________[____]________________[____]______|",
					];

					// Pad all castle lines to baseW
					const castleLines = castle.map((line) => {
						const w = visibleWidth(line);
						return dim(w < baseW ? line + " ".repeat(baseW - w) : line);
					});

					// ── Stats lines: built via concatenation, NO .replace on ANSI strings ──
					// Format: | LABEL:      VALUE                            |
					// Inner content width (between "| " and " |" borders) = 60
					function statLine(label: string, value: string): string {
						const labelStr = muted(label);
						const valueStr = accent(value);
						const rawLabelW = visibleWidth(label);
						const rawValueW = visibleWidth(value);
						const padding = 60 - rawLabelW - rawValueW;
						return dim("| ") + labelStr + valueStr + " ".repeat(Math.max(0, padding)) + dim(" |");
					}

					const statLines: string[] = [
						statLine("🧠 Model:      ", modelId),
						statLine("📊 Context:    ", cwStr),
						statLine("🧩 Extensions: ", String(extCount)),
						statLine("📝 Prompts:    ", String(promptCount)),
						statLine("🎨 Themes:     ", String(themeCount)),
					];

					// Bottom wall
					const bottom = dim("|" + "_".repeat(62) + "|");

					return [titleLine, ...castleLines, ...statLines, bottom];
				},
			};
		});
		startupWidgetActive = true;
	}
}
