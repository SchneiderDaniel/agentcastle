/**
 * Tests for subagent status formatting and footer pipe separator.
 *
 * Run with:
 *   node --experimental-strip-types --test test/subagent-status.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Pure function: buildSubagentStatusLine
// Extracted from agent-runner.ts flushWidget() for unit testing.
// Returns the status string passed to ctx.ui.setStatus("supervisor", ...).
// ---------------------------------------------------------------------------

function buildSubagentStatusLine(
	agentName: string,
	startedAt: number,
	tokenCount: number,
	toolCount: number,
	contextInfoReceived: boolean,
	contextWindow: number | undefined,
	now: number,
	theme?: { fg: (color: string, text: string) => string },
): string {
	const parts: string[] = [];
	const durationMs = now - startedAt;
	parts.push(`⏱ ${formatDuration(durationMs)}`);

	if (tokenCount > 0) {
		let tokenStr = `${formatTokens(tokenCount)} tokens`;
		// Color token count based on context window usage
		if (contextInfoReceived && contextWindow !== undefined && contextWindow > 0) {
			const pct = (tokenCount / contextWindow) * 100;
			if (pct > 90 && theme) {
				tokenStr = `${theme.fg("error", formatTokens(tokenCount))} tokens`;
			} else if (pct > 70 && theme) {
				tokenStr = `${theme.fg("warning", formatTokens(tokenCount))} tokens`;
			} else {
				tokenStr = `${formatTokens(tokenCount)} tokens`;
			}
		}
		parts.push(`📊 ${tokenStr}`);
	}

	if (toolCount > 0) parts.push(`🔧 ${toolCount} tools`);

	return `subagent: ${agentName}  ${parts.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// Pure function: joinExtensionStatuses
// Simulates footer.js sortedStatuses.join("|") change.
// ---------------------------------------------------------------------------

function joinExtensionStatuses(statuses: string[]): string {
	return statuses.join(" | ");
}

// ---------------------------------------------------------------------------
// formatDuration / formatTokens duplicates (from formatting.ts)
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const sec = Math.round(ms / 1_000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remainSec = sec % 60;
	return `${min}m ${remainSec}s`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

// ---------------------------------------------------------------------------
// Mock theme for testing color thresholds
// ---------------------------------------------------------------------------

class MockTheme {
	fg(color: string, text: string): string {
		return `<${color}>${text}</${color}>`;
	}
}

// ---------------------------------------------------------------------------
// Tests — Pipe separator join (R1)
// ---------------------------------------------------------------------------

describe("R1: Pipe separator between extension statuses", () => {
	it("AC1: joins multiple statuses with ' | '", () => {
		const result = joinExtensionStatuses(["caveman: LITE", "subagent: developer"]);
		assert.strictEqual(result, "caveman: LITE | subagent: developer");
	});

	it("AC2a: single status has no pipe", () => {
		const result = joinExtensionStatuses(["caveman: LITE"]);
		assert.strictEqual(result, "caveman: LITE");
	});

	it("AC2b: empty array returns empty string (no leading/trailing pipe)", () => {
		const result = joinExtensionStatuses([]);
		assert.strictEqual(result, "");
	});

	it("AC2c: no leading or trailing pipe with 2+ entries", () => {
		const result = joinExtensionStatuses(["a", "b", "c"]);
		assert.strictEqual(result, "a | b | c");
		assert.ok(!result.startsWith(" | "));
		assert.ok(!result.endsWith(" | "));
	});

	it("AC3: inner status formatting preserved (no stripping of internal spaces)", () => {
		// Statuses may contain internal spaces like "caveman: LITE" or "subagent: developer  ⏱ 4m23s ..."
		const result = joinExtensionStatuses(["caveman: LITE", "subagent: dev"]);
		assert.ok(result.includes("caveman: LITE"));
		assert.ok(result.includes("subagent: dev"));
		assert.strictEqual(result, "caveman: LITE | subagent: dev");
	});

	it("three statuses all separated by pipe", () => {
		const result = joinExtensionStatuses(["a", "b", "c"]);
		assert.strictEqual(result, "a | b | c");
	});

	it("only pipe separator changed — no other formatting changes", () => {
		const result = joinExtensionStatuses(["caveman: LITE"]);
		// Should not add any extra padding beyond what was already there
		assert.strictEqual(result, "caveman: LITE");
	});
});

// ---------------------------------------------------------------------------
// Tests — Subagent label and token color (R2)
// ---------------------------------------------------------------------------

describe("R2: Subagent 'subagent:' label prefix", () => {
	const now = 100_000;
	const startedAt = 50_000; // 50s ago

	it("AC1: status starts with 'subagent: <agent_name>'", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			1000,
			5,
			false,
			undefined,
			now,
			new MockTheme(),
		);
		assert.ok(result.startsWith("subagent: developer"));
	});

	it("includes duration, token count, and tool count", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			1000,
			5,
			false,
			undefined,
			now,
			new MockTheme(),
		);
		assert.ok(result.includes("⏱"));
		assert.ok(result.includes("📊"));
		assert.ok(result.includes("🔧"));
	});

	it("no token display when tokenCount is 0", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			0,
			5,
			false,
			undefined,
			now,
			new MockTheme(),
		);
		assert.ok(!result.includes("📊"));
	});

	it("no tool display when toolCount is 0", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			1000,
			0,
			false,
			undefined,
			now,
			new MockTheme(),
		);
		assert.ok(!result.includes("🔧"));
	});
});

describe("R2: Token count coloring by context window %", () => {
	const now = 100_000;
	const startedAt = 50_000;
	const mockTheme = new MockTheme();

	it("AC3: no color when context_info not yet received (contextInfoReceived=false)", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			50000,
			5,
			false,
			100_000,
			now,
			mockTheme,
		);
		// Should not contain any theme color wrapping
		assert.ok(!result.includes("<error>"));
		assert.ok(!result.includes("<warning>"));
		assert.ok(result.includes("📊 50.0K tokens"));
	});

	it("AC3: no color when contextWindow is undefined", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			50000,
			5,
			true,
			undefined,
			now,
			mockTheme,
		);
		assert.ok(!result.includes("<error>"));
		assert.ok(!result.includes("<warning>"));
	});

	it("AC2: >90% uses error color (red)", () => {
		// 95K tokens out of 100K context window = 95% -> red
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			95_000,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		assert.ok(result.includes("<error>"));
		assert.ok(!result.includes("<warning>"));
	});

	it("AC2: >70% and <=90% uses warning color (yellow)", () => {
		// 75K tokens out of 100K context window = 75% -> yellow
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			75_000,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		assert.ok(result.includes("<warning>"));
		assert.ok(!result.includes("<error>"));
	});

	it("AC2: <=70% uses normal (no color)", () => {
		// 50K tokens out of 100K context window = 50% -> no color
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			50_000,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		assert.ok(!result.includes("<error>"));
		assert.ok(!result.includes("<warning>"));
	});

	it("threshold boundary: exactly 70% is not warning (<=70% is normal)", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			70_000,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		assert.ok(!result.includes("<warning>"));
	});

	it("threshold boundary: exactly 90% is not error (<=90% is warning)", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			90_000,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		assert.ok(result.includes("<warning>"));
		assert.ok(!result.includes("<error>"));
	});

	it("threshold boundary: just over 90% is error", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			90_001,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		assert.ok(result.includes("<error>"));
	});

	it("coloring works with no theme provided (no crash, no color)", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			95_000,
			5,
			true,
			100_000,
			now,
			undefined,
		);
		assert.ok(!result.includes("<error>"));
		assert.ok(!result.includes("<warning>"));
	});

	it("AC4: status prefix still 'subagent:' when context info available", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			95_000,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		assert.ok(result.startsWith("subagent: developer"));
	});
});

// ---------------------------------------------------------------------------
// Tests — Integration scenario (combined behavior)
// ---------------------------------------------------------------------------

describe("Integration: combined footer line construction", () => {
	const now = 100_000;
	const startedAt = 50_000;
	const mockTheme = new MockTheme();

	it("caveman + subagent statuses joined with pipe", () => {
		const cavemanStatus = "caveman: LITE";
		const subagentStatus = buildSubagentStatusLine(
			"developer",
			startedAt,
			50_000,
			5,
			true,
			100_000,
			now,
			mockTheme,
		);
		const footerLine = joinExtensionStatuses([cavemanStatus, subagentStatus]);
		assert.strictEqual(footerLine, `${cavemanStatus} | ${subagentStatus}`);
	});

	it("only subagent status (no caveman) → no leading pipe", () => {
		const status = buildSubagentStatusLine(
			"developer",
			startedAt,
			5000,
			3,
			false,
			undefined,
			now,
			mockTheme,
		);
		const footerLine = joinExtensionStatuses([status]);
		assert.strictEqual(footerLine, status);
		assert.ok(!footerLine.startsWith(" | "));
		assert.ok(!footerLine.endsWith(" | "));
	});

	it("three extensions all separated by pipe", () => {
		const result = joinExtensionStatuses(["a", "b", "c"]);
		assert.strictEqual(result, "a | b | c");
	});
});
