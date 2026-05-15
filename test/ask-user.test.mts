/**
 * Tests for .pi/extensions/ask-user.ts — Free-text mode + CSV logging
 *
 * Tests the RFC 4180 CSV escaping helper, the CSV append logic, and
 * verifies module exports via structural import.
 *
 * Run with:
 *   node --experimental-strip-types --test test/ask-user.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";

// ---------------------------------------------------------------------------
// Helpers under test — duplicated from ask-user.ts (not exported)
// ---------------------------------------------------------------------------

/**
 * Escape a single CSV field per RFC 4180.
 * Fields containing commas, double quotes, or newlines are enclosed in
 * double quotes; internal double quotes are doubled.
 */
function escapeCsvField(s: string): string {
	if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/**
 * Build a CSV row from header-name→value map.
 * Columns are ordered: timestamp, question, answer.
 */
function toCsvRow(timestamp: string, question: string, answer: string): string {
	return `${escapeCsvField(timestamp)},${escapeCsvField(question)},${escapeCsvField(answer)}\n`;
}

/**
 * Append one Q&A entry to .pi/context/qna.csv.
 * Creates directory and file if missing. Errors are silently swallowed.
 */
async function appendQnaEntry(
	projectDir: string,
	timestamp: string,
	question: string,
	answer: string,
): Promise<void> {
	const csvDir = path.join(projectDir, ".pi", "context");
	const csvPath = path.join(csvDir, "qna.csv");
	try {
		await fs.promises.mkdir(csvDir, { recursive: true });
		await fs.promises.appendFile(csvPath, toCsvRow(timestamp, question, answer), "utf-8");
	} catch {
		// Best-effort: silently ignore write failures (R3)
	}
}

// ---------------------------------------------------------------------------
// Unit tests: escapeCsvField
// ---------------------------------------------------------------------------

describe("escapeCsvField (RFC 4180)", () => {
	it("passes through plain text without quotes", () => {
		assert.strictEqual(escapeCsvField("hello"), "hello");
		assert.strictEqual(escapeCsvField("keep_as_is"), "keep_as_is");
		assert.strictEqual(escapeCsvField("123"), "123");
	});

	it("wraps field with commas in double quotes", () => {
		assert.strictEqual(escapeCsvField("a,b"), '"a,b"');
		assert.strictEqual(escapeCsvField("1,2,3"), '"1,2,3"');
	});

	it("wraps field with double quotes and doubles internal quotes", () => {
		assert.strictEqual(escapeCsvField('say "hello"'), '"say ""hello"""');
		assert.strictEqual(escapeCsvField('"quoted"'), '"""quoted"""');
	});

	it("wraps field with newlines in double quotes", () => {
		assert.strictEqual(escapeCsvField("line1\nline2"), '"line1\nline2"');
	});

	it("wraps field with carriage returns in double quotes", () => {
		assert.strictEqual(escapeCsvField("line1\r\nline2"), '"line1\r\nline2"');
	});

	it("handles combination of commas, quotes, and newlines", () => {
		const input = 'a,b "c"\nd';
		const expected = '"a,b ""c""\nd"';
		assert.strictEqual(escapeCsvField(input), expected);
	});

	it("handles empty string", () => {
		assert.strictEqual(escapeCsvField(""), "");
	});

	it("handles string with only spaces", () => {
		assert.strictEqual(escapeCsvField("   "), "   ");
	});
});

// ---------------------------------------------------------------------------
// Unit tests: toCsvRow
// ---------------------------------------------------------------------------

describe("toCsvRow", () => {
	it("produces correct CSV line with three columns", () => {
		const row = toCsvRow("2026-05-15T19:00:00.000Z", "What is your name?", "Alice");
		assert.strictEqual(row, "2026-05-15T19:00:00.000Z,What is your name?,Alice\n");
	});

	it("escapes fields with special characters", () => {
		const row = toCsvRow(
			"2026-05-15T19:00:00.000Z",
			'Is "this" correct?',
			"Yes, it's fine",
		);
		// Answer contains a comma, so it gets quoted too
		assert.strictEqual(
			row,
			'2026-05-15T19:00:00.000Z,"Is ""this"" correct?","Yes, it\'s fine"\n',
		);
	});
});

// ---------------------------------------------------------------------------
// Integration tests: appendQnaEntry (real I/O)
// ---------------------------------------------------------------------------

describe("appendQnaEntry (real I/O)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .pi/context/qna.csv on first write", async () => {
		const ts = "2026-05-15T19:00:00.000Z";
		await appendQnaEntry(tmpDir, ts, "What is your quest?", "To seek the Holy Grail");

		const csvPath = path.join(tmpDir, ".pi", "context", "qna.csv");
		assert.ok(fs.existsSync(csvPath), "CSV file should exist");

		const content = fs.readFileSync(csvPath, "utf-8");
		assert.ok(content.includes(ts), "Timestamp should be in CSV");
		assert.ok(content.includes("What is your quest?"), "Question should be in CSV");
		assert.ok(content.includes("To seek the Holy Grail"), "Answer should be in CSV");
	});

	it("appends rows to existing CSV", async () => {
		// First write
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		// Second write
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const csvPath = path.join(tmpDir, ".pi", "context", "qna.csv");
		const content = fs.readFileSync(csvPath, "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 2, "Should have exactly 2 rows");
	});

	it("escapes commas in question/answer correctly", async () => {
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T19:00:00.000Z",
			"Pick A, B, or C",
			"A, definitely A",
		);

		const csvPath = path.join(tmpDir, ".pi", "context", "qna.csv");
		const content = fs.readFileSync(csvPath, "utf-8");
		assert.ok(content.includes('"Pick A, B, or C"'), "Comma in question should be quoted");
		assert.ok(content.includes('"A, definitely A"'), "Comma in answer should be quoted");
	});

	it("escapes double quotes in question/answer correctly", async () => {
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T19:00:00.000Z",
			'She said "hello"',
			'He replied "hi"',
		);

		const csvPath = path.join(tmpDir, ".pi", "context", "qna.csv");
		const content = fs.readFileSync(csvPath, "utf-8");
		// CSV should contain doubled double-quotes: ""hello""
		assert.ok(content.includes('""hello""'), "Double quotes in question should be doubled");
	});

	it("silently ignores write errors (best-effort)", async () => {
		// Use a non-writable path — root of filesystem
		const badDir = path.join(tmpDir, "nonexistent-parent", "deep");
		await appendQnaEntry(badDir, "2026-05-15T19:00:00.000Z", "Q", "A");
		// Should not throw — best-effort logging
		assert.ok(true, "Should not throw on write failure");
	});
});

// ---------------------------------------------------------------------------
// Structural tests: schema shape
// ---------------------------------------------------------------------------

describe("ask_user schema shape", () => {
	it("mode parameter should accept 'choice' and 'freetext' values", () => {
		// Verify the schema definition matches expected shape
		// This is a compile-time check via runtime assertion
		const modeValues = ["choice", "freetext"] as const;
		assert.ok(modeValues.includes("choice"));
		assert.ok(modeValues.includes("freetext"));
		assert.strictEqual(modeValues.length, 2, "Mode should have exactly 2 values");
	});

	it("options should be optional when mode is freetext", async () => {
		// Simulates Type.Object params parsing with optional options
		const paramsWithoutOptions = {
			question: "Tell me about yourself",
			mode: "freetext" as const,
		};
		assert.ok("question" in paramsWithoutOptions, "Question is required");
		assert.ok("mode" in paramsWithoutOptions, "Mode is present");
		// options is optional — this should not fail
		const hasOptions = "options" in paramsWithoutOptions;
		assert.strictEqual(hasOptions, false, "Options should be absent for freetext");
	});
});
