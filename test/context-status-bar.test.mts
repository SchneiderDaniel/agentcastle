/**
 * Tests for context-status-bar extension
 *
 * Covers: formatTokens, resolveColor, pickThreshold, config validation,
 * setStatus calls on turn_end, and edge cases (unknown usage, bad config, etc.)
 *
 * Run with:
 *   node --experimental-strip-types --test test/context-status-bar.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Duplicated helpers from the extension (mirrors .pi/extensions/context-status-bar.ts exactly)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

interface ThresholdEntry {
	maxTokens: number | null;
	color: string;
}

function resolveColor(name: string): string {
	switch (name) {
		case "green": return "success";
		case "orange": return "warning";
		case "red": return "error";
		default: return "dim";
	}
}

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000, color: "green" },
	{ maxTokens: 150_000, color: "orange" },
	{ maxTokens: null, color: "red" },
];

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
	// Fallback (should never reach here if null is present)
	return sorted[sorted.length - 1]!;
}

interface ContextStatusBarConfig {
	enabled?: boolean;
	thresholds: ThresholdEntry[];
}

function loadConfig(
	rawSettings: Record<string, unknown> | null,
): { config: ContextStatusBarConfig | null; warnings: string[] } {
	const warnings: string[] = [];
	if (!rawSettings || typeof rawSettings !== "object") {
		return { config: null, warnings };
	}

	const raw = (rawSettings as Record<string, unknown>)["contextStatusBar"];
	if (raw === undefined) {
		return { config: null, warnings };
	}
	if (typeof raw !== "object" || raw === null) {
		warnings.push("contextStatusBar must be an object; falling back to defaults");
		return { config: { enabled: false, thresholds: DEFAULT_THRESHOLDS }, warnings };
	}

	const cfg = raw as Record<string, unknown>;

	// enabled
	let enabled = true;
	if ("enabled" in cfg) {
		if (typeof cfg.enabled === "boolean") {
			enabled = cfg.enabled;
		} else {
			warnings.push("contextStatusBar.enabled must be boolean; using true");
		}
	}

	// thresholds
	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		warnings.push("contextStatusBar.thresholds missing or empty; falling back to defaults");
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
		if (parsed.length === 0) {
			warnings.push("contextStatusBar.thresholds has no valid entries; falling back to defaults");
			thresholds = DEFAULT_THRESHOLDS;
		} else {
			thresholds = parsed;
		}
	}

	return { config: { enabled, thresholds }, warnings };
}

function buildStatusText(
	tokens: number | null,
	contextWindow: number | undefined,
	thresholds: ThresholdEntry[],
): { text: string; themeColor: string } {
	const windowK = contextWindow !== undefined && contextWindow > 0
		? formatTokens(contextWindow)
		: "?";

	if (tokens === null || tokens === undefined) {
		// Unknown usage
		return { text: `• .../${windowK}`, themeColor: "dim" };
	}

	const currentK = formatTokens(tokens);
	const entry = pickThreshold(tokens, thresholds);
	return {
		text: `• ${currentK}/${windowK}`,
		themeColor: resolveColor(entry.color),
	};
}

// ---------------------------------------------------------------------------
// Mock extension harness (matches context-info.test.mts pattern)
// ---------------------------------------------------------------------------

interface MockExtensionContext {
	setStatusCalls: Array<{ key: string; text: string | undefined }>;
	_windows: number[];
}

function createMockCtx(): MockExtensionContext {
	return {
		setStatusCalls: [],
		_windows: [],
	};
}

function createExtensionState() {
	let config: ContextStatusBarConfig | null = null;
	let warnings: string[] = [];
	let lastContextWindow: number | undefined;

	// Simulate the turn_end handler
	function onTurnEnd(
		mockCtx: MockExtensionContext,
		getContextUsageReturn: { tokens: number | null; contextWindow: number } | null | undefined,
		themeFg: (key: string, text: string) => string,
	) {
		let tokens: number | null = null;
		let contextWindow: number | undefined;

		if (getContextUsageReturn) {
			tokens = getContextUsageReturn.tokens;
			contextWindow = getContextUsageReturn.contextWindow;
		}

		if (contextWindow !== undefined && contextWindow > 0) {
			lastContextWindow = contextWindow;
		}

		if (!config || config.enabled === false) {
			mockCtx.setStatusCalls.push({ key: "contextUsage", text: undefined });
			return;
		}

		const thresholds = config.thresholds;
		const { text, themeColor } = buildStatusText(
			tokens,
			lastContextWindow ?? contextWindow,
			thresholds,
		);

		const themedText = themeFg(themeColor, text);
		mockCtx.setStatusCalls.push({ key: "contextUsage", text: themedText });
	}

	return { onTurnEnd, _setConfig: (c: ContextStatusBarConfig | null) => { config = c; } };
}

// A simple theme fg function for testing
function mockThemeFg(color: string, text: string): string {
	return `[${color}]${text}[/${color}]`;
}

// ---------------------------------------------------------------------------
// formatTokens tests
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("formats K values", () => {
		assert.strictEqual(formatTokens(12_000), "12.0K");
		assert.strictEqual(formatTokens(1_000), "1.0K");
		assert.strictEqual(formatTokens(100_000), "100.0K");
		assert.strictEqual(formatTokens(999_999), "1000.0K"); // edge
	});

	it("formats M values", () => {
		assert.strictEqual(formatTokens(1_000_000), "1.0M");
		assert.strictEqual(formatTokens(2_500_000), "2.5M");
	});

	it("formats small values (no suffix)", () => {
		assert.strictEqual(formatTokens(0), "0");
		assert.strictEqual(formatTokens(999), "999");
		assert.strictEqual(formatTokens(42), "42");
	});
});

// ---------------------------------------------------------------------------
// resolveColor tests
// ---------------------------------------------------------------------------

describe("resolveColor", () => {
	it('maps "green" → "success"', () => {
		assert.strictEqual(resolveColor("green"), "success");
	});

	it('maps "orange" → "warning"', () => {
		assert.strictEqual(resolveColor("orange"), "warning");
	});

	it('maps "red" → "error"', () => {
		assert.strictEqual(resolveColor("red"), "error");
	});

	it("maps unknown colors to dim", () => {
		assert.strictEqual(resolveColor("blue"), "dim");
		assert.strictEqual(resolveColor("purple"), "dim");
		assert.strictEqual(resolveColor(""), "dim");
	});
});

// ---------------------------------------------------------------------------
// pickThreshold tests
// ---------------------------------------------------------------------------

describe("pickThreshold", () => {
	const thresholds = DEFAULT_THRESHOLDS;

	it("≤100K returns green", () => {
		assert.strictEqual(pickThreshold(0, thresholds).color, "green");
		assert.strictEqual(pickThreshold(50_000, thresholds).color, "green");
		assert.strictEqual(pickThreshold(100_000, thresholds).color, "green");
	});

	it(">100K and ≤150K returns orange", () => {
		assert.strictEqual(pickThreshold(100_001, thresholds).color, "orange");
		assert.strictEqual(pickThreshold(150_000, thresholds).color, "orange");
	});

	it(">150K returns red", () => {
		assert.strictEqual(pickThreshold(150_001, thresholds).color, "red");
		assert.strictEqual(pickThreshold(500_000, thresholds).color, "red");
	});

	it("handles custom thresholds", () => {
		const custom: ThresholdEntry[] = [
			{ maxTokens: 50_000, color: "green" },
			{ maxTokens: null, color: "orange" },
		];
		assert.strictEqual(pickThreshold(30_000, custom).color, "green");
		assert.strictEqual(pickThreshold(60_000, custom).color, "orange");
	});

	it("null catch-all always matches last", () => {
		const custom: ThresholdEntry[] = [
			{ maxTokens: 10_000, color: "green" },
			{ maxTokens: null, color: "red" },
		];
		assert.strictEqual(pickThreshold(50_000, custom).color, "red");
	});

	it("sorts thresholds by maxTokens ascending before picking", () => {
		const unsorted: ThresholdEntry[] = [
			{ maxTokens: 50_000, color: "green" },
			{ maxTokens: 10_000, color: "orange" },
			{ maxTokens: null, color: "red" },
		];
		// 5K ≤ 10K → orange (first match after sorting)
		assert.strictEqual(pickThreshold(5_000, unsorted).color, "orange");
		// 15K ≤ 50K → green
		assert.strictEqual(pickThreshold(15_000, unsorted).color, "green");
		// 100K → null → red
		assert.strictEqual(pickThreshold(100_000, unsorted).color, "red");
	});
});

// ---------------------------------------------------------------------------
// Config loading tests
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	it("returns null when key is absent", () => {
		const result = loadConfig({ supervisor: {} });
		assert.strictEqual(result.config, null);
	});

	it("returns null when settings is null", () => {
		const result = loadConfig(null);
		assert.strictEqual(result.config, null);
	});

	it("returns null when settings is empty object", () => {
		const result = loadConfig({});
		assert.strictEqual(result.config, null);
	});

	it("loads valid config with thresholds", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [
					{ maxTokens: 50_000, color: "green" },
					{ maxTokens: null, color: "red" },
				],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.thresholds.length, 2);
	});

	it("respects enabled: false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, false);
	});

	it("falls back to defaults when thresholds missing", () => {
		const result = loadConfig({ contextStatusBar: { enabled: true } });
		assert.ok(result.config);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("falls back to defaults when thresholds is empty array", () => {
		const result = loadConfig({ contextStatusBar: { thresholds: [] } });
		assert.ok(result.config);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("falls back when contextStatusBar is not an object", () => {
		const result = loadConfig({ contextStatusBar: "not-an-object" });
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, false); // bad config → fallback
		assert.ok(result.warnings.length > 0);
	});

	it("skips invalid threshold entries", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [
					{ maxTokens: "bad", color: "green" }, // maxTokens NaN
					{ maxTokens: 50_000, color: "" },     // empty color
					{ maxTokens: 100_000, color: "green" }, // valid
				],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.thresholds.length, 1);
		assert.strictEqual(result.config!.thresholds[0]!.maxTokens, 100_000);
	});

	it("allows null maxTokens for catch-all", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.thresholds[0]!.maxTokens, null);
	});
});

// ---------------------------------------------------------------------------
// buildStatusText tests
// ---------------------------------------------------------------------------

describe("buildStatusText", () => {
	const ctxWindow = 200_000;

	it("renders green for low usage", () => {
		const result = buildStatusText(45_000, ctxWindow, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• 45.0K/200.0K");
		assert.strictEqual(result.themeColor, "success");
	});

	it("renders orange for medium usage", () => {
		const result = buildStatusText(120_000, ctxWindow, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• 120.0K/200.0K");
		assert.strictEqual(result.themeColor, "warning");
	});

	it("renders red for high usage", () => {
		const result = buildStatusText(180_000, ctxWindow, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• 180.0K/200.0K");
		assert.strictEqual(result.themeColor, "error");
	});

	it("renders dim for unknown tokens (null)", () => {
		const result = buildStatusText(null, ctxWindow, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• .../200.0K");
		assert.strictEqual(result.themeColor, "dim");
	});

	it("renders dim for undefined tokens", () => {
		const result = buildStatusText(undefined as unknown as null, ctxWindow, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• .../200.0K");
		assert.strictEqual(result.themeColor, "dim");
	});

	it("renders ? for unknown context window", () => {
		const result = buildStatusText(50_000, undefined, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• 50.0K/?");
		assert.strictEqual(result.themeColor, "success");
	});

	it("renders ? for zero context window", () => {
		const result = buildStatusText(50_000, 0, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• 50.0K/?");
	});

	it("renders dim ... for both unknown", () => {
		const result = buildStatusText(null, undefined, DEFAULT_THRESHOLDS);
		assert.strictEqual(result.text, "• .../?");
		assert.strictEqual(result.themeColor, "dim");
	});
});

// ---------------------------------------------------------------------------
// Integration: turn_end → setStatus called
// ---------------------------------------------------------------------------

describe("turn_end integration", () => {
	it("calls setStatus with colored text on valid usage", () => {
		const mockCtx = createMockCtx();
		const ext = createExtensionState();
		ext._setConfig({ enabled: true, thresholds: DEFAULT_THRESHOLDS });

		ext.onTurnEnd(
			mockCtx,
			{ tokens: 45_000, contextWindow: 200_000 },
			mockThemeFg,
		);

		assert.strictEqual(mockCtx.setStatusCalls.length, 1);
		assert.strictEqual(mockCtx.setStatusCalls[0]!.key, "contextUsage");
		assert.ok(mockCtx.setStatusCalls[0]!.text!.includes("[success]"));
		assert.ok(mockCtx.setStatusCalls[0]!.text!.includes("45.0K/200.0K"));
	});

	it("calls setStatus with dim text when usage is null", () => {
		const mockCtx = createMockCtx();
		const ext = createExtensionState();
		ext._setConfig({ enabled: true, thresholds: DEFAULT_THRESHOLDS });

		ext.onTurnEnd(
			mockCtx,
			{ tokens: null, contextWindow: 200_000 },
			mockThemeFg,
		);

		assert.strictEqual(mockCtx.setStatusCalls.length, 1);
		assert.ok(mockCtx.setStatusCalls[0]!.text!.includes("[dim]"));
		assert.ok(mockCtx.setStatusCalls[0]!.text!.includes(".../200.0K"));
	});

	it("clears status when config disabled", () => {
		const mockCtx = createMockCtx();
		const ext = createExtensionState();
		ext._setConfig({ enabled: false, thresholds: DEFAULT_THRESHOLDS });

		ext.onTurnEnd(
			mockCtx,
			{ tokens: 45_000, contextWindow: 200_000 },
			mockThemeFg,
		);

		assert.strictEqual(mockCtx.setStatusCalls.length, 1);
		assert.strictEqual(mockCtx.setStatusCalls[0]!.text, undefined);
	});

	it("clears status when config is null", () => {
		const mockCtx = createMockCtx();
		const ext = createExtensionState();
		ext._setConfig(null);

		ext.onTurnEnd(
			mockCtx,
			{ tokens: 45_000, contextWindow: 200_000 },
			mockThemeFg,
		);

		assert.strictEqual(mockCtx.setStatusCalls.length, 1);
		assert.strictEqual(mockCtx.setStatusCalls[0]!.text, undefined);
	});

	it("caches contextWindow across calls when usage is null", () => {
		const mockCtx = createMockCtx();
		const ext = createExtensionState();
		ext._setConfig({ enabled: true, thresholds: DEFAULT_THRESHOLDS });

		// First call: sets cache from getContextUsage contextWindow
		ext.onTurnEnd(
			mockCtx,
			{ tokens: 50_000, contextWindow: 200_000 },
			mockThemeFg,
		);
		assert.ok(mockCtx.setStatusCalls[0]!.text!.includes("200.0K"));

		// Second call: usage null, getContextUsage returns 0 contextWindow, should use cache
		ext.onTurnEnd(
			mockCtx,
			{ tokens: null, contextWindow: 0 },
			mockThemeFg,
		);
		assert.ok(mockCtx.setStatusCalls[1]!.text!.includes("200.0K"));
	});

	it("calls setStatus with red for exceeded thresholds", () => {
		const mockCtx = createMockCtx();
		const ext = createExtensionState();
		ext._setConfig({ enabled: true, thresholds: DEFAULT_THRESHOLDS });

		ext.onTurnEnd(
			mockCtx,
			{ tokens: 200_000, contextWindow: 200_000 },
			mockThemeFg,
		);

		assert.ok(mockCtx.setStatusCalls[0]!.text!.includes("[error]"));
		assert.ok(mockCtx.setStatusCalls[0]!.text!.includes("200.0K/200.0K"));
	});
});
