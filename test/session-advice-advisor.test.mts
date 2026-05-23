/**
 * Tests for session-advice/advisor.ts — detection rules + scoring
 *
 * Phase 1: Pure function tests for detection rules.
 * Uses synthetic SessionData to test each pattern.
 *
 * Run with:
 *   node --experimental-strip-types --test test/session-advice-advisor.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	analyzeSession,
	renderAdviceToMarkdown,
} from "../.pi/extensions/session-advice/advisor.ts";
import type { SessionData, SessionEntry } from "../.pi/extensions/session-advice/advisor.ts";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("analyzeSession → immediate-redundant-read", () => {
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

describe("analyzeSession → immediate-redundant-read (new rule)", () => {
	it("flags same file read within 1 turn", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), readEntry("/repo/src/app.ts", 1)]);
		const result = analyzeSession(data);
		const imm = result.entries.filter((e) => e.category === "immediate-redundant-read");
		assert.ok(imm.length >= 1, "should flag immediate redundant read");
	});

	it("does NOT flag same file read 2+ turns apart", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), readEntry("/repo/src/app.ts", 2)]);
		const result = analyzeSession(data);
		const imm = result.entries.filter((e) => e.category === "immediate-redundant-read");
		assert.strictEqual(imm.length, 0, "2 turns apart should not flag immediate");
	});

	it("coexists with existing redundant-read (2-turn window)", () => {
		const data = makeSession([readEntry("/repo/src/app.ts", 0), readEntry("/repo/src/app.ts", 1)]);
		const result = analyzeSession(data);
		const imm = result.entries.filter((e) => e.category === "immediate-redundant-read");
		const red = result.entries.filter((e) => e.category === "redundant-read");
		// Both should fire: same file within 1 turn triggers both rules
		assert.ok(imm.length >= 1, "immediate-redundant-read should fire");
		assert.ok(red.length >= 1, "existing redundant-read should also fire");
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
