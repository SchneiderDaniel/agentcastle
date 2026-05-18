/**
 * Tests for .pi/extensions/ask-user/ — JSONL logging + validation + migration + query
 *
 * Tests the JSONL Q&A storage: validation, serialization, append/read/migrate/query,
 * and slash command + tool integration.
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
// Types (duplicated from .pi/extensions/ask-user/types.ts — test convention)
// ---------------------------------------------------------------------------

interface QnaEntry {
	datetime: string;
	question: string;
	answer: string;
}

// ---------------------------------------------------------------------------
// Helpers under test — duplicated from .pi/extensions/ask-user/jsonl-logger.ts
// (Project convention: tests duplicate pure functions to avoid runtime module
//  resolution issues with node --experimental-strip-types + .ts imports.)
// ---------------------------------------------------------------------------

// ── Validation ─────────────────────────────────────────────────────────────

function validateQnaEntry(entry: QnaEntry): string | null {
	if (!entry.question || entry.question.trim() === "") {
		return "Question must be non-empty";
	}
	if (!entry.answer || entry.answer.trim() === "") {
		return "Answer must be non-empty";
	}
	if (!isValidISODatetime(entry.datetime)) {
		return "Datetime must be a valid ISO 8601 string";
	}
	return null;
}

function isValidISODatetime(s: string): boolean {
	if (typeof s !== "string" || s.length < 10) return false;
	const d = new Date(s);
	if (isNaN(d.getTime())) return false;
	return true;
}

// ── JSONL serialization ────────────────────────────────────────────────────

function toJsonlLine(entry: QnaEntry): string {
	return JSON.stringify(entry) + "\n";
}

function parseJsonlLine(line: string): QnaEntry | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (
			typeof parsed.datetime !== "string" ||
			typeof parsed.question !== "string" ||
			typeof parsed.answer !== "string"
		) {
			return null;
		}
		return parsed as QnaEntry;
	} catch {
		return null;
	}
}

// ── CSV migration parsing ──────────────────────────────────────────────────

function parseCsvLine(line: string): QnaEntry | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;

	// Parse fields with RFC 4180 awareness (quoted fields may contain semicolons)
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;

		if (ch === '"') {
			// Check for escaped quote ("")
			if (inQuotes && i + 1 < trimmed.length && trimmed[i + 1] === '"') {
				current += '"';
				i++; // skip next quote
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === ";" && !inQuotes) {
			fields.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	fields.push(current);

	if (fields.length < 3) return null;

	const [datetime, question, answer] = fields;
	if (!datetime || !question || answer === undefined) return null;

	return {
		datetime,
		question,
		answer,
	};
}

function splitCsvRows(content: string): string[] {
	const rows: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < content.length; i++) {
		const ch = content[i]!;

		if (ch === '"') {
			if (inQuotes && i + 1 < content.length && content[i + 1] === '"') {
				current += '""';
				i++;
			} else {
				inQuotes = !inQuotes;
				current += ch;
			}
		} else if (ch === "\n" && !inQuotes) {
			rows.push(current);
			current = "";
		} else if (ch === "\r" && !inQuotes) {
			continue;
		} else {
			current += ch;
		}
	}

	if (current.trim() !== "") {
		rows.push(current);
	}

	return rows;
}

// ── I/O operations ─────────────────────────────────────────────────────────

async function appendQnaEntry(
	projectDir: string,
	timestamp: string,
	question: string,
	answer: string,
): Promise<QnaEntry> {
	const entry: QnaEntry = { datetime: timestamp, question, answer };

	const validationError = validateQnaEntry(entry);
	if (validationError !== null) {
		throw new Error(validationError);
	}

	const dir = path.join(projectDir, ".pi", "context");
	const filePath = path.join(dir, "qna.jsonl");

	await fs.promises.mkdir(dir, { recursive: true });
	await fs.promises.appendFile(filePath, toJsonlLine(entry), "utf-8");

	return entry;
}

async function readQnaEntries(projectDir: string): Promise<QnaEntry[]> {
	const filePath = path.join(projectDir, ".pi", "context", "qna.jsonl");

	let content: string;
	try {
		content = await fs.promises.readFile(filePath, "utf-8");
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw err;
	}

	const lines = content.split("\n");
	const entries: QnaEntry[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") continue;
		const entry = parseJsonlLine(line);
		if (entry === null) {
			console.warn(`Warning: Skipping corrupted JSONL line ${i + 1}`);
			continue;
		}
		entries.push(entry);
	}

	return entries;
}

async function getQnaEntry(projectDir: string, id: number): Promise<QnaEntry | null | undefined> {
	const entries = await readQnaEntries(projectDir);
	if (entries.length === 0) return undefined;
	if (id < 1 || id > entries.length) return null;
	return entries[id - 1]!;
}

async function listQnaEntries(projectDir: string, limit: number = 20): Promise<QnaEntry[]> {
	const entries = await readQnaEntries(projectDir);
	return entries.slice(-limit);
}

async function queryQnaEntries(projectDir: string, text: string): Promise<QnaEntry[]> {
	const entries = await readQnaEntries(projectDir);
	const lowerText = text.toLowerCase();
	return entries.filter(
		(e) =>
			e.question.toLowerCase().includes(lowerText) || e.answer.toLowerCase().includes(lowerText),
	);
}

async function migrateQnaFromCsv(
	projectDir: string,
): Promise<{ migrated: number; skipped: number }> {
	const csvFile = path.join(projectDir, ".pi", "context", "qna.csv");
	const jsonlFile = path.join(projectDir, ".pi", "context", "qna.jsonl");

	if (!fs.existsSync(csvFile)) {
		return { migrated: 0, skipped: 0 };
	}

	const content = fs.readFileSync(csvFile, "utf-8");
	const lines = splitCsvRows(content);

	let migrated = 0;
	let skipped = 0;

	for (const line of lines) {
		const entry = parseCsvLine(line);
		if (entry === null) {
			if (line.trim() !== "") {
				console.warn(`Warning: Skipping unparseable CSV row: ${line.slice(0, 80)}...`);
				skipped++;
			}
			continue;
		}

		const validationError = validateQnaEntry(entry);
		if (validationError !== null) {
			console.warn(`Warning: Skipping invalid CSV entry: ${validationError}`);
			skipped++;
			continue;
		}

		await fs.promises.appendFile(jsonlFile, toJsonlLine(entry), "utf-8");
		migrated++;
	}

	fs.unlinkSync(csvFile);

	return { migrated, skipped };
}

// ============================================================================
// Unit tests: validateQnaEntry
// ============================================================================

describe("validateQnaEntry", () => {
	it("accepts valid entry", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "Alice",
		};
		assert.strictEqual(validateQnaEntry(entry), null);
	});

	it("rejects empty question", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Question"));
	});

	it("rejects whitespace-only question", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "   ",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Question"));
	});

	it("rejects empty answer", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Answer"));
	});

	it("rejects whitespace-only answer", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "   ",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Answer"));
	});

	it("rejects invalid ISO datetime", () => {
		const entry: QnaEntry = {
			datetime: "not-a-date",
			question: "What is your name?",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry)?.includes("Datetime"));
	});

	it("rejects empty datetime", () => {
		const entry: QnaEntry = {
			datetime: "",
			question: "What is your name?",
			answer: "Alice",
		};
		assert.ok(validateQnaEntry(entry) !== null);
	});
});

// ============================================================================
// Unit tests: isValidISODatetime
// ============================================================================

describe("isValidISODatetime", () => {
	it("accepts ISO 8601 with Z suffix", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00.000Z"));
	});

	it("accepts ISO 8601 with timezone offset", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00+02:00"));
	});

	it("accepts ISO 8601 without timezone", () => {
		assert.ok(isValidISODatetime("2026-05-15T19:00:00"));
	});

	it("rejects non-date string", () => {
		assert.ok(!isValidISODatetime("hello"));
	});

	it("rejects empty string", () => {
		assert.ok(!isValidISODatetime(""));
	});

	it("rejects invalid date like month 13", () => {
		// new Date("2026-13-01") produces NaN
		assert.ok(!isValidISODatetime("2026-13-01"));
	});
});

// ============================================================================
// Unit tests: toJsonlLine / parseJsonlLine
// ============================================================================

describe("toJsonlLine", () => {
	it("produces valid JSON line with newline terminator", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "What is your name?",
			answer: "Alice",
		};
		const line = toJsonlLine(entry);
		assert.ok(line.endsWith("\n"), "Line should end with newline");
		const parsed = JSON.parse(line.trim());
		assert.strictEqual(parsed.datetime, "2026-05-15T19:00:00.000Z");
		assert.strictEqual(parsed.question, "What is your name?");
		assert.strictEqual(parsed.answer, "Alice");
	});

	it("escapes newlines in question string", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "Line1\nLine2",
			answer: "Answer",
		};
		const line = toJsonlLine(entry);
		// The line should be a single line — no actual newlines inside JSON string
		const trimmed = line.trim();
		assert.ok(!trimmed.includes("\n"), "JSONL line should not contain literal newlines");
		const parsed = JSON.parse(trimmed);
		assert.strictEqual(parsed.question, "Line1\nLine2");
	});

	it("handles special characters in question/answer", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: 'Is "this" correct?',
			answer: "Yes; it's fine",
		};
		const line = toJsonlLine(entry);
		const parsed = JSON.parse(line.trim());
		assert.strictEqual(parsed.question, 'Is "this" correct?');
		assert.strictEqual(parsed.answer, "Yes; it's fine");
	});
});

describe("parseJsonlLine", () => {
	it("parses valid JSONL line", () => {
		const line =
			'{"datetime":"2026-05-15T19:00:00.000Z","question":"What is your name?","answer":"Alice"}\n';
		const entry = parseJsonlLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.datetime, "2026-05-15T19:00:00.000Z");
		assert.strictEqual(entry!.question, "What is your name?");
		assert.strictEqual(entry!.answer, "Alice");
	});

	it("returns null for empty line", () => {
		assert.strictEqual(parseJsonlLine(""), null);
		assert.strictEqual(parseJsonlLine("   "), null);
	});

	it("returns null for invalid JSON", () => {
		assert.strictEqual(parseJsonlLine("{invalid}"), null);
	});

	it("returns null for non-object JSON", () => {
		assert.strictEqual(parseJsonlLine('"just a string"'), null);
	});

	it("returns null for missing fields", () => {
		assert.strictEqual(parseJsonlLine('{"datetime":"2026-05-15T19:00:00.000Z"}'), null);
	});
});

// ============================================================================
// Unit tests: parseCsvLine (migration parsing)
// ============================================================================

describe("parseCsvLine", () => {
	it("parses simple CSV line with semicolons", () => {
		const line = "2026-05-15T19:00:00.000Z;What is your name?;Alice";
		const entry = parseCsvLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.datetime, "2026-05-15T19:00:00.000Z");
		assert.strictEqual(entry!.question, "What is your name?");
		assert.strictEqual(entry!.answer, "Alice");
	});

	it("handles quoted fields with semicolons inside", () => {
		const line = '2026-05-15T19:00:00.000Z;"Pick A; B; or C";"A; definitely A"';
		const entry = parseCsvLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.question, "Pick A; B; or C");
		assert.strictEqual(entry!.answer, "A; definitely A");
	});

	it("handles quoted fields with double quotes inside", () => {
		const line = '2026-05-15T19:00:00.000Z;"She said ""hello""";"He replied ""hi"""';
		const entry = parseCsvLine(line);
		assert.ok(entry !== null);
		assert.strictEqual(entry!.question, 'She said "hello"');
		assert.strictEqual(entry!.answer, 'He replied "hi"');
	});

	it("returns null for empty line", () => {
		assert.strictEqual(parseCsvLine(""), null);
	});

	it("returns null for line with no semicolons", () => {
		assert.strictEqual(parseCsvLine("just a string"), null);
	});

	it("returns null for line with only one semicolon", () => {
		assert.strictEqual(parseCsvLine("2026-05-15T19:00:00.000Z;only question"), null);
	});
});

// ============================================================================
// Integration tests: appendQnaEntry / readQnaEntries (real I/O)
// ============================================================================

describe("appendQnaEntry / readQnaEntries (real I/O)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-jsonl-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .pi/context/qna.jsonl on first write", async () => {
		const ts = "2026-05-15T19:00:00.000Z";
		await appendQnaEntry(tmpDir, ts, "What is your quest?", "To seek the Holy Grail");

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		assert.ok(fs.existsSync(jsonlPath), "JSONL file should exist");

		const content = fs.readFileSync(jsonlPath, "utf-8");
		assert.ok(content.includes(ts), "Timestamp should be in JSONL");
		assert.ok(content.includes("What is your quest?"), "Question should be in JSONL");
		assert.ok(content.includes("To seek the Holy Grail"), "Answer should be in JSONL");
	});

	it("appends rows to existing JSONL", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		const content = fs.readFileSync(jsonlPath, "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 2, "Should have exactly 2 lines");
	});

	it("stores each entry as a single JSON line", async () => {
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T19:00:00.000Z",
			"Line1\nLine2\nLine3",
			"Multi-line answer\nhere",
		);

		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		const content = fs.readFileSync(jsonlPath, "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 1, "Multi-line question should be one JSONL line");

		const parsed = JSON.parse(lines[0]!);
		assert.strictEqual(parsed.question, "Line1\nLine2\nLine3");
		assert.strictEqual(parsed.answer, "Multi-line answer\nhere");
	});

	it("rejects empty question with error", async () => {
		await assert.rejects(
			() => appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "", "Answer"),
			/Question/,
		);
	});

	it("rejects empty answer with error", async () => {
		await assert.rejects(
			() => appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Question", ""),
			/Answer/,
		);
	});

	it("rejects invalid datetime with error", async () => {
		await assert.rejects(
			() => appendQnaEntry(tmpDir, "bad-date", "Question", "Answer"),
			/Datetime/,
		);
	});

	it("readQnaEntries returns empty array for missing file", async () => {
		const entries = await readQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("readQnaEntries returns written entries", async () => {
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "Q1", "A1");
		await appendQnaEntry(tmpDir, "2026-05-15T20:00:00.000Z", "Q2", "A2");

		const entries = await readQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0]!.question, "Q1");
		assert.strictEqual(entries[1]!.question, "Q2");
	});

	it("readQnaEntries skips corrupted lines with warning", async () => {
		const jsonlPath = path.join(tmpDir, ".pi", "context", "qna.jsonl");
		await fs.promises.mkdir(path.dirname(jsonlPath), { recursive: true });
		// Write valid + corrupted + valid lines
		const valid1 = '{"datetime":"2026-05-15T19:00:00.000Z","question":"Q1","answer":"A1"}\n';
		const corrupted = "not-json\n";
		const valid2 = '{"datetime":"2026-05-15T20:00:00.000Z","question":"Q2","answer":"A2"}\n';
		await fs.promises.writeFile(jsonlPath, valid1 + corrupted + valid2, "utf-8");

		// Capture warnings
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		const entries = await readQnaEntries(tmpDir);

		console.warn = origWarn;

		assert.strictEqual(entries.length, 2, "Should skip corrupted line");
		assert.ok(
			warnings.some((w) => w.includes("corrupted")),
			"Should warn about corrupted line",
		);
	});
});

// ============================================================================
// Integration tests: getQnaEntry / listQnaEntries / queryQnaEntries
// ============================================================================

describe("getQnaEntry / listQnaEntries / queryQnaEntries (real I/O)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-query-test-"));
		// Write 5 test entries
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "What is your name?", "Alice");
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T20:00:00.000Z",
			"What is your quest?",
			"To seek the Holy Grail",
		);
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T21:00:00.000Z",
			"What is your favorite color?",
			"Blue",
		);
		await appendQnaEntry(
			tmpDir,
			"2026-05-16T10:00:00.000Z",
			"Explain semicolons in CSV",
			"They break things",
		);
		await appendQnaEntry(
			tmpDir,
			"2026-05-16T11:00:00.000Z",
			"How JSONL works?",
			"One line per entry",
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("getQnaEntry returns entry by 1-based id", async () => {
		const entry = await getQnaEntry(tmpDir, 1);
		assert.ok(entry !== null && entry !== undefined);
		assert.strictEqual(entry.question, "What is your name?");
	});

	it("getQnaEntry returns null for out-of-range id", async () => {
		const entry = await getQnaEntry(tmpDir, 999);
		assert.strictEqual(entry, null);
	});

	it("getQnaEntry returns undefined for missing file", async () => {
		const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-empty-"));
		const entry = await getQnaEntry(emptyDir, 1);
		assert.strictEqual(entry, undefined);
		fs.rmSync(emptyDir, { recursive: true, force: true });
	});

	it("listQnaEntries returns last N entries", async () => {
		const entries = await listQnaEntries(tmpDir, 3);
		assert.strictEqual(entries.length, 3);
		assert.strictEqual(entries[0]!.question, "What is your favorite color?");
		assert.strictEqual(entries[2]!.question, "How JSONL works?");
	});

	it("listQnaEntries defaults to 20", async () => {
		const entries = await listQnaEntries(tmpDir);
		assert.strictEqual(entries.length, 5, "Should return all when less than limit");
	});

	it("queryQnaEntries searches question field", async () => {
		const entries = await queryQnaEntries(tmpDir, "semicolons");
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.question, "Explain semicolons in CSV");
	});

	it("queryQnaEntries searches answer field", async () => {
		const entries = await queryQnaEntries(tmpDir, "Grail");
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.answer, "To seek the Holy Grail");
	});

	it("queryQnaEntries is case-insensitive", async () => {
		const entries = await queryQnaEntries(tmpDir, "holy");
		assert.strictEqual(entries.length, 1);
	});

	it("queryQnaEntries returns empty for no match", async () => {
		const entries = await queryQnaEntries(tmpDir, "zzz_nonexistent");
		assert.strictEqual(entries.length, 0);
	});
});

// ============================================================================
// Integration tests: migrateQnaFromCsv
// ============================================================================

describe("migrateQnaFromCsv", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-migrate-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("migrates valid CSV entries to JSONL and deletes CSV", async () => {
		// Write CSV fixture
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = [
			"2026-05-15T19:00:00.000Z;What is your name?;Alice",
			'2026-05-15T20:00:00.000Z;"What is your quest?";"To seek the Holy Grail"',
			"",
		].join("\n");
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const result = await migrateQnaFromCsv(tmpDir);

		assert.strictEqual(result.migrated, 2, "Should migrate 2 entries");
		assert.strictEqual(result.skipped, 0, "Should skip 0 entries");

		// CSV should be deleted
		assert.ok(!fs.existsSync(path.join(csvDir, "qna.csv")), "CSV should be deleted");

		// JSONL should exist with migrated entries
		const jsonlPath = path.join(csvDir, "qna.jsonl");
		assert.ok(fs.existsSync(jsonlPath), "JSONL should exist");

		const entries = JSON.parse(
			"[" + fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").join(",") + "]",
		);
		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0]!.question, "What is your name?");
		assert.strictEqual(entries[1]!.question, "What is your quest?");
	});

	it("skips unparseable CSV rows with warning", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = [
			"2026-05-15T19:00:00.000Z;Valid question;Valid answer",
			"bad-line-without-semicolons",
			"2026-05-15T20:00:00.000Z;Another valid;Another answer",
		].join("\n");
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		const result = await migrateQnaFromCsv(tmpDir);

		console.warn = origWarn;

		assert.strictEqual(result.migrated, 2, "Should migrate 2 valid entries");
		assert.strictEqual(result.skipped, 1, "Should skip 1 unparseable entry");
		assert.ok(
			warnings.some((w) => w.includes("unparseable")),
			"Should warn about unparseable row",
		);
	});

	it("skips rows with empty question or answer during migration", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		const csvContent = [
			"2026-05-15T19:00:00.000Z;Valid;Valid",
			"2026-05-15T20:00:00.000Z;;Valid answer", // Empty question
			"2026-05-15T21:00:00.000Z;Valid question;", // Empty answer
		].join("\n");
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (msg: string) => warnings.push(msg);

		const result = await migrateQnaFromCsv(tmpDir);

		console.warn = origWarn;

		assert.strictEqual(result.migrated, 1, "Should migrate 1 valid entry");
		assert.strictEqual(result.skipped, 2, "Should skip 2 invalid entries");
	});

	it("returns zero counts when no CSV exists", async () => {
		const result = await migrateQnaFromCsv(tmpDir);
		assert.deepStrictEqual(result, { migrated: 0, skipped: 0 });
	});

	it("handles RFC 4180 quoted fields with newlines in CSV", async () => {
		const csvDir = path.join(tmpDir, ".pi", "context");
		fs.mkdirSync(csvDir, { recursive: true });
		// Multi-line CSV with quoted newlines
		const csvContent = ['2026-05-15T19:00:00.000Z;"Line1\nLine2\nLine3";"Multi-line\nanswer"'].join(
			"\n",
		);
		fs.writeFileSync(path.join(csvDir, "qna.csv"), csvContent, "utf-8");

		const result = await migrateQnaFromCsv(tmpDir);

		assert.strictEqual(result.migrated, 1, "Should migrate multi-line CSV entry");

		// Read back the JSONL entry
		const jsonlPath = path.join(csvDir, "qna.jsonl");
		const jsonlContent = fs.readFileSync(jsonlPath, "utf-8");
		const parsed = JSON.parse(jsonlContent.trim());
		assert.strictEqual(parsed.question, "Line1\nLine2\nLine3");
		assert.strictEqual(parsed.answer, "Multi-line\nanswer");
	});
});

// ============================================================================
// Structural tests: schema shape
// ============================================================================

describe("ask_user schema shape", () => {
	it("mode parameter should accept 'choice' and 'freetext' values", () => {
		const modeValues = ["choice", "freetext"] as const;
		assert.ok(modeValues.includes("choice"));
		assert.ok(modeValues.includes("freetext"));
		assert.strictEqual(modeValues.length, 2, "Mode should have exactly 2 values");
	});

	it("options should be optional when mode is freetext", async () => {
		const paramsWithoutOptions = {
			question: "Tell me about yourself",
			mode: "freetext" as const,
		};
		assert.ok("question" in paramsWithoutOptions, "Question is required");
		assert.ok("mode" in paramsWithoutOptions, "Mode is present");
		const hasOptions = "options" in paramsWithoutOptions;
		assert.strictEqual(hasOptions, false, "Options should be absent for freetext");
	});

	it("QnaEntry shape has datetime, question, answer fields", () => {
		const entry: QnaEntry = {
			datetime: "2026-05-15T19:00:00.000Z",
			question: "test",
			answer: "test",
		};
		assert.ok("datetime" in entry);
		assert.ok("question" in entry);
		assert.ok("answer" in entry);
	});
});

// ============================================================================
// Integration tests: slash command output format
// ============================================================================

describe("/qna markdown table formatting", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-slash-test-"));
		await appendQnaEntry(tmpDir, "2026-05-15T19:00:00.000Z", "What is your name?", "Alice");
		await appendQnaEntry(
			tmpDir,
			"2026-05-15T20:00:00.000Z",
			"What is your quest?",
			"To seek the Holy Grail",
		);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("formatTable produces valid markdown table", async () => {
		const entries = await readQnaEntries(tmpDir);
		const rows: string[] = [];
		rows.push("| # | Datetime | Question | Answer |");
		rows.push("|---|---|---|---|");
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i]!;
			const id = i + 1;
			const q = e.question.length <= 60 ? e.question : e.question.slice(0, 59) + "…";
			const a = e.answer.length <= 40 ? e.answer : e.answer.slice(0, 39) + "…";
			const dt = e.datetime.length <= 24 ? e.datetime : e.datetime.slice(0, 24);
			rows.push(`| ${id} | ${dt} | ${q} | ${a} |`);
		}
		const table = rows.join("\n");

		assert.ok(table.includes("| # |"), "Should have header row");
		assert.ok(table.includes("|---|---|"), "Should have separator row");
		assert.ok(table.includes("What is your name?"), "Should contain question");
		assert.ok(table.includes("Alice"), "Should contain answer");
	});

	it("truncates long question in table", async () => {
		const longQ = "A".repeat(100);
		await appendQnaEntry(tmpDir, "2026-05-15T21:00:00.000Z", longQ, "Short answer");

		const entries = await readQnaEntries(tmpDir);
		const lastEntry = entries[entries.length - 1]!;
		const q =
			lastEntry.question.length <= 60 ? lastEntry.question : lastEntry.question.slice(0, 59) + "…";
		assert.strictEqual(q.length, 60, "Long question should be truncated to 60 chars");
		assert.ok(q.endsWith("…"), "Truncated question should end with ellipsis");
	});
});

// ============================================================================
// Edge case: empty file behavior
// ============================================================================

describe("Empty/missing JSONL file edge cases", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-empty-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("readQnaEntries returns empty for missing file", async () => {
		const entries = await readQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("listQnaEntries returns empty for missing file", async () => {
		const entries = await listQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("getQnaEntry returns undefined for missing file", async () => {
		const entry = await getQnaEntry(tmpDir, 1);
		assert.strictEqual(entry, undefined);
	});

	it("queryQnaEntries returns empty for missing file", async () => {
		const entries = await queryQnaEntries(tmpDir, "test");
		assert.deepStrictEqual(entries, []);
	});
});

// ============================================================================
// Edge case: empty JSONL file (file exists but empty)
// ============================================================================

describe("Empty JSONL file edge cases", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-empty-file-test-"));
		const jsonlDir = path.join(tmpDir, ".pi", "context");
		await fs.promises.mkdir(jsonlDir, { recursive: true });
		// Create empty file
		await fs.promises.writeFile(path.join(jsonlDir, "qna.jsonl"), "", "utf-8");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("readQnaEntries returns empty for empty file", async () => {
		const entries = await readQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("listQnaEntries returns empty for empty file", async () => {
		const entries = await listQnaEntries(tmpDir);
		assert.deepStrictEqual(entries, []);
	});

	it("getQnaEntry returns undefined for empty file", async () => {
		const entry = await getQnaEntry(tmpDir, 1);
		assert.strictEqual(entry, undefined);
	});
});
