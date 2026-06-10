/**
 * Tests for context-info welcome banner session status line
 *
 * Verifies showWelcomeBanner renders the correct session status line
 * between castle art and stat lines, with proper styling.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/welcome.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Mock theme — returns text unchanged for easy string matching
// ---------------------------------------------------------------------------

interface MockWidget {
	render: (width: number) => string[];
	invalidate: () => void;
	dispose: () => void;
}

interface MockTheme {
	fg: (style: string, text: string) => string;
}

const noopTheme: MockTheme = {
	fg: (_style: string, text: string) => text,
};

// ---------------------------------------------------------------------------
// Mock ExtensionContext — captures widget factory for rendering
// ---------------------------------------------------------------------------

let capturedWidget: MockWidget | undefined;

function createMockCtx(): any {
	capturedWidget = undefined;
	return {
		ui: {
			setWidget: (_id: string, factory: (tui: any, theme: MockTheme) => MockWidget) => {
				capturedWidget = factory(null, noopTheme);
			},
			setFooter: () => {},
			setStatus: () => {},
			setWorkingIndicator: () => {},
			getTheme: () => noopTheme,
		},
		sessionManager: {},
	};
}

// ---------------------------------------------------------------------------
// Import the function under test
// ---------------------------------------------------------------------------

import { showWelcomeBanner } from "../welcome.js";

// ---------------------------------------------------------------------------
// Helper: extract the session status line from rendered output
// ---------------------------------------------------------------------------

function findSessionLine(lines: string[]): string | undefined {
	return lines.find((l) => l.includes("Session:"));
}

function findStatLines(lines: string[]): string[] {
	const statStart = lines.findIndex((l) => l.includes("🧩 Extensions:"));
	if (statStart < 0) return [];
	const bottomIdx = lines.findIndex((l) => l.startsWith("|_") && l.endsWith("_|"));
	const endIdx = bottomIdx >= 0 ? bottomIdx : lines.length;
	return lines.slice(statStart, endIdx);
}

// ---------------------------------------------------------------------------
// Phase 3 tests: Session status line rendering
// ---------------------------------------------------------------------------

describe("Welcome banner — session status line", () => {
	it("Both ON (logger=true, advice=true) → line contains 🟢 Logger  🟢 Advice", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, true);

		assert.ok(capturedWidget, "widget should be set");
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		assert.ok(sessionLine!.includes("🟢"), "should show green for logger");
		assert.ok(sessionLine!.includes("Logger"), "should include Logger label");
		assert.ok(sessionLine!.includes("Advice"), "should include Advice label");
		// Count 🟢 occurrences (two 🟢 = both ON)
		const greenCount = (sessionLine!.match(/🟢/g) || []).length;
		assert.strictEqual(greenCount, 2, "both extensions should show green");
	});

	it("Logger OFF, Advice ON → line contains 🔴 Logger  🟢 Advice", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, false, true);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		assert.ok(sessionLine!.includes("🔴 Logger"), "logger should show red");
		assert.ok(sessionLine!.includes("🟢 Advice"), "advice should show green");
	});

	it("Logger ON, Advice OFF → line contains 🟢 Logger  🔴 Advice", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, false);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		assert.ok(sessionLine!.includes("🟢 Logger"), "logger should show green");
		assert.ok(sessionLine!.includes("🔴 Advice"), "advice should show red");
	});

	it("Both OFF → line contains 🔴 Logger  🔴 Advice", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, false, false);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		const redCount = (sessionLine!.match(/🔴/g) || []).length;
		assert.strictEqual(redCount, 2, "both extensions should show red");
	});

	it("Logger null (unavailable), Advice ON → ❓ Logger  🟢 Advice", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, null, true);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		assert.ok(sessionLine!.includes("❓ Logger"), "unavailable logger should show ❓");
		assert.ok(sessionLine!.includes("🟢 Advice"), "advice should show green");
	});

	it("Advice null, Logger ON → 🟢 Logger  ❓ Advice", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, null);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		assert.ok(sessionLine!.includes("🟢 Logger"), "logger should show green");
		assert.ok(sessionLine!.includes("❓ Advice"), "unavailable advice should show ❓");
	});

	it("Both null → ❓ Logger  ❓ Advice", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, null, null);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		const qCount = (sessionLine!.match(/❓/g) || []).length;
		assert.strictEqual(qCount, 2, "both extensions should show ❓");
	});

	it("Status line is always present (even when both are ON — default state)", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, true);
	});

	it("Line appears after castle art, before 🧩 Extensions stat line", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, true);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);

		// Find positions
		const castleEndIdx = lines.findIndex((l) =>
			l.includes("______[____]________________[____]________________[____]______|"),
		);
		const sessionIdx = lines.findIndex((l) => l.includes("Session:"));
		const extensionsIdx = lines.findIndex((l) => l.includes("🧩 Extensions:"));

		assert.ok(castleEndIdx >= 0, "castle art should be present");
		assert.ok(sessionIdx >= 0, "session line should be present");
		assert.ok(extensionsIdx >= 0, "extensions line should be present");
		assert.ok(sessionIdx > castleEndIdx, "session line should be after castle art");
		assert.ok(extensionsIdx > sessionIdx, "extensions line should be after session line");
	});
});

describe("Welcome banner — session status line styling", () => {
	it("Line uses | ... | bordered format (same as stat lines)", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, true);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");

		// Should start with "| " and end with " |"
		assert.ok(sessionLine!.startsWith("| "), "should start with '| '");
		assert.ok(sessionLine!.endsWith(" |"), "should end with ' |'");
	});

	it('Line uses dimmed "Session:" prefix', () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, true);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		// With noop theme, "Session:" appears as-is
		assert.ok(sessionLine!.includes("Session:"), "should include Session: prefix");
	});

	it("Line is exactly 64 characters wide", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		showWelcomeBanner(ctx, startupWidgetActive, 0, true, true);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		assert.strictEqual(visibleWidth(sessionLine!), 64, "line should be exactly 64 chars wide");
	});

	it("Empty params (undefined) render as ❓ for both extensions", () => {
		const ctx = createMockCtx();
		const startupWidgetActive = { value: false };

		// No loggerState/adviceState params → undefined → should show ❓
		showWelcomeBanner(ctx, startupWidgetActive, 0);

		assert.ok(capturedWidget);
		const lines = capturedWidget!.render(64);
		const sessionLine = findSessionLine(lines);
		assert.ok(sessionLine, "session status line should be present");
		assert.ok(sessionLine!.includes("❓ Logger"), "undefined logger should show ❓");
		assert.ok(sessionLine!.includes("❓ Advice"), "undefined advice should show ❓");
	});
});
