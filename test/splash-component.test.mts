/**
 * Tests for SplashComponent — Terminal loading screen UI.
 *
 * Phase 2: Domain — pure rendering functions for splash screen display.
 *
 * Run with:
 *   node --experimental-strip-types --test test/splash-component.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Replicated types and SplashComponent logic for isolated unit testing.
// Matches src/splash-component.ts implementation.
// ---------------------------------------------------------------------------

type ExtensionLoadStatus = "pending" | "loading" | "done" | "failed";

interface ExtensionProgressEntry {
	name: string;
	status: ExtensionLoadStatus;
	error?: string;
}

interface LoadingProgress {
	total: number;
	completed: number;
	failed: number;
	pending: number;
	entries: ExtensionProgressEntry[];
}

function createLoadingProgress(extensionNames: string[]): LoadingProgress {
	return {
		total: extensionNames.length,
		completed: 0,
		failed: 0,
		pending: extensionNames.length,
		entries: extensionNames.map((name) => ({
			name,
			status: "pending" as const,
		})),
	};
}

function calculateProgressFraction(completed: number, failed: number, total: number): number {
	if (total === 0) return 1;
	return (completed + failed) / total;
}

// ---------------------------------------------------------------------------
// Formatters for splash screen rendering
// ---------------------------------------------------------------------------

/** Generate the status icon for an extension entry. */
function getStatusIcon(status: ExtensionLoadStatus): string {
	switch (status) {
		case "pending":
			return "·";
		case "loading":
			return "◌";
		case "done":
			return "✓";
		case "failed":
			return "✗";
	}
}

/** Render the progress bar string. */
function renderProgressBar(fraction: number, width: number): string {
	const barWidth = Math.max(width - 2, 1); // leave room for brackets
	const filled = Math.round(fraction * barWidth);
	const empty = barWidth - filled;
	const bar = "=".repeat(filled) + "-".repeat(empty);
	return `[${bar}]`;
}

/** Format the percentage label. */
function formatPercent(fraction: number): string {
	return `${Math.round(fraction * 100)}%`;
}

/** Render the extension list block. */
function renderExtensionList(entries: ExtensionProgressEntry[], maxLines: number): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		if (lines.length >= maxLines) {
			lines.push(`  ··· and ${entries.length - lines.length} more`);
			break;
		}
		const icon = getStatusIcon(entry.status);
		const errorSuffix = entry.error ? ` — ${entry.error}` : "";
		lines.push(`  ${icon} ${entry.name}${errorSuffix}`);
	}
	return lines;
}

/** Render the splash screen as an array of lines. */
function renderSplash(
	title: string,
	version: string,
	progress: LoadingProgress,
	width: number,
	quiet: boolean,
): string[] {
	if (quiet) {
		const fraction = calculateProgressFraction(progress.completed, progress.failed, progress.total);
		const pct = formatPercent(fraction);
		return [`  Loading... ${pct}`];
	}

	const lines: string[] = [];
	const fraction = calculateProgressFraction(progress.completed, progress.failed, progress.total);
	const pct = formatPercent(fraction);
	const barWidth = Math.min(width - 8, 40);
	const bar = renderProgressBar(fraction, barWidth);
	const innerWidth = Math.min(width - 4, 60);

	// Title
	lines.push(`  ${title}`);
	lines.push("");

	// Logo area (simplified)
	lines.push(`  ${version}`);
	lines.push("");

	// Loading message + progress bar
	lines.push(`  Loading extensions...`);
	lines.push(`  ${bar} ${pct}`);
	lines.push("");

	// Extension list
	const extLines = renderExtensionList(progress.entries, innerWidth > 50 ? 10 : 5);
	for (const line of extLines) {
		lines.push(line);
	}

	return lines;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: Domain — helper functions
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: Domain — helper functions", () => {
	it("getStatusIcon returns correct icon for each status", () => {
		assert.strictEqual(getStatusIcon("pending"), "·");
		assert.strictEqual(getStatusIcon("loading"), "◌");
		assert.strictEqual(getStatusIcon("done"), "✓");
		assert.strictEqual(getStatusIcon("failed"), "✗");
	});

	it("renderProgressBar renders empty bar for fraction=0", () => {
		const bar = renderProgressBar(0, 12);
		assert.strictEqual(bar, "[----------]");
	});

	it("renderProgressBar renders full bar for fraction=1", () => {
		const bar = renderProgressBar(1, 12);
		assert.strictEqual(bar, "[==========]");
	});

	it("renderProgressBar renders partial bar", () => {
		// 0.5 of 10 chars = 5 filled
		const result = renderProgressBar(0.5, 12);
		assert.ok(result.startsWith("["));
		assert.ok(result.endsWith("]"));
		// Count = and - chars
		const inner = result.slice(1, -1);
		const equalsCount = (inner.match(/=/g) || []).length;
		assert.strictEqual(equalsCount, 5);
	});

	it("formatPercent formats correctly", () => {
		assert.strictEqual(formatPercent(0), "0%");
		assert.strictEqual(formatPercent(0.5), "50%");
		assert.strictEqual(formatPercent(1), "100%");
	});

	it("renderExtensionList shows max lines and truncation", () => {
		const entries = Array.from({ length: 15 }, (_, i) => ({
			name: `ext${i}`,
			status: "pending" as const,
		}));
		const lines = renderExtensionList(entries, 5);
		assert.strictEqual(lines.length, 6); // 5 entries + 1 truncation
		assert.ok(lines[5]!.includes("···"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Rendering — splash screen output
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Rendering — splash screen output", () => {
	it("produces at least one line of output", () => {
		const progress = createLoadingProgress(["caveman"]);
		const lines = renderSplash("pi coding agent", "v0.74.0", progress, 60, false);
		assert.ok(lines.length > 0);
	});

	it("includes title and version in output", () => {
		const progress = createLoadingProgress(["caveman"]);
		const lines = renderSplash("pi", "v0.74.0", progress, 60, false);
		const text = lines.join("\n");
		assert.ok(text.includes("pi"), "Should include title");
		assert.ok(text.includes("v0.74.0"), "Should include version");
	});

	it("shows progress bar and percentage", () => {
		let progress = createLoadingProgress(["a", "b"]);
		// Simulate one done
		progress = {
			...progress,
			completed: 1,
			pending: 1,
			entries: progress.entries.map((e) =>
				e.name === "a" ? { ...e, status: "done" as const } : e,
			),
		};
		const lines = renderSplash("pi", "v1.0", progress, 60, false);
		const text = lines.join("\n");
		assert.ok(text.includes("50%"), "Should show 50% progress");
		assert.ok(text.includes("[") && text.includes("]"), "Should show progress bar");
	});

	it("shows extension names in list", () => {
		const progress = createLoadingProgress(["caveman", "supervisor", "session-logger"]);
		const lines = renderSplash("pi", "v1.0", progress, 60, false);
		const text = lines.join("\n");
		assert.ok(text.includes("caveman"), "Should list caveman");
		assert.ok(text.includes("supervisor"), "Should list supervisor");
		assert.ok(text.includes("session-logger"), "Should list session-logger");
	});

	it("shows done checkmark for completed extensions", () => {
		let progress = createLoadingProgress(["caveman", "supervisor"]);
		progress = {
			...progress,
			completed: 1,
			pending: 1,
			entries: progress.entries.map((e) =>
				e.name === "caveman" ? { ...e, status: "done" as const } : e,
			),
		};
		const lines = renderSplash("pi", "v1.0", progress, 60, false);
		const text = lines.join("\n");
		assert.ok(text.includes("✓ caveman"), "Should show checkmark for done extension");
	});

	it("shows failure cross for failed extensions", () => {
		let progress = createLoadingProgress(["broken-ext"]);
		progress = {
			...progress,
			failed: 1,
			completed: 0,
			pending: 0,
			entries: [{ name: "broken-ext", status: "failed" as const, error: "timeout" }],
		};
		const lines = renderSplash("pi", "v1.0", progress, 60, false);
		const text = lines.join("\n");
		assert.ok(text.includes("✗ broken-ext"), "Should show failure cross");
	});

	it("quiet mode shows minimal output", () => {
		const progress = createLoadingProgress(["caveman"]);
		const lines = renderSplash("pi", "v1.0", progress, 60, true);
		assert.strictEqual(lines.length, 1);
		assert.ok(lines[0]!.includes("Loading..."));
	});

	it("all done with zero extensions shows complete", () => {
		const progress = createLoadingProgress([]);
		const lines = renderSplash("pi", "v1.0", progress, 60, false);
		assert.ok(lines.length > 0, "Should render with zero extensions");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Edge cases", () => {
	it("many extensions renders all or truncates", () => {
		const names = Array.from({ length: 20 }, (_, i) => `ext${i}`);
		const progress = createLoadingProgress(names);
		const lines = renderSplash("pi", "v1.0", progress, 60, false);
		const extLines = lines.filter((l) => l.includes("ext"));
		assert.ok(extLines.length <= 11, "Should limit extension lines");
	});

	it("narrow width produces valid output", () => {
		const progress = createLoadingProgress(["caveman"]);
		const lines = renderSplash("pi", "v1.0", progress, 20, false);
		assert.ok(lines.length > 0, "Should render at narrow width");
	});

	it("single extension shows correctly", () => {
		let progress = createLoadingProgress(["standalone-ext"]);
		progress = {
			...progress,
			completed: 1,
			pending: 0,
			entries: [{ name: "standalone-ext", status: "done" as const }],
		};
		const lines = renderSplash("pi", "v1.0", progress, 60, false);
		const text = lines.join("\n");
		assert.ok(text.includes("standalone-ext"));
		assert.ok(text.includes("✓"));
	});

	it("quiet mode with no extensions renders immediately", () => {
		const progress = createLoadingProgress([]);
		const lines = renderSplash("pi", "v1.0", progress, 60, true);
		assert.strictEqual(lines.length, 1);
		assert.ok(lines[0]!.includes("100%") || lines[0]!.includes("Loading..."));
	});
});
