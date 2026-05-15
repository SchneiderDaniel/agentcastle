/**
 * Tests for tsc-decisions (Tier 2 pipeline integration)
 *
 * Pure function tests for determineTscCheckpointDecision().
 *
 * Run with:
 *   node --experimental-strip-types --test test/tsc-decisions.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

interface TscDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error";
	message: string;
	code?: string;
}

interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
}

interface TscCheckpointDecision {
	nextStatus: string;
	note: string;
	tscTriggered: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// Pure function under test
// ═══════════════════════════════════════════════════════════════════════

/**
 * Decide next pipeline status based on tsc checkpoint result.
 *
 * - If intendedNext !== "Audit" (e.g. still in some other status) → pass through
 * - If tsc has errors → stay in "Implementation"
 * - If tsc is clean → proceed to "Audit"
 * - If tsc was not triggered → pass through to intended next
 */
export function determineTscCheckpointDecision(
	result: TscCheckpointResult | null,
	intendedNext: string,
): TscCheckpointDecision {
	if (intendedNext !== "Audit") {
		return { nextStatus: intendedNext, note: "", tscTriggered: false };
	}

	if (!result) {
		return { nextStatus: "Audit", note: "TSC checkpoint skipped", tscTriggered: false };
	}

	if (result.hasErrors) {
		const formatted = formatTscDiagnostics(result.diagnostics);
		return {
			nextStatus: "Implementation",
			note: `TSC checkpoint: ${result.diagnostics.length} type error(s) found — fix before proceeding.\n${formatted}`,
			tscTriggered: true,
		};
	}

	return {
		nextStatus: "Audit",
		note: "TSC checkpoint: ✓ no type errors detected",
		tscTriggered: true,
	};
}

// Reuse formatTscDiagnostics from tsc-checkpoint
function formatTscDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, TscDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		diags.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const codePart = d.code ? ` (${d.code})` : "";
			lines.push(`${file}, Line ${d.line}: [${d.severity}] ${msg}${codePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("determineTscCheckpointDecision", () => {
	it("intendedNext not Audit → pass through", () => {
		const result = determineTscCheckpointDecision(
			{ diagnostics: [], hasErrors: true },
			"Implementation",
		);
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.tscTriggered, false);
	});

	it("hasErrors → stay in Implementation", () => {
		const result = determineTscCheckpointDecision(
			{
				diagnostics: [
					{
						file: "a.ts",
						line: 1,
						column: 1,
						severity: "Error",
						message: "Type error",
						code: "TS2322",
					},
				],
				hasErrors: true,
			},
			"Audit",
		);
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.tscTriggered, true);
	});

	it("hasErrors → note includes diagnostics", () => {
		const result = determineTscCheckpointDecision(
			{
				diagnostics: [
					{
						file: "a.ts",
						line: 1,
						column: 1,
						severity: "Error",
						message: "Type error",
						code: "TS2322",
					},
				],
				hasErrors: true,
			},
			"Audit",
		);
		assert.ok(result.note.includes("Type error"));
		assert.ok(result.note.includes("TS2322"));
	});

	it("clean (no errors) → proceed to Audit", () => {
		const result = determineTscCheckpointDecision({ diagnostics: [], hasErrors: false }, "Audit");
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("no type errors"));
	});

	it("null result → proceed to Audit with skip note", () => {
		const result = determineTscCheckpointDecision(null, "Audit");
		assert.strictEqual(result.nextStatus, "Audit");
		assert.ok(result.note.includes("skipped"));
		assert.strictEqual(result.tscTriggered, false);
	});

	it("empty diagnostics, hasErrors false → clean proceed", () => {
		const result = determineTscCheckpointDecision({ diagnostics: [], hasErrors: false }, "Audit");
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.tscTriggered, true);
	});
});
