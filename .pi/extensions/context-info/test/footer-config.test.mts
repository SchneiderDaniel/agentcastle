/**
 * Tests for FooterConfig consolidation — verifying the new interface
 * and installFooter signature work correctly.
 *
 * These test the interface shape and behavior. The FooterConfig interface
 * and installFooter function are replicated inline (same pattern as
 * context-info.test.mts) because --experimental-strip-types doesn't
 * resolve transitive local imports.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/footer-config.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Inline FooterConfig interface (matches .pi/extensions/context-info/types.ts)
// ---------------------------------------------------------------------------

interface TpsSample {
	time: number;
	cumulativeTokens: number;
}

interface ThresholdEntry {
	maxTokens: number | null;
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
	showTps: boolean;
	showCache: boolean;
}

interface FooterConfig {
	worktreeName: string | null;
	thinkingLevel: string;
	tpsSamples: TpsSample[];
	lastComputedTps: { value: number | null };
	lastContextWindow: { value: number | undefined };
	toolCallCount: { value: number };
	cacheRead: number | undefined;
	cacheWrite: number | undefined;
}

// ---------------------------------------------------------------------------
// Inline installFooter (matches .pi/extensions/context-info/footer.ts)
// ---------------------------------------------------------------------------

/** Format token count: 1200 → "1.2K", 1200000 → "1.2M" */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Apply hex foreground color via ANSI truecolor */
function fgHex(_hex: string, text: string): string {
	// Mock — no actual ANSI in tests
	return text;
}

/** Pick threshold for given token count and return hex color */
function pickThresholdHex(tokens: number, thresholds: ThresholdEntry[]): string {
	const sorted = [...thresholds].sort((a, b) => {
		if (a.maxTokens === null) return 1;
		if (b.maxTokens === null) return -1;
		return a.maxTokens - b.maxTokens;
	});
	for (let i = 0; i < sorted.length; i++) {
		const entry = sorted[i];
		if (entry.maxTokens === null) return "#ff5252";
		if (tokens <= entry.maxTokens) return "#50fa7b";
	}
	return "#ff5252";
}

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

function formatSessionTimer(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `\u23f1 ${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `\u23f1 ${minutes}m ${seconds}s`;
	return `\u23f1 ${seconds}s`;
}

function computeTps(samples: TpsSample[]): number | null {
	if (samples.length < 2) return null;
	const now = Date.now();
	const cutoff = now - 30_000;
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

function formatTps(tps: number | null): string {
	if (tps === null) return "-- t/s";
	if (tps < 0.1) return "0.0 t/s";
	if (tps > 999.9) return `${Math.round(tps)} t/s`;
	return `${tps.toFixed(1)} t/s`;
}

function formatCacheStats(
	cacheRead: number | undefined | null,
	cacheWrite: number | undefined | null,
): string {
	if (
		cacheRead === undefined ||
		cacheRead === null ||
		cacheWrite === undefined ||
		cacheWrite === null
	) {
		return "\u{1F4E6} --/--";
	}
	return `\u{1F4E6} ${formatTokens(cacheRead)}/${formatTokens(cacheWrite)}`;
}

/** Simplified visibleWidth for tests — uses string length */
function visibleWidth(s: string): number {
	return s.length;
}

function truncateToWidth(s: string, width: number): string {
	return s.length <= width ? s : s.substring(0, width);
}

/** Module-scope process start time */
const processStartTime = Date.now();

function installFooter(
	ctx: any,
	config: ContextStatusBarConfig | null,
	footerConfig: FooterConfig,
): void {
	const { worktreeName, thinkingLevel } = footerConfig;
	if (!config || config.enabled === false) {
		ctx.ui.setFooter(undefined);
		return;
	}

	const showTimer = config.showTimer;

	ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				// ── Compute token usage ───────────────────────
				const usage = ctx.getContextUsage();
				const tokens = usage?.tokens ?? null;
				const cw = usage?.contextWindow ?? footerConfig.lastContextWindow.value;
				if (cw && cw > 0) footerConfig.lastContextWindow.value = cw;

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

				// ── Separator character ──────────────────────
				const sep = theme.fg("dim", "│");

				// ── Extension statuses ───────────────────────
				const extStatuses = footerData.getExtensionStatuses();
				let extStr = "";
				if (extStatuses.size > 0) {
					const parts: string[] = [];
					for (const [, text] of extStatuses) {
						if (text) parts.push(text);
					}
					if (parts.length > 0) extStr = parts.join(" " + sep + " ");
				}

				// ── CENTER: Model + reasoning + tool count ───
				const modelId = ctx.model?.id ?? "?";
				let centerStr = theme.fg("dim", "🧠 ") + theme.fg("accent", modelId);
				if (thinkingLevel) {
					const tIcon = thinkingIcon(thinkingLevel);
					const tColor = thinkingColor(thinkingLevel);
					const reasoningStr = theme.fg(tColor, `${tIcon} ${thinkingLevel}`);
					centerStr += " " + theme.fg("dim", "·") + " " + reasoningStr;
				}

				// ── Tool call counter ─────────────────────────
				const toolStr =
					theme.fg("dim", "🔧") + " " + theme.fg("muted", String(footerConfig.toolCallCount.value));
				centerStr += " " + theme.fg("dim", "·") + " " + toolStr;

				// ── RIGHT: Session timer + token usage + percentage ──
				let rightStr = "";

				let timerStr = "";
				if (showTimer) {
					const elapsed = Date.now() - processStartTime;
					const rawTimer = formatSessionTimer(elapsed);
					timerStr = theme.fg("dim", rawTimer);
				}

				let tokenDisplay = "";
				if (tokens !== null && tokens !== undefined) {
					const currentFmt = formatTokens(tokens);
					const maxFmt = footerConfig.lastContextWindow.value
						? formatTokens(footerConfig.lastContextWindow.value)
						: "?";
					const pct =
						footerConfig.lastContextWindow.value && footerConfig.lastContextWindow.value > 0
							? Math.round((tokens / footerConfig.lastContextWindow.value) * 100)
							: null;

					const usageHex = pickThresholdHex(tokens, config.thresholds);

					const tokenText = `${currentFmt}/${maxFmt}`;
					tokenDisplay = theme.fg("dim", "◉ ") + fgHex(usageHex, tokenText);

					if (pct !== null) {
						const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "dim";
						tokenDisplay += " " + theme.fg(pctColor, `[${pct}%]`);
					}
				} else if (footerConfig.lastContextWindow.value) {
					tokenDisplay = theme.fg(
						"dim",
						`◉ .../${formatTokens(footerConfig.lastContextWindow.value)}`,
					);
				} else {
					tokenDisplay = theme.fg("dim", "◉ .../?");
				}

				if (timerStr && tokenDisplay) {
					rightStr = `${timerStr} \u00b7 ${tokenDisplay}`;
				} else if (timerStr) {
					rightStr = timerStr;
				} else {
					rightStr = tokenDisplay;
				}

				// ── TPS computation ───────────────────────────
				const computed = computeTps(footerConfig.tpsSamples);
				if (computed !== null) {
					footerConfig.lastComputedTps.value = computed;
				}

				// ── Build row 1 ─────────────────────────────────
				const leftW = visibleWidth(leftStr);
				const centerW = visibleWidth(centerStr);
				const rightW = visibleWidth(rightStr);
				const sepUnit = 3;

				let row1: string;
				if (leftW + centerW + rightW + 2 * sepUnit <= width) {
					const leftSection = leftStr + " " + sep + " ";
					const centerSection = centerStr + " " + sep + " ";
					const beforeRight = leftSection + centerSection;
					const beforeRightW = visibleWidth(beforeRight);
					const padForRight = Math.max(0, width - beforeRightW - rightW);
					row1 = beforeRight + " ".repeat(padForRight) + rightStr;
				} else if (leftW + rightW + sepUnit <= width) {
					const leftSection = leftStr + " " + sep + " ";
					const leftSectionW = visibleWidth(leftSection);
					const padBeforeRight = Math.max(0, width - leftSectionW - rightW);
					row1 = leftSection + " ".repeat(padBeforeRight) + rightStr;
				} else {
					row1 = " ".repeat(Math.max(0, width - rightW)) + rightStr;
				}

				row1 = truncateToWidth(row1, width);

				// ── Build row 2 ────────────────────────────────
				const left2 = extStr || "";
				const rightParts: string[] = [];
				if (config.showTps) {
					const tpsDisplay = formatTps(footerConfig.lastComputedTps.value);
					rightParts.push(theme.fg("dim", tpsDisplay));
				}
				if (config.showCache) {
					const cacheStr = formatCacheStats(footerConfig.cacheRead, footerConfig.cacheWrite);
					rightParts.push(theme.fg("dim", cacheStr));
				}
				const right2 = rightParts.join(" " + sep + " ");

				if (left2 || right2) {
					const lw = visibleWidth(left2);
					const rw = visibleWidth(right2);
					const gap = Math.max(0, width - lw - rw);
					const row2 = right2
						? left2 + " ".repeat(gap) + right2
						: left2 + " ".repeat(Math.max(0, width - lw));
					return [row1, truncateToWidth(row2, width)];
				}

				return [row1];
			},
		};
	});

	ctx.ui.setStatus("contextUsage", undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FooterConfig", () => {
	it("can be created with default values matching the interface", () => {
		const config: FooterConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
		};

		assert.strictEqual(config.worktreeName, null);
		assert.strictEqual(config.thinkingLevel, "");
		assert.deepStrictEqual(config.tpsSamples, []);
		assert.strictEqual(config.lastComputedTps.value, null);
		assert.strictEqual(config.lastContextWindow.value, undefined);
		assert.strictEqual(config.toolCallCount.value, 0);
		assert.strictEqual(config.cacheRead, undefined);
		assert.strictEqual(config.cacheWrite, undefined);
	});

	it("value wrappers allow mutation through shared reference", () => {
		const config: FooterConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
		};

		// Simulate passing footerConfig by reference and mutating
		const ref = config;
		ref.toolCallCount.value = 5;
		ref.lastComputedTps.value = 42.5;
		ref.lastContextWindow.value = 128000;
		ref.worktreeName = "my-feature";
		ref.thinkingLevel = "high";
		ref.cacheRead = 76288;
		ref.cacheWrite = 0;

		// Original reflects all mutations
		assert.strictEqual(config.worktreeName, "my-feature");
		assert.strictEqual(config.thinkingLevel, "high");
		assert.strictEqual(config.lastComputedTps.value, 42.5);
		assert.strictEqual(config.lastContextWindow.value, 128000);
		assert.strictEqual(config.toolCallCount.value, 5);
		assert.strictEqual(config.cacheRead, 76288);
		assert.strictEqual(config.cacheWrite, 0);
	});

	it("tpsSamples array mutations are visible through reference", () => {
		const config: FooterConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
		};

		const ref = config;
		ref.tpsSamples.push({ time: 1000, cumulativeTokens: 50 });
		ref.tpsSamples.push({ time: 2000, cumulativeTokens: 150 });

		assert.strictEqual(config.tpsSamples.length, 2);
		assert.strictEqual(config.tpsSamples[0]!.cumulativeTokens, 50);
	});

	it("supports typed access with all fields populated", () => {
		const config: FooterConfig = {
			worktreeName: "main",
			thinkingLevel: "medium",
			tpsSamples: [{ time: Date.now(), cumulativeTokens: 100 }],
			lastComputedTps: { value: 15.3 },
			lastContextWindow: { value: 128000 },
			toolCallCount: { value: 3 },
			cacheRead: 50000,
			cacheWrite: 20000,
		};

		assert.strictEqual(config.worktreeName, "main");
		assert.strictEqual(config.thinkingLevel, "medium");
		assert.strictEqual(config.tpsSamples.length, 1);
		assert.strictEqual(config.lastComputedTps.value, 15.3);
	});
});

// ---------------------------------------------------------------------------
// installFooter with FooterConfig
// ---------------------------------------------------------------------------

describe("installFooter with FooterConfig", () => {
	it("calls setFooter with a function when config is enabled", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [],
			showTimer: true,
			showTps: true,
			showCache: true,
		};

		const footerConfig: FooterConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
		};

		let setFooterArg: unknown = undefined;
		const ctx = {
			ui: {
				setFooter: (fn: unknown) => {
					setFooterArg = fn;
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
		};

		installFooter(ctx, config, footerConfig);

		assert.ok(typeof setFooterArg === "function", "setFooter should receive a function");
	});

	it("calls setFooter with undefined when config is disabled", () => {
		const config: ContextStatusBarConfig = {
			enabled: false,
			thresholds: [],
			showTimer: true,
			showTps: true,
			showCache: true,
		};

		const footerConfig: FooterConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
		};

		let setFooterArg: unknown = undefined;
		const ctx = {
			ui: {
				setFooter: (fn: unknown) => {
					setFooterArg = fn;
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
		};

		installFooter(ctx, config, footerConfig);

		assert.strictEqual(setFooterArg, undefined, "setFooter should receive undefined when disabled");
	});

	it("calls setFooter with undefined when config is null", () => {
		const footerConfig: FooterConfig = {
			worktreeName: null,
			thinkingLevel: "",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
		};

		let setFooterArg: unknown = undefined;
		const ctx = {
			ui: {
				setFooter: (fn: unknown) => {
					setFooterArg = fn;
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
		};

		installFooter(ctx, null, footerConfig);

		assert.strictEqual(
			setFooterArg,
			undefined,
			"setFooter should receive undefined when config is null",
		);
	});

	it("render function accesses footerConfig fields through value wrappers", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: null }],
			showTimer: false,
			showTps: false,
			showCache: false,
		};

		const footerConfig: FooterConfig = {
			worktreeName: "test-worktree",
			thinkingLevel: "high",
			tpsSamples: [
				{ time: Date.now() - 5000, cumulativeTokens: 0 },
				{ time: Date.now(), cumulativeTokens: 200 },
			],
			lastComputedTps: { value: 40.0 },
			lastContextWindow: { value: 128000 },
			toolCallCount: { value: 3 },
			cacheRead: 5000,
			cacheWrite: 1000,
		};

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						// Simulate setup call that returns the component
						footerComponent = fn(
							{ requestRender: () => {} },
							{
								fg: (_color: string, text: string) => text,
							},
							{
								onBranchChange: () => () => {},
								getGitBranch: () => "main",
								getExtensionStatuses: () => new Map(),
							},
						);
					}
				},
				setStatus: () => {},
			},
			getContextUsage: () => ({ tokens: 64000, contextWindow: 128000 }),
			model: { id: "test-model" },
		};

		installFooter(ctx, config, footerConfig);

		assert.ok(footerComponent, "footer component should be created");
		assert.ok(typeof footerComponent!.render === "function", "footer should have render method");

		// Render at 80 width — should not throw
		const result = footerComponent!.render(80);
		assert.ok(Array.isArray(result), "render should return string array");
		assert.ok(result.length > 0, "render should return at least one row");
	});

	it("value-wrapped fields (toolCallCount, lastContextWindow) mutations reflect in render", () => {
		const config: ContextStatusBarConfig = {
			enabled: true,
			thresholds: [{ maxTokens: 100000 }],
			showTimer: false,
			showTps: false,
			showCache: false,
		};

		const footerConfig: FooterConfig = {
			worktreeName: null,
			thinkingLevel: "low",
			tpsSamples: [],
			lastComputedTps: { value: null },
			lastContextWindow: { value: undefined },
			toolCallCount: { value: 0 },
			cacheRead: undefined,
			cacheWrite: undefined,
		};

		let footerComponent: { render: (w: number) => string[]; dispose: () => void } | undefined;
		const ctx = {
			ui: {
				setFooter: (fn: unknown) => {
					if (typeof fn === "function") {
						footerComponent = fn(
							{ requestRender: () => {} },
							{
								fg: (_color: string, text: string) => text,
							},
							{
								onBranchChange: () => () => {},
								getGitBranch: () => "main",
								getExtensionStatuses: () => new Map(),
							},
						);
					}
				},
				setStatus: () => {},
			},
			getContextUsage: () => undefined,
			model: { id: "test-model" },
		};

		installFooter(ctx, config, footerConfig);

		// Mutate value-wrapped fields after install — mutations should be visible
		footerConfig.toolCallCount.value = 7;
		footerConfig.lastContextWindow.value = 256000;
		footerConfig.lastComputedTps.value = 50.5;

		// Render should not throw and should reflect new state
		const result = footerComponent!.render(80);
		assert.ok(Array.isArray(result));
		assert.ok(result[0]!.includes("7"), "render output should include tool call count of 7");

		// Fields destructured at call time (worktreeName, thinkingLevel) are not expected
		// to reflect after-install mutations — they're updated by re-installing footer
	});
});
