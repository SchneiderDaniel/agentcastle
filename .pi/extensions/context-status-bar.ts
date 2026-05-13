/**
 * context-status-bar — Color-coded context usage indicator in status bar
 *
 * Displays a colored dot with current/contextWindow token count in the status
 * bar footer after every turn_end. Color changes based on proximity to the
 * context window limit: green → orange → red.
 *
 * Config (optional, .pi/settings.json):
 *   "contextStatusBar": {
 *     "enabled": true,                   // defaults to true
 *     "thresholds": [
 *       { "maxTokens": 100000, "color": "green" },
 *       { "maxTokens": 150000, "color": "orange" },
 *       { "maxTokens": null, "color": "red" }
 *     ]
 *   }
 *
 * Invalid/missing config falls back to defaults and logs a warning.
 */

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────

interface ThresholdEntry {
	maxTokens: number | null;
	color: string;
}

interface ContextStatusBarConfig {
	enabled?: boolean;
	thresholds: ThresholdEntry[];
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000, color: "green" },
	{ maxTokens: 150_000, color: "orange" },
	{ maxTokens: null, color: "red" },
];

const STATUS_KEY = "contextUsage";

// ─── Helpers ─────────────────────────────────────────────────────────

/** Format a token count with K/M suffix. Duplicates supervisor.ts pattern. */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Map user-facing color name to a raw ANSI truecolor escape (bypasses theme). */
function resolveColor(name: string): string {
	switch (name) {
		case "green":  return "\x1b[38;2;0;200;0m";
		case "orange": return "\x1b[38;2;255;165;0m";
		case "red":    return "\x1b[38;2;220;50;50m";
		default:        return "\x1b[39m";
	}
}

/**
 * Pick the first matching threshold for the given token count.
 * Thresholds are sorted by maxTokens ascending; null means catch-all.
 */
function pickThreshold(
	tokens: number,
	thresholds: ThresholdEntry[],
): ThresholdEntry {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	for (const entry of sorted) {
		if (entry.maxTokens === null) return entry;
		if (tokens <= entry.maxTokens) return entry;
	}
	// Fallback (should never reach here if a null entry exists)
	return sorted[sorted.length - 1]!;
}

/** Build the status bar text and its ANSI color code. */
function buildStatus(
	tokens: number | null,
	contextWindow: number | undefined,
	thresholds: ThresholdEntry[],
): { text: string; colorCode: string } {
	const windowK =
		contextWindow !== undefined && contextWindow > 0
			? formatTokens(contextWindow)
			: "?";

	if (tokens === null || tokens === undefined) {
		return { text: `• .../${windowK}`, colorCode: resolveColor("dim") };
	}

	const currentK = formatTokens(tokens);
	const entry = pickThreshold(tokens, thresholds);
	return {
		text: `• ${currentK}/${windowK}`,
		colorCode: resolveColor(entry.color),
	};
}

// ─── Config loading ──────────────────────────────────────────────────

/** Load and validate contextStatusBar config from .pi/settings.json.
 *  Returns defaults when config key is absent or invalid.
 *  Returns null only when enabled is explicitly false (feature disabled). */
function loadConfig(): ContextStatusBarConfig | null {
	const defaults = { enabled: true, thresholds: DEFAULT_THRESHOLDS };
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) return defaults;

	let settings: Record<string, unknown>;
	try {
		const raw = readFileSync(settingsPath, "utf-8");
		settings = JSON.parse(raw);
	} catch {
		console.warn("[context-status-bar] Failed to parse .pi/settings.json; using defaults");
		return defaults;
	}

	const raw = settings["contextStatusBar"];
	if (raw === undefined) return defaults;

	if (typeof raw !== "object" || raw === null) {
		console.warn("[context-status-bar] contextStatusBar must be an object; using defaults");
		return defaults;
	}

	const cfg = raw as Record<string, unknown>;

	// enabled — optional, defaults to true; explicitly false disables the extension
	let enabled = true;
	if ("enabled" in cfg) {
		if (typeof cfg.enabled === "boolean") {
			enabled = cfg.enabled;
		} else {
			console.warn("[context-status-bar] contextStatusBar.enabled must be boolean; using true");
		}
	}

	// When enabled is explicitly false, return null to fully disable the extension
	if (enabled === false) return null;

	// thresholds — required array; fall back to defaults if invalid
	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		console.warn("[context-status-bar] contextStatusBar.thresholds missing or empty; falling back to defaults");
		thresholds = DEFAULT_THRESHOLDS;
	} else {
		const parsed: ThresholdEntry[] = [];
		for (const entry of cfg.thresholds) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			const maxTokens =
				e.maxTokens === null || e.maxTokens === undefined
					? null
					: Number(e.maxTokens);
			const color = typeof e.color === "string" ? e.color : "";
			if (maxTokens !== null && !Number.isFinite(maxTokens)) continue;
			if (!color) continue;
			parsed.push({ maxTokens: maxTokens as number | null, color });
		}
		if (parsed.length === 0) {
			console.warn("[context-status-bar] contextStatusBar.thresholds has no valid entries; falling back to defaults");
			thresholds = DEFAULT_THRESHOLDS;
		} else {
			thresholds = parsed;
		}
	}

	return { enabled, thresholds };
}

// ─── Extension ───────────────────────────────────────────────────────

export default function contextStatusBar(pi: ExtensionAPI) {
	// Load config once at session start — edits require restart or /reload
	let config: ContextStatusBarConfig | null = null;
	// Cache last known context window so we can still show it when
	// getContextUsage() returns null tokens (e.g. right after compaction)
	let lastContextWindow: number | undefined;

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		config = loadConfig();
		lastContextWindow = undefined;

		if (config === null) {
			// Clear any previous status
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		// Grab initial context window from model info
		const cw = ctx.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			lastContextWindow = cw;
		}
	});

	pi.on("model_select", async (event, ctx: ExtensionContext) => {
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			lastContextWindow = cw;
		}
		// Update status bar with new window (if config is active)
		updateStatus(ctx);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		updateStatus(ctx);
	});

	function updateStatus(ctx: ExtensionContext) {
		if (!config || config.enabled === false) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const usage = ctx.getContextUsage();
		let tokens: number | null = null;
		let contextWindow: number | undefined;

		if (usage) {
			tokens = usage.tokens;
			contextWindow = usage.contextWindow;
		}

		// Update cache if we got a valid window
		if (contextWindow !== undefined && contextWindow > 0) {
			lastContextWindow = contextWindow;
		}

		const { text, colorCode } = buildStatus(
			tokens,
			lastContextWindow ?? contextWindow,
			config.thresholds,
		);

		// Use raw ANSI escape — bypasses theme so green is actually green (#00c800)
		const themedText = `${colorCode}${text}\x1b[39m`;
		ctx.ui.setStatus(STATUS_KEY, themedText);
	}
}
