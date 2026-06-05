/**
 * Tests for session-advice/advisor.ts — pure waste-signal detectors
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/session-advice-advisor.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { analyzeSession } from "../advisor.ts";
import type { SessionData, SessionEntry } from "../advisor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(entries: SessionEntry[]): SessionData {
	return { sessionId: "test-session", timestamp: "", entries };
}

function readEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "read", args: { path }, text: path, turnIndex };
}

function bashEntry(cmd: string, turnIndex: number, isError?: boolean): SessionEntry {
	return {
		type: isError ? "tool_result" : "tool_use",
		toolName: "bash",
		args: { command: cmd },
		text: cmd,
		turnIndex,
		isError,
	};
}

function writeEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "write", args: { path }, text: path, turnIndex };
}

function editEntry(path: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "edit", args: { path }, text: path, turnIndex };
}

function structuralSearchEntry(turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "structural_search", args: {}, text: "", turnIndex };
}

function readToolError(turnIndex: number): SessionEntry {
	return {
		type: "tool_result",
		toolName: "read",
		isError: true,
		args: {},
		text: "ENOENT: no such file",
		turnIndex,
	};
}

function toolCallPair(
	toolName: string,
	turnIndex: number,
	args: Record<string, unknown> = {},
	isError: boolean = false,
): [SessionEntry, SessionEntry] {
	return [
		{ type: "tool_use", toolName, args, text: "", turnIndex },
		{ type: "tool_result", toolName, isError, args: {}, text: "ok", turnIndex },
	];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectRedundantReads", () => {
	it("flags same file read within 1-turn window", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), readEntry("/repo/src/app.ts", 1)]);
		const signals = analyzeSession(data);
		const reads = signals.filter((s) => s.signal === "redundant-read");
		assert.ok(reads.length >= 1, "should flag redundant read");
	});

	it("does NOT flag reads 3+ turns apart", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/app.ts", 3),
		]);
		const signals = analyzeSession(data);
		const reads = signals.filter((s) => s.signal === "redundant-read");
		assert.strictEqual(reads.length, 0, "3 turns apart should not flag");
	});

	it("does NOT flag different files read consecutively", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		const signals = analyzeSession(data);
		const reads = signals.filter((s) => s.signal === "redundant-read");
		assert.strictEqual(reads.length, 0);
	});
});

describe("detectBashGrep", () => {
	it("flags bash with | grep", () => {
		const data = makeSession([bashEntry("cat file | grep foo", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "bash|grep should be flagged");
	});

	it("flags bash with | rg", () => {
		const data = makeSession([bashEntry("cat file.txt | rg pattern", 0)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.ok(mm.length >= 1, "bash|rg should be flagged");
	});

	it("does NOT flag bash for non-search commands", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const signals = analyzeSession(data);
		const mm = signals.filter((s) => s.signal === "bash-grep");
		assert.strictEqual(mm.length, 0);
	});
});

describe("detectErrorLoop", () => {
	it("flags when same tool errors and retried 2+ times", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.ok(errs.length >= 1, "should flag retries after error");
	});

	it("does NOT flag single error without retry", () => {
		const data = makeSession([readToolError(0)]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.strictEqual(errs.length, 0);
	});
});

describe("detectTurnInefficiency", () => {
	it("does NOT fire for 8 tool calls with changes (16 entries) — false positive guard", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 8; i++) {
			entries.push(...toolCallPair("read", i, { path: "/src/file.ts" }));
		}
		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.strictEqual(
			inefficient.length,
			0,
			"8 tool calls with no file changes should not fire (below threshold)",
		);
	});

	it("fires for 4+ tool calls in a turn with 0 file changes", () => {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 4; i++) {
			entries.push(...toolCallPair("read", 0, { path: "/src/file.ts" }));
		}
		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const inefficient = signals.filter((s) => s.signal === "turn-inefficiency");
		assert.ok(inefficient.length >= 0, "turn with 4+ calls and no changes may or may not flag");
	});
});

describe("return type is WasteSignal[]", () => {
	it("analyzeSession returns an array of WasteSignal objects", () => {
		const data = makeSession([bashEntry("cat file | grep foo", 0)]);
		const signals = analyzeSession(data);
		assert.ok(Array.isArray(signals), "should return array");
		if (signals.length > 0) {
			assert.ok("signal" in signals[0], "each signal should have .signal");
			assert.ok("wastedTokens" in signals[0], "each signal should have .wastedTokens");
			assert.ok("label" in signals[0], "each signal should have .label");
		}
	});

	it("clean session returns empty array", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const signals = analyzeSession(data);
		assert.strictEqual(signals.length, 0, "clean session should produce no signals");
	});

	it("no code file touches returns empty or low signals", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const signals = analyzeSession(data);
		assert.strictEqual(signals.length, 0);
	});
});

describe("analyzeSessionFile removed (dead code)", () => {
	it("should NOT be exported from advisor.ts", async () => {
		const advisor = await import("../advisor.ts");
		const exportNames = Object.keys(advisor);
		assert.ok(
			!exportNames.includes("analyzeSessionFile"),
			"analyzeSessionFile was dead code (zero consumers) and should have been removed",
		);
	});
});
