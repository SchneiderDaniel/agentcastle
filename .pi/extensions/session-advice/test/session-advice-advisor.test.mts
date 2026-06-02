/**
 * Tests for session-advice/advisor.ts — detection rules + scoring
 *
 * Phase 1: Pure function tests for detection rules.
 * Uses synthetic SessionData to test each pattern.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-advice/test/session-advice-advisor.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	analyzeSession,
	renderAdviceToMarkdown,
} from "../advisor.ts";
import type { SessionData, SessionEntry } from "../advisor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(entries: SessionEntry[]): SessionData {
	return { sessionId: "test-session", entries };
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

/** Create a pair of tool_use + tool_result entries simulating a parsed JSONL. */
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

describe("analyzeSession → redundant-read", () => {
	it("flags same file read within 1-turn window", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), readEntry("/repo/src/app.ts", 1)]);
		const result = analyzeSession(data);
		const reads = result.entries.filter((e) => e.category === "redundant-read");
		assert.ok(reads.length >= 1, "should flag redundant read");
	});

	it("does NOT flag reads 3+ turns apart", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/app.ts", 3),
		]);
		const result = analyzeSession(data);
		const reads = result.entries.filter((e) => e.category === "redundant-read");
		assert.strictEqual(reads.length, 0, "3 turns apart should not flag");
	});

	it("does NOT flag different files read consecutively", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		const result = analyzeSession(data);
		const reads = result.entries.filter((e) => e.category === "redundant-read");
		assert.strictEqual(reads.length, 0);
	});
});

describe("analyzeSession → tool-mismatch", () => {
	it("flags bash with | grep as tool-mismatch", () => {
		const data = makeSession([bashEntry("cat file | grep foo", 0)]);
		const result = analyzeSession(data);
		const mm = result.entries.filter((e) => e.category === "tool-mismatch");
		assert.ok(mm.length >= 1, "bash|grep should be flagged");
	});

	it("flags bash with | rg as tool-mismatch", () => {
		const data = makeSession([bashEntry("cat file.txt | rg pattern", 0)]);
		const result = analyzeSession(data);
		const mm = result.entries.filter((e) => e.category === "tool-mismatch");
		assert.ok(mm.length >= 1, "bash|rg should be flagged");
	});

	it("does NOT flag bash for non-search commands", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const result = analyzeSession(data);
		const mm = result.entries.filter((e) => e.category === "tool-mismatch");
		assert.strictEqual(mm.length, 0);
	});
});

describe("analyzeSession → tool-coverage-gap", () => {
	it("flags when code files touched but structural_search never used", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			bashEntry("cat file | grep foo", 1),
		]);
		const result = analyzeSession(data);
		const gaps = result.entries.filter((e) => e.category === "tool-coverage-gap");
		assert.ok(gaps.length >= 1, "should flag coverage gap");
	});

	it("does NOT flag when structural_search is used", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), structuralSearchEntry(1)]);
		const result = analyzeSession(data);
		const gaps = result.entries.filter((e) => e.category === "tool-coverage-gap");
		assert.strictEqual(gaps.length, 0);
	});

	it("does NOT flag when no code files touched", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const result = analyzeSession(data);
		const gaps = result.entries.filter((e) => e.category === "tool-coverage-gap");
		assert.strictEqual(gaps.length, 0);
	});
});

describe("analyzeSession → error-not-actioned", () => {
	it("flags when same tool errors and retried 2+ times", () => {
		const data = makeSession([
			readToolError(0),
			readEntry("/repo/src/missing.ts", 1),
			readEntry("/repo/src/missing.ts", 2),
		]);
		const result = analyzeSession(data);
		const errs = result.entries.filter((e) => e.category === "error-not-actioned");
		assert.ok(errs.length >= 1, "should flag retries after error");
	});

	it("does NOT flag single error without retry", () => {
		const data = makeSession([readToolError(0)]);
		const result = analyzeSession(data);
		const errs = result.entries.filter((e) => e.category === "error-not-actioned");
		assert.strictEqual(errs.length, 0);
	});
});

describe("analyzeSession → scoring weights", () => {
	it("tool-mismatch contributes to score", () => {
		const data = makeSession([bashEntry("cat file | grep foo", 0)]);
		const result = analyzeSession(data);
		assert.ok(result.score > 0, "should produce non-zero score");
	});

	it("does NOT flag when no code files touched", () => {
		const data = makeSession([bashEntry("npm test", 0), bashEntry("node build.js", 1)]);
		const result = analyzeSession(data);
		const gaps = result.entries.filter((e) => e.category === "tool-coverage-gap");
		assert.strictEqual(gaps.length, 0);
	});
});

describe("analyzeSession → structural-search-underuse (new rule)", () => {
	it("flags when ≥3 code files read/edited but structural_search never used", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 0),
			readEntry("/repo/src/config.ts", 0),
		]);
		const result = analyzeSession(data);
		const underuse = result.entries.filter((e) => e.category === "structural-search-underuse");
		assert.ok(underuse.length >= 1, "should flag structural_search underuse with 3+ code files");
	});

	it("does NOT flag when <3 code files read/edited", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
		]);
		const result = analyzeSession(data);
		const underuse = result.entries.filter((e) => e.category === "structural-search-underuse");
		assert.strictEqual(underuse.length, 0, "2 files should not flag");
	});

	it("does NOT flag when structural_search IS used", () => {
		const data = makeSession([
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/utils.ts", 1),
			readEntry("/repo/src/config.ts", 2),
			structuralSearchEntry(3),
		]);
		const result = analyzeSession(data);
		const underuse = result.entries.filter((e) => e.category === "structural-search-underuse");
		assert.strictEqual(underuse.length, 0, "should not flag when structural_search used");
	});
});

describe("renderAdviceToMarkdown", () => {
	it("renders clean session as no issues", () => {
		const data = makeSession([bashEntry("npm test", 0), structuralSearchEntry(1)]);
		const result = analyzeSession(data);
		const md = renderAdviceToMarkdown(result);
		assert.ok(md.includes("No issues"), "clean session shows no issues");
	});

	it("renders issues with correct sections", () => {
		const data = makeSession([
			bashEntry("cat file | grep foo", 0),
			readEntry("/repo/src/app.ts", 0),
			readEntry("/repo/src/app.ts", 1),
		]);
		const result = analyzeSession(data);
		const md = renderAdviceToMarkdown(result);
		assert.ok(md.includes("Errors") || md.includes("Warnings"), "should have severity section");
		assert.ok(result.entries.length > 0, "should have entries");
	});

	it("includes session ID in output", () => {
		const data = makeSession([bashEntry("cat f | grep x", 0)]);
		const result = analyzeSession(data);
		const md = renderAdviceToMarkdown(result);
		assert.ok(md.includes("test-session"), "should include session ID");
	});
});

describe("analyzeSession → excessive-turns / high-error-rate", () => {
	it("does NOT fire excessive-turns for 8 actual tool calls (16 entries) — bug: was double-counting tool_result", () => {
		// 8 actual tool invocations produce 8 tool_use + 8 tool_result = 16 entries with toolName set
		// With the bug: toolCalls.length = 16 > 15 → false positive
		// After fix: toolCalls.length = 8 ≤ 15 → no warning
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 8; i++) {
			entries.push(...toolCallPair("read", i, { path: "/src/file.ts" }));
		}
		const data = makeSession(entries);
		const result = analyzeSession(data);
		const excessive = result.entries.filter((e) => e.category === "excessive-turns");
		assert.strictEqual(excessive.length, 0, "8 tool calls should not trigger excessive-turns");
	});

	it("fires excessive-turns for 16 actual tool calls with few files/tools", () => {
		// 16 actual tool invocations → 32 entries with toolName
		// Should detect excessive turns correctly
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 16; i++) {
			entries.push(...toolCallPair("read", i, { path: "/src/file.ts" }));
		}
		const data = makeSession(entries);
		const result = analyzeSession(data);
		const excessive = result.entries.filter((e) => e.category === "excessive-turns");
		assert.ok(excessive.length >= 1, "16 tool calls should trigger excessive-turns");
		// Detail should reference 16 tool calls, not 32
		const detail = excessive[0]?.detail ?? "";
		assert.ok(detail.startsWith("16"), "detail should say 16, not 32");
	});

	it("error rate correctly calculated with tool_use-only count", () => {
		// 8 actual tool invocations, 3 errors
		// With bug: 3/16 = 18.75% → below 25% threshold, doesn't fire
		// After fix: 3/8 = 37.5% → above 25% threshold, fires
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 5; i++) {
			entries.push(...toolCallPair("read", i, { path: "/src/file.ts" }));
		}
		// 3 errored calls
		entries.push(...toolCallPair("read", 5, { path: "/src/missing.ts" }, true));
		entries.push(...toolCallPair("bash", 6, { command: "bad" }, true));
		entries.push(...toolCallPair("read", 7, { path: "/src/nope.ts" }, true));

		const data = makeSession(entries);
		const result = analyzeSession(data);
		const highError = result.entries.filter((e) => e.category === "high-error-rate");
		assert.ok(highError.length >= 1, "3/8 errors (37.5%) should trigger high-error-rate");
		// Detail should reference 3/8, not 3/16
		const detail = highError[0]?.detail ?? "";
		assert.ok(detail.startsWith("3/8"), "detail should say 3/8 errors, not 3/16");
	});

	it("low error rate with many calls does NOT fire high-error-rate", () => {
		// 1 error out of 10 calls = 10% → below 25% threshold
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 9; i++) {
			entries.push(...toolCallPair("read", i, { path: "/src/file.ts" }));
		}
		entries.push(...toolCallPair("read", 9, { path: "/src/missing.ts" }, true));

		const data = makeSession(entries);
		const result = analyzeSession(data);
		const highError = result.entries.filter((e) => e.category === "high-error-rate");
		assert.strictEqual(highError.length, 0, "1/10 errors should not trigger high-error-rate");
	});

	it("low error rate with insufficient errors does NOT fire (need ≥2 errors)", () => {
		// 1 error out of 2 calls = 50% > 25% but errors.length=1 < 2
		const entries: SessionEntry[] = [];
		entries.push(...toolCallPair("read", 0, { path: "/src/file.ts" }));
		entries.push(...toolCallPair("read", 1, { path: "/src/missing.ts" }, true));

		const data = makeSession(entries);
		const result = analyzeSession(data);
		const highError = result.entries.filter((e) => e.category === "high-error-rate");
		assert.strictEqual(highError.length, 0, "single error should not trigger even with high rate");
	});

	it("detail message in excessive-turns uses accurate count, not doubled", () => {
		// 16 tool calls, 1 file changed, 1 tool used → should trigger
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 16; i++) {
			entries.push(...toolCallPair("read", i, { path: "/src/file.ts" }));
		}
		const data = makeSession(entries);
		const result = analyzeSession(data);
		const excessive = result.entries.filter((e) => e.category === "excessive-turns");
		assert.ok(excessive.length >= 1, "should trigger excessive-turns");
		// Detail must say "16 tool calls" not "32 tool calls"
		const detail = excessive[0]?.detail ?? "";
		assert.match(detail, /^16 tool calls/, "detail must show 16 tool calls, not 32");
		assert.doesNotMatch(
			detail,
			/^32 tool calls/,
			"detail must not double-count tool_result entries",
		);
	});
});
