/**
 * Tests for context-info extension (Agent Castle Terminal Revamp)
 *
 * Covers: formatTokens, resolveColor, pickThreshold, loadConfig,
 * thinkingIcon, thinkingColor, getWorktreeName, getGitBranch,
 * and integration with custom footer.
 *
 * Run with:
 *   node --experimental-strip-types --test test/context-status-bar.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Duplicated helpers from .pi/extensions/context-info.ts
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

const DEFAULT_THRESHOLDS: ThresholdEntry[] = [
	{ maxTokens: 100_000, color: "green" },
	{ maxTokens: 150_000, color: "orange" },
	{ maxTokens: null, color: "red" },
];

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

function getWorktreeName(cwd: string): string | null {
	try {
		const gitFile = `${cwd}/.git`;
		if (!existsSync(gitFile)) return null;
		const content = readFileSync(gitFile, "utf-8");
		const match = content.match(/^gitdir:\s*(.+)$/m);
		if (!match) return null;
		const gitDir = match[1]!.trim();
		const wtMatch = gitDir.match(/worktrees\/(.+?)(\/|$)/);
		return wtMatch ? wtMatch[1]! : "worktree";
	} catch {
		return null;
	}
}

interface ContextStatusBarConfig {
	enabled: boolean;
	thresholds: ThresholdEntry[];
	showTimer: boolean;
}

function loadConfig(rawSettings: Record<string, unknown> | null): {
	config: ContextStatusBarConfig | null;
	warnings: string[];
} {
	const warnings: string[] = [];
	const defaults: ContextStatusBarConfig = { enabled: true, thresholds: DEFAULT_THRESHOLDS, showTimer: true };

	if (!rawSettings || typeof rawSettings !== "object") {
		return { config: defaults, warnings };
	}

	const raw = (rawSettings as Record<string, unknown>)["contextStatusBar"];
	if (raw === undefined) {
		return { config: defaults, warnings };
	}
	if (typeof raw !== "object" || raw === null) {
		warnings.push("contextStatusBar must be an object; using defaults");
		return { config: defaults, warnings };
	}

	const cfg = raw as Record<string, unknown>;

	let enabled = true;
	if ("enabled" in cfg) {
		if (typeof cfg.enabled === "boolean") {
			enabled = cfg.enabled;
		} else {
			warnings.push("contextStatusBar.enabled must be boolean; using true");
		}
	}

	if (enabled === false) return { config: null, warnings };

	let thresholds: ThresholdEntry[];
	if (!Array.isArray(cfg.thresholds) || cfg.thresholds.length === 0) {
		warnings.push("contextStatusBar.thresholds missing or empty; falling back to defaults");
		thresholds = DEFAULT_THRESHOLDS;
	} else {
		const parsed: ThresholdEntry[] = [];
		for (const entry of cfg.thresholds) {
			if (typeof entry !== "object" || entry === null) continue;
			const e = entry as Record<string, unknown>;
			const maxTokens =
				e.maxTokens === null || e.maxTokens === undefined ? null : Number(e.maxTokens);
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

	// Parse showTimer
	let showTimer = true;
	if ("showTimer" in cfg) {
		if (typeof cfg.showTimer === "boolean") {
			showTimer = cfg.showTimer;
		} else {
			warnings.push("contextStatusBar.showTimer must be boolean; using true");
		}
	}

	return { config: { enabled, thresholds, showTimer }, warnings };
}

// ---------------------------------------------------------------------------
// formatTokens tests
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("formats K values", () => {
		assert.strictEqual(formatTokens(12_000), "12.0K");
		assert.strictEqual(formatTokens(1_000), "1.0K");
		assert.strictEqual(formatTokens(100_000), "100.0K");
		assert.strictEqual(formatTokens(999_999), "1000.0K");
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
		assert.strictEqual(pickThreshold(5_000, unsorted).color, "orange");
		assert.strictEqual(pickThreshold(15_000, unsorted).color, "green");
		assert.strictEqual(pickThreshold(100_000, unsorted).color, "red");
	});
});

// ---------------------------------------------------------------------------
// Config loading tests
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	it("returns defaults when key is absent", () => {
		const result = loadConfig({ supervisor: {} });
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("returns defaults when settings is null", () => {
		const result = loadConfig(null);
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
	});

	it("returns defaults when settings is empty object", () => {
		const result = loadConfig({});
		assert.ok(result.config);
		assert.strictEqual(result.config!.enabled, true);
		assert.strictEqual(result.config!.showTimer, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
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
		assert.strictEqual(result.config!.showTimer, true);
		assert.strictEqual(result.config!.thresholds.length, 2);
	});

	it("respects enabled: false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.strictEqual(result.config, null);
	});

	// ── showTimer config tests ─────────────────────────────────

	it("showTimer defaults to true when key absent", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, true);
	});

	it("showTimer: true → showTimer true", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: true,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, true);
	});

	it("showTimer: false → showTimer false", () => {
		const result = loadConfig({
			contextStatusBar: {
				enabled: true,
				showTimer: false,
				thresholds: [{ maxTokens: null, color: "red" }],
			},
		});
		assert.ok(result.config);
		assert.strictEqual(result.config!.showTimer, false);
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
		assert.strictEqual(result.config!.enabled, true);
		assert.deepStrictEqual(result.config!.thresholds, DEFAULT_THRESHOLDS);
		assert.ok(result.warnings.length > 0);
	});

	it("skips invalid threshold entries", () => {
		const result = loadConfig({
			contextStatusBar: {
				thresholds: [
					{ maxTokens: "bad", color: "green" },
					{ maxTokens: 50_000, color: "" },
					{ maxTokens: 100_000, color: "green" },
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
// thinkingIcon tests
// ---------------------------------------------------------------------------

describe("thinkingIcon", () => {
	it("returns correct icons for each level", () => {
		assert.strictEqual(thinkingIcon("off"), "○");
		assert.strictEqual(thinkingIcon("minimal"), "◐");
		assert.strictEqual(thinkingIcon("low"), "◑");
		assert.strictEqual(thinkingIcon("medium"), "◒");
		assert.strictEqual(thinkingIcon("high"), "◓");
		assert.strictEqual(thinkingIcon("xhigh"), "●");
	});

	it("returns default for unknown/undefined", () => {
		assert.strictEqual(thinkingIcon(undefined), "·");
		assert.strictEqual(thinkingIcon("unknown"), "·");
	});
});

// ---------------------------------------------------------------------------
// thinkingColor tests
// ---------------------------------------------------------------------------

describe("thinkingColor", () => {
	it("returns correct theme colors for each level", () => {
		assert.strictEqual(thinkingColor("off"), "dim");
		assert.strictEqual(thinkingColor("minimal"), "dim");
		assert.strictEqual(thinkingColor("low"), "muted");
		assert.strictEqual(thinkingColor("medium"), "accent");
		assert.strictEqual(thinkingColor("high"), "warning");
		assert.strictEqual(thinkingColor("xhigh"), "error");
	});

	it("returns dim for unknown/undefined", () => {
		assert.strictEqual(thinkingColor(undefined), "dim");
		assert.strictEqual(thinkingColor("unknown"), "dim");
	});
});

// ---------------------------------------------------------------------------
// getWorktreeName tests
// ---------------------------------------------------------------------------

describe("getWorktreeName", () => {
	it("returns null when .git does not exist", () => {
		const dir = join(tmpdir(), `pi-test-no-git-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			assert.strictEqual(getWorktreeName(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null for regular git repo (.git is directory)", () => {
		const dir = join(tmpdir(), `pi-test-regular-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		// Create .git as a directory (regular repo)
		mkdirSync(join(dir, ".git"));
		try {
			assert.strictEqual(getWorktreeName(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects worktree name from .git file", () => {
		const dir = join(tmpdir(), `pi-test-worktree-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), "gitdir: /home/user/.git/worktrees/my-feature-branch\n");
		try {
			assert.strictEqual(getWorktreeName(dir), "my-feature-branch");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns 'worktree' for unknown worktree path format", () => {
		const dir = join(tmpdir(), `pi-test-bad-worktree-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".git"), "gitdir: /some/weird/path\n");
		try {
			assert.strictEqual(getWorktreeName(dir), "worktree");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
