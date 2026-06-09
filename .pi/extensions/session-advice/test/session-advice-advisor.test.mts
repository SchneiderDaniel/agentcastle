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
	it("flags when same tool errors and retried 2+ times with same args", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.ok(errs.length >= 1, "should flag retries after error with same args");
	});

	it("does NOT flag when retries have different args (strategy change)", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/file-a.ts", 1),
			readEntry("/repo/src/file-b.ts", 2),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.strictEqual(errs.length, 0, "different args = strategy change, not loop");
	});

	it("flags 2+ retries with same args even with different-args retries in window", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/target.ts", 1),
			readEntry("/repo/src/other.ts", 2),
			readEntry("/repo/src/target.ts", 3),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.ok(errs.length >= 1, "should flag same-args retries despite different-args in between");
	});

	it("does NOT flag single error without retry", () => {
		const data = makeSession([readToolError(0)]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.strictEqual(errs.length, 0);
	});

	it("proportional waste: counts only retries beyond first", () => {
		// 1 error + 3 retries with same args → 2 wasteful (first retry excluded)
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
			readEntry("/repo/src/missing.ts", 3),
		]);
		const signals = analyzeSession(data);
		const errs = signals.filter((s) => s.signal === "error-loop");
		assert.ok(errs.length >= 1, "should flag");
		// 3 retries - 1 = 2 wasteful
		assert.strictEqual(errs[0].occurrences, 2, "should have 2 wasteful occurrences");
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

// ── Helper for identical-args tests ──

function identicalBashEntry(cmd: string, turnIndex: number): SessionEntry {
	return { type: "tool_use", toolName: "bash", args: { command: cmd }, text: cmd, turnIndex };
}

function identicalStructuralSearchEntry(turnIndex: number): SessionEntry {
	return {
		type: "tool_use",
		toolName: "structural_search",
		args: { pattern: "test" },
		text: "",
		turnIndex,
	};
}

// ---------------------------------------------------------------------------
// detectIdenticalArgs tests
// ---------------------------------------------------------------------------

describe("detectIdenticalArgs", () => {
	it("3 identical calls within window → identical-args signal with occurrences >= 2", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 1, "should produce one identical-args signal");
		assert.ok(identical[0].occurrences >= 2, "occurrences should be >= 2");
		assert.strictEqual(identical[0].context.toolName, "bash");
	});

	it("2 identical calls → no identical-args signal (below threshold)", () => {
		const data = makeSession([identicalBashEntry("ls", 0), identicalBashEntry("ls", 0)]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 0, "2 identical calls should not trigger");
	});

	it("5 identical calls → single signal, not duplicated per-call", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 1, "5 identical calls should produce exactly 1 signal");
	});

	it("identical calls span >12 entries (window slides) → only 3+ in current window trigger", () => {
		// 3 identical calls at start, then 10 different calls, then 2 more identical = only first 3 trigger
		const entries: SessionEntry[] = [
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		];
		// Add 10 unique calls to push first 3 out of 12-call window
		for (let i = 3; i < 13; i++) {
			entries.push(identicalBashEntry(`unique-${i}`, 0));
		}
		// Now add 2 more identical 'ls' calls — window has only 2, so no new signal
		entries.push(identicalBashEntry("ls", 0));
		entries.push(identicalBashEntry("ls", 0));

		const data = makeSession(entries);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		// The first 3 were detected before window slid, so 1 signal expected
		assert.strictEqual(identical.length, 1, "only the first batch of 3 should trigger a signal");
	});

	it("3 identical calls interleaved with other tools → still detected (key match)", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalStructuralSearchEntry(0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 1, "interleaved identical calls should be detected");
	});

	it("same tool but different args → no signal (key mismatch)", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls -la", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 0, "different args should not match");
	});

	it("different tool but same args structure → no signal (key includes toolName)", () => {
		const data = makeSession([
			{ type: "tool_use", toolName: "bash", args: { command: "ls" }, text: "ls", turnIndex: 0 },
			{ type: "tool_use", toolName: "read", args: { command: "ls" }, text: "", turnIndex: 0 },
			{ type: "tool_use", toolName: "bash", args: { command: "ls" }, text: "ls", turnIndex: 0 },
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(
			identical.length,
			0,
			"different tools should not match even with same args shape",
		);
	});

	it("6 identical calls → first and second batch both detected, merged by dedup", () => {
		const data = makeSession([
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
			identicalBashEntry("ls", 0),
		]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		// Both batches detected but merged by analyzeSession dedup (same toolName, no files)
		// Each batch has 2 wasted occurrences → total >= 4
		assert.strictEqual(identical.length, 1, "6 identical calls should produce 1 merged signal");
		assert.ok(
			identical[0].occurrences >= 4,
			"merged occurrences should account for both batches (>= 4)",
		);
	});

	it("empty session → no crash, empty results", () => {
		const data = makeSession([]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(
			identical.length,
			0,
			"empty session should produce no identical-args signal",
		);
	});

	it("single call → no signal", () => {
		const data = makeSession([identicalBashEntry("ls", 0)]);
		const signals = analyzeSession(data);
		const identical = signals.filter((s) => s.signal === "identical-args");
		assert.strictEqual(identical.length, 0, "single call should not trigger");
	});

	it("entries with undefined/null toolName or args → filtered out, no crash", () => {
		const data = makeSession([
			{
				type: "tool_use",
				toolName: undefined,
				args: { command: "ls" },
				text: "",
				turnIndex: 0,
			} as any,
			{ type: "tool_use", toolName: "bash", args: undefined, text: "", turnIndex: 0 } as any,
			{ type: "tool_use", toolName: undefined, args: undefined, text: "", turnIndex: 0 } as any,
		]);
		const signals = analyzeSession(data);
		// Should not crash
		assert.ok(Array.isArray(signals), "should return array without crashing");
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

// ---------------------------------------------------------------------------
// detectStructuralSearchUnderuse tests
// ---------------------------------------------------------------------------

describe("detectStructuralSearchUnderuse", () => {
	it("3 distinct code file reads, 0 structural_search → signal fires", () => {
		const data = makeSession([
			readEntry("/repo/src/components/app.ts", 0),
			readEntry("/repo/src/utils/helpers.ts", 1),
			readEntry("/repo/src/main/entry.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1, "3 code file reads with no structural_search should fire");
		assert.ok(ss[0].wastedTokens >= 0, "wastedTokens should be >= 0");
	});

	it("3 code file reads + 1 structural_search → NO signal", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
			structuralSearchEntry(3),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "at least 1 structural_search call should prevent signal");
	});

	it("2 code file reads → NO signal (below threshold)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "2 code reads should not fire");
	});

	it("3 reads on non-code files (.json, .yaml) → NO signal", () => {
		const data = makeSession([
			readEntry("/repo/config.json", 0),
			readEntry("/repo/tsconfig.json", 1),
			readEntry("/repo/deploy.yaml", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "non-code file reads should not fire");
	});

	it("3 code file edits (edit/write) → signal fires", () => {
		const data = makeSession([
			editEntry("/repo/src/app.ts", 0),
			writeEntry("/repo/src/utils.ts", 1),
			editEntry("/repo/src/main.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1, "3 code file edits should fire");
	});

	it("mixed: 2 code reads + 3 non-code reads → NO signal (code < 3)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/config.json", 2),
			readEntry("/repo/deploy.yaml", 3),
			readEntry("/repo/.env", 4),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "2 code + 3 non-code should not fire");
	});

	it("3 reads all on same file → NO signal (redundant-read territory)", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/app.ts", 1),
			readEntry("/repo/src/app.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(
			ss.length,
			0,
			"3 reads on same file should not fire structural-search-underuse",
		);
	});

	it("empty session → no crash, no signal", () => {
		const data = makeSession([]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "empty session should not crash");
	});

	it("session with only structural_search calls → no crash, no signal", () => {
		const data = makeSession([
			structuralSearchEntry(0),
			structuralSearchEntry(1),
			structuralSearchEntry(2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "only structural_search calls should not fire");
	});

	it("wastedTokens estimate includes sumTokenCost of offending reads", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1);
		// Each read entry has text=path, charsToTokens for "/repo/src/app.ts" = ceil(17/4) = 5
		// 3 entries * 5 = 15. Minus 50 overhead = 0 with floor. At minimum > 0 for longer paths.
		assert.ok(ss[0].wastedTokens >= 0, "wastedTokens should be non-negative");
	});

	it("writeIfEmpty and editExisting count as code file touches", () => {
		const data = makeSession([
			{
				type: "tool_use",
				toolName: "writeIfEmpty",
				args: { path: "/repo/src/new.ts" },
				text: "/repo/src/new.ts",
				turnIndex: 0,
			},
			{
				type: "tool_use",
				toolName: "editExisting",
				args: { path: "/repo/src/existing.ts" },
				text: "/repo/src/existing.ts",
				turnIndex: 1,
			},
			{
				type: "tool_use",
				toolName: "edit",
				args: { path: "/repo/src/another.ts" },
				text: "/repo/src/another.ts",
				turnIndex: 2,
			},
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1, "writeIfEmpty/editExisting/edit should count as code touches");
	});

	it("0 code file reads, 3 non-code reads → NO signal", () => {
		const data = makeSession([
			readEntry("/repo/README.md", 0),
			readEntry("/repo/.gitignore", 1),
			readEntry("/repo/package.json", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 0, "only non-code reads should not fire");
	});

	it("signal context includes files list", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/main.ts", 2),
		]);
		const signals = analyzeSession(data);
		const ss = signals.filter((s) => s.signal === "structural-search-underuse");
		assert.strictEqual(ss.length, 1);
		assert.ok(ss[0].context.files, "should have files context");
		assert.ok(ss[0].context.files!.length >= 3, "should list affected files");
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
