/**
 * context-info — Unified context telemetry + status bar indicator
 *
 * 1. Status bar: colored dot with current/contextWindow token count in footer.
 *    Color thresholds: green → orange → red (hardcoded ANSI, not theme).
 * 2. Telemetry: emits one JSON event on stdout with initial context usage
 *    for supervisor / JSON-mode clients.
 *
 * Event format:
 *   {"type":"context_info","contextTokens":<number>,"contextWindow":<number>}
 *
 * Config (optional, .pi/settings.json):
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

/** Format a token count with K/M suffix. */
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

function loadConfig(): ContextStatusBarConfig | null {
	const defaults = { enabled: true, thresholds: DEFAULT_THRESHOLDS };
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) return defaults;

	let settings: Record<string, unknown>;
	try {
		const raw = readFileSync(settingsPath, "utf-8");
		settings = JSON.parse(raw);
	} catch {
		console.warn("[context-info] Failed to parse .pi/settings.json; using defaults");
		return defaults;
	}

	const raw = settings["contextStatusBar"];
	if (raw === undefined) return defaults;

	if (typeof raw !== "object" || raw === null) {
		console.warn("[context-info] contextStatusBar must be an object; using defaults");
		return defaults;
	}

	const cfg = raw as Record<string, unknown>;

	let enabled = true;
	if ("enabled" in cfg) {
		if (typeof cfg.enabled === "boolean") {
			enabled = cfg.enabled;
		} else {
			console.warn("[context-info] contextStatusBar.enabled must be boolean; using true");
		}
	}

	if (enabled === false) return null;

	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		console.warn("[context-info] contextStatusBar.thresholds missing or empty; falling back to defaults");
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
			console.warn("[context-info] contextStatusBar.thresholds has no valid entries; falling back to defaults");
			thresholds = DEFAULT_THRESHOLDS;
		} else {
			thresholds = parsed;
		}
	}

	return { enabled, thresholds };
}

// ─── Extension ───────────────────────────────────────────────────────

export default function contextInfo(pi: ExtensionAPI) {
	// State — shared between status bar and telemetry
	let config: ContextStatusBarConfig | null = null;
	let lastContextWindow: number | undefined;
	let emitted = false;

	// ── Hooks ──────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		config = loadConfig();
		lastContextWindow = undefined;
		emitted = false;

		if (config === null) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

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
		updateStatus(ctx);
		tryEmit(ctx);
	});

	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		updateStatus(ctx);
	});

	pi.on("message_end", async (event, ctx: ExtensionContext) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;

		const usage = ctx.getContextUsage();
		if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
			tryEmit(ctx);
		}
	});

	// ── Internal functions ─────────────────────────────────────────

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

		if (contextWindow !== undefined && contextWindow > 0) {
			lastContextWindow = contextWindow;
		}

		const { text, colorCode } = buildStatus(
			tokens,
			lastContextWindow ?? contextWindow,
			config.thresholds,
		);

		const themedText = `${colorCode}${text}\x1b[39m`;
		ctx.ui.setStatus(STATUS_KEY, themedText);
	}
}
