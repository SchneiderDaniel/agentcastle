/**
 * ask-user — CSV logger
 *
 * Pure functions for semicolon-separated Q&A logging.
 * No TUI imports, no pi-ai dependency beyond types import.
 * Testable standalone.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Escape a single CSV field per RFC 4180.
 * Fields containing semicolons, double quotes, or CRLF are enclosed in
 * double quotes; internal double quotes are doubled ("").
 */
export function escapeCsvField(s: string): string {
	if (s.includes('"') || s.includes(";") || s.includes("\n") || s.includes("\r")) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/**
 * Build a single CSV row for a Q&A entry.
 * Columns: datetime; question; answer. Terminated with \n.
 */
export function toCsvRow(timestamp: string, question: string, answer: string): string {
	return `${escapeCsvField(timestamp)};${escapeCsvField(question)};${escapeCsvField(answer)}\n`;
}

/**
 * Append one Q&A entry to .pi/context/qna.csv (semicolon-separated).
 * Creates the directory and file if missing. Errors are silently swallowed
 * (best-effort per R3).
 */
export async function appendQnaEntry(
	projectDir: string,
	timestamp: string,
	question: string,
	answer: string,
): Promise<void> {
	const csvDir = path.join(projectDir, ".pi", "context");
	const csvPath = path.join(csvDir, "qna.csv");
	try {
		await fs.mkdir(csvDir, { recursive: true });
		await fs.appendFile(csvPath, toCsvRow(timestamp, question, answer), "utf-8");
	} catch {
		// Best-effort: silently ignore write failures (R3)
	}
}
