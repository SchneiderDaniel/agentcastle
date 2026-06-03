/**
 * Tests for subagent status formatting and footer pipe separator.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/subagent-status.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	buildSubagentStatusLine,
	joinExtensionStatuses,
	formatDuration,
	formatTokens,
} from "../config/formatting.ts";

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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
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
			undefined,
			mockTheme,
		);
		assert.ok(!result.includes("<warning>"));
	});

	it("threshold boundary: token coloring removed from subagent line", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			90_000,
			5,
			true,
			100_000,
			now,
			undefined,
			mockTheme,
		);
		assert.ok(!result.includes("<warning>"));
		assert.ok(!result.includes("<error>"));
	});

	it("threshold boundary: token coloring removed from subagent line", () => {
		const result = buildSubagentStatusLine(
			"developer",
			startedAt,
			90_001,
			5,
			true,
			100_000,
			now,
			undefined,
			mockTheme,
		);
		assert.ok(!result.includes("<error>"));
		assert.ok(!result.includes("<warning>"));
	});

	it("no theme: no crash, no color", () => {
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
			undefined,
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
			undefined,
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
			undefined,
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

// ---------------------------------------------------------------------------
// Tests — formatTokens and formatDuration re-exports work
// ---------------------------------------------------------------------------

describe("formatting.ts re-exports", () => {
	it("formatTokens exports from formatting.ts", () => {
		assert.strictEqual(formatTokens(500), "500");
		assert.strictEqual(formatTokens(1500), "1.5K");
		assert.strictEqual(formatTokens(1_500_000), "1.5M");
	});

	it("formatDuration exports from formatting.ts", () => {
		assert.strictEqual(formatDuration(500), "500ms");
		assert.strictEqual(formatDuration(1500), "2s");
		assert.strictEqual(formatDuration(120_000), "2m 0s");
	});
});
