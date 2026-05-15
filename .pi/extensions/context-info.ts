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
 *       { "maxTokens": 100000, "color": "green" },
 *       { "maxTokens": 150000, "color": "orange" },
 *       { "maxTokens": null, "color": "red" }
 *     ]
 *   }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

interface ThresholdEntry {
	maxTokens: number | null;
	color: string;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000, color: "green" },
	{ maxTokens: 150_000, color: "orange" },
	{ maxTokens: null, color: "red" },
];

// ─── Helpers ─────────────────────────────────────────────────────────

/** Format token count: 1200 → "1.2K", 1200000 → "1.2M" */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Map threshold color name to theme color token */
function resolveColor(name: string): string {
	switch (name) {
		case "green":  return "success";
		case "orange": return "warning";
		case "red":    return "error";
		default:       return "dim";
	}
}

/** Pick threshold for given token count */
function pickThreshold(tokens: number, thresholds: ThresholdEntry[]): ThresholdEntry {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	for (const entry of sorted) {
		if (entry.maxTokens === null) return entry;
		if (tokens <= entry.maxTokens) return entry;
	}
	return sorted[sorted.length - 1]!;
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
	const defaults: ContextStatusBarConfig = { enabled: true, thresholds: DEFAULT_THRESHOLDS };
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
			const maxTokens = e.maxTokens === null || e.maxTokens === undefined ? null : Number(e.maxTokens);
			const color = typeof e.color === "string" ? e.color : "";
			if (maxTokens !== null && !Number.isFinite(maxTokens)) continue;
			if (!color) continue;
			parsed.push({ maxTokens: maxTokens as number | null, color });
		}
		thresholds = parsed.length > 0 ? parsed : DEFAULT_THRESHOLDS;
	}

	return { enabled, thresholds };
}

// ─── Thinking level → icon ───────────────────────────────────────────

function thinkingIcon(level: string | undefined): string {
	switch (level) {
		case "off":     return "○";
		case "minimal": return "◐";
		case "low":     return "◑";
		case "medium":  return "◒";
		case "high":    return "◓";
		case "xhigh":   return "●";
		default:        return "·";
	}
}

function thinkingColor(level: string | undefined): string {
	switch (level) {
		case "off":     return "dim";
		case "minimal": return "dim";
		case "low":     return "muted";
		case "medium":  return "accent";
		case "high":    return "warning";
		case "xhigh":   return "error";
		default:        return "dim";
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

	// ── Startup widget state ───────────────────────────────────────
	let startupWidgetActive = false;

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
			return;
		}

		const cw = ctx.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			lastContextWindow = cw;
		}

		// Install custom footer
		installFooter(ctx);

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

	// ── Telemetry emit ─────────────────────────────────────────────

	function tryEmit(ctx: ExtensionContext) {
		if (emitted) return;
		if (!lastContextWindow || lastContextWindow <= 0) return;
		const usage = ctx.getContextUsage();
		if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) return;
		emitted = true;
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

					// ── RIGHT: Token usage + percentage ──────────
					let rightStr = "";
					if (tokens !== null && tokens !== undefined) {
						const currentFmt = formatTokens(tokens);
						const maxFmt = lastContextWindow ? formatTokens(lastContextWindow) : "?";
						const pct = lastContextWindow && lastContextWindow > 0
							? Math.round((tokens / lastContextWindow) * 100)
							: null;

						const entry = pickThreshold(tokens, config.thresholds);
						const usageColor = resolveColor(entry.color);

						const tokenText = `${currentFmt}/${maxFmt}`;
						rightStr = theme.fg("dim", "◉ ") + theme.fg(usageColor, tokenText);

						if (pct !== null) {
							const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "dim";
							rightStr += " " + theme.fg(pctColor, `[${pct}%]`);
						}
					} else {
						rightStr = theme.fg("dim", `◉ .../${lastContextWindow ? formatTokens(lastContextWindow) : "?"}`);
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
							" ".repeat(padLeft + 1) + sep + " ".repeat(1) +
							centerStr +
							" ".repeat(padRight + 1) + sep + " ".repeat(1) +
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
				.filter(e => e.isFile() && e.name.endsWith(suffix))
				.map(e => e.name.replace(new RegExp(`${suffix.replace(".", "\\.")}$`), ""))
				.sort();
		} catch { return []; }
	}

	function showWelcomeBanner(ctx: ExtensionContext) {
		// Collect info once at startup
		const extNames = listNames(".pi/extensions", ".ts");
		const promptNames = listNames(".pi/prompts", ".md");
		const themeNames = listNames(".pi/themes", ".json");
		const modelId = ctx.model?.id ?? "?";
		const cw = ctx.model?.contextWindow;
		const cwStr = typeof cw === "number" && cw > 0 ? formatTokens(cw) : "?";

		ctx.ui.setWidget("agentcastle-welcome", (_tui, theme) => {
			let cachedWidth = -1;
			let cachedLines: string[] = [];

			const BOX_W = 48; // fixed internal box width

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
					const accent = (s: string) => theme.fg("accent", s);
					const muted = (s: string) => theme.fg("muted", s);

					const top = dim("╭" + "─".repeat(BOX_W - 2) + "╮");
					const mid = dim("├" + "─".repeat(BOX_W - 2) + "┤");
					const bot = dim("╰" + "─".repeat(BOX_W - 2) + "╯");

					function row(content: string): string {
						const innerW = BOX_W - 4; // space inside borders minus 2 padding spaces
						const visW = visibleWidth(content);
						const padNeeded = Math.max(0, innerW - visW);
						return dim("│") + " " + content + " ".repeat(padNeeded) + " " + dim("│");
					}

					// Wrap comma-separated list into multiple rows
					function listRows(prefix: string, names: string[]): string[] {
						const innerW = BOX_W - 4;
						const out: string[] = [];
						if (names.length === 0) {
							out.push(row(muted(`${prefix}(none)`)));
							return out;
						}
						let line = prefix;
						let isFirst = true;
						for (const name of names) {
							const sep = isFirst ? "" : ", ";
							const candidate = line + sep + name;
							if (visibleWidth(candidate) <= innerW) {
								line = candidate;
								isFirst = false;
							} else {
								out.push(row(muted(line)));
								line = `  ${name}`;
								isFirst = false;
							}
						}
						if (line) out.push(row(muted(line)));
						return out;
					}

					const pad = Math.max(0, Math.floor((width - BOX_W) / 2));
					const pf = " ".repeat(pad);

					const lines = [
						pf + top,
						pf + row(accent(theme.bold("🏰 Agent Castle"))),
						pf + mid,
						pf + row(muted(`🧠 Model:      ${modelId}`)),
						pf + row(muted(`📊 Context:    ${cwStr} tokens`)),
						...listRows("🧩 Extensions: ", extNames).map(l => pf + l),
						...listRows("📝 Prompts:    ", promptNames).map(l => pf + l),
						...listRows("🎨 Themes:     ", themeNames).map(l => pf + l),
						pf + bot,
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
