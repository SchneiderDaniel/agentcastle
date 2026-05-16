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

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
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

/** Count files matching suffix in a directory (non-recursive) */
function countFiles(dir: string, suffix: string): number {
	try {
		if (!existsSync(dir)) return 0;
		const entries = readdirSync(dir, { withFileTypes: true });
		let count = 0;
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(suffix)) count++;
			// Also count index.ts in subdirectories for extensions
			if (entry.isDirectory() && suffix === ".ts") {
				if (existsSync(joinPath(dir, entry.name, "index.ts"))) count++;
			}
		}
		return count;
	} catch {
		return 0;
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
	const defaults: ContextStatusBarConfig = { enabled: true, thresholds: DEFAULT_THRESHOLDS, showTimer: true };
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

	return { enabled, thresholds, showTimer };
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
						tokenDisplay = theme.fg(
							"dim",
							`◉ .../${formatTokens(lastContextWindow)}`,
						);
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

					// ── Separator character ──────────────────────
					const sep = theme.fg("dim", "│");

					// ── Combine left + extension statuses ───────
					const fullLeft = extStr ? `${leftStr} ${extStr}` : leftStr;

					// ── Layout: left+ext | center | right ───────
					const leftW = visibleWidth(fullLeft);
					const centerW = visibleWidth(centerStr);
					const rightW = visibleWidth(rightStr);

					// Calculate spacing
					const totalContent = leftW + centerW + rightW;
					const sepCount = 2;
					const sepWidth = 3 + sepCount * 2; // " │ " per separator

					if (totalContent + sepWidth <= width) {
						// All fits — distribute remaining space
						const remaining = width - totalContent - sepWidth;
						const padLeft = Math.floor(remaining / 2);
						const padRight = remaining - padLeft;

						const line =
							fullLeft +
							" ".repeat(padLeft + 1) +
							sep +
							" ".repeat(1) +
							centerStr +
							" ".repeat(padRight + 1) +
							sep +
							" ".repeat(1) +
							rightStr;

						return [truncateToWidth(line, width)];
					}

					// Narrow terminal — compact mode: left+ext | right (drop center)
					if (leftW + rightW + sepWidth <= width) {
						const remaining = width - leftW - rightW - sepWidth;
						const line = fullLeft + " ".repeat(remaining + 2) + sep + " ".repeat(1) + rightStr;
						return [truncateToWidth(line, width)];
					}

					// Very narrow — just right-aligned tokens
					const line = " ".repeat(Math.max(0, width - rightW)) + rightStr;
					return [truncateToWidth(line, width)];
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
			return readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isFile() && e.name.endsWith(suffix))
				.map((e) => e.name.replace(new RegExp(`${suffix.replace(".", "\\.")}$`), ""))
				.sort();
		} catch {
			return [];
		}
	}

	function showWelcomeBanner(ctx: ExtensionContext) {
		// Collect info once at startup
		const extCount = listNames(".pi/extensions", ".ts").length;
		const promptCount = listNames(".pi/prompts", ".md").length;
		const themeCount = listNames(".pi/themes", ".json").length;
		const modelId = ctx.model?.id ?? "?";
		const cw = ctx.model?.contextWindow;
		const cwStr = typeof cw === "number" && cw > 0 ? formatTokens(cw) : "?";

		ctx.ui.setWidget("agentcastle-welcome", (_tui, theme) => {
			let cachedWidth = -1;
			let cachedLines: string[] = [];

			const BOX_W = 72; // wider castle-style box

			return {
				dispose() {},
				invalidate() {
					cachedWidth = -1;
					cachedLines = [];
				},
				render(width: number): string[] {
					if (cachedLines.length > 0 && cachedWidth === width) {
						return cachedLines;
					}

					const dim = (s: string) => theme.fg("dim", s);
					const muted = (s: string) => theme.fg("muted", s);
					// User's ASCII castle design (66 chars wide, centered in 72)
					const castlePad = "   ";

					const castleLines = [
						castlePad + dim(" #_||_#                                                    #_||_#"),
						castlePad + dim(" \\####/                                                     \\####/"),
						castlePad + dim("  │                      🏰 Agent Castle                       │"),
						castlePad + dim("  |  |   # # # #                                   # # # #   |  |"),
						castlePad + dim("  | #|---|-----|                                   |-----|---|# |"),
						castlePad + dim("  |  |         +-----------------------------------+         |  |"),
						castlePad + dim("/    \\        |                                   |        /    \\"),
						castlePad + dim("|      |       |                                   |       |      |"),
						castlePad + dim("|  /\\  |       |                                   |       |  /\\  |"),
						castlePad + dim("| /  \\ |       |                                   |       | /  \\ |"),
						castlePad + dim("|/    \\| #_||_#|                                   |#_||_# |/    \\|"),
						castlePad + dim(" \\####/  \\####/|                                   |\\####/  \\####/"),
						castlePad + dim("  |  |    |  | |                                   | |  |    |  |"),
						castlePad + dim("  | #|    | #| |                                   | | #|    | #|"),
						castlePad + dim(" _|__|____|__| |                                   | |__|____|__|_"),
						castlePad + dim("|            | |                                   | |            |"),
						castlePad + dim("|   /\\/\\/\\   | |                                   | |   /\\/\\/\\   |"),
						castlePad + dim("|__|______|__|_______________________________________|__|______|__|"),
					];

					// Bottom box content rows — inside the +-----------------------------------+ area
					const boxW = 33;
					const makeBottomRow = (content: string): string => {
						const w = Math.min(visibleWidth(content), boxW);
						const pad = Math.max(0, Math.floor((boxW - w) / 2));
						const right = Math.max(0, boxW - pad - w);
						return castlePad + dim("|  |      |  | | ") + " ".repeat(pad) + muted(content) + " ".repeat(right) + dim(" | |  |      |  |");
					};

					const contentRows = [
						makeBottomRow(`🧠 Model:       ${modelId}`),
						makeBottomRow(`📊 Context:     ${cwStr} tokens`),
						makeBottomRow(`🧩 Extensions:  ${extCount}`),
						makeBottomRow(`📝 Prompts:     ${promptCount}`),
						makeBottomRow(`🎨 Themes:      ${themeCount}`),
					];

					const lines: string[] = [
						...castleLines.slice(0, 17),  // lines 0-16 (top + middle of castle)
						...contentRows,                // info rows inside bottom box
						castlePad + dim("|  |      |  | +-----------------------------------+ |  |      |  |"),  // bottom box border
						castlePad + dim("|__|______|__|_______________________________________|__|______|__|"),  // footer
					];
					cachedWidth = width;
					cachedLines = lines;
					return lines;
				},
			};
		});
		startupWidgetActive = true;
	}
}
