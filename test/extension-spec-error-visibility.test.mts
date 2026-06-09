/**
 * Tests for Error Visibility rules (E1-E7) in extension-spec.md
 *
 * Content-verification tests that read the .md file and assert patterns.
 * Follows same pattern as test/writing-voice.test.mts.
 *
 * Run with:
 *   node --experimental-strip-types --test test/extension-spec-error-visibility.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FILE_PATH = resolve(
	import.meta.dirname,
	"..",
	".pi/skills/extension-spec/references/extension-spec.md",
);

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function readFile(): string {
	return readFileSync(FILE_PATH, "utf-8");
}

/**
 * Extract section headings in order.
 */
function extractHeadings(body: string): string[] {
	const headings: string[] = [];
	for (const line of body.split("\n")) {
		const m = line.match(/^###\s+(.+)/);
		if (m) {
			headings.push(m[1]!.trim());
		}
	}
	return headings;
}

/**
 * Check that a table row with the given # label exists in the body.
 */
function tableRowExists(body: string, label: string): boolean {
	// Matches markdown table rows like "| **E1** | ..."
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`\\|\\s*\\*\\*${escaped}\\*\\*\\s*\\|`);
	return regex.test(body);
}

/**
 * Check that a checklist item exists.
 */
function checklistItemExists(body: string, label: string): boolean {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const regex = new RegExp(`- \\[ \\] ${escaped}`);
	return regex.test(body);
}

/**
 * Check that text exists in the body.
 */
function bodyIncludes(body: string, text: string): boolean {
	return body.includes(text);
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: File structure preserved
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: File structure preserved", () => {
	const content = readFile();

	it("File exists at expected path", () => {
		assert.ok(existsSync(FILE_PATH), `File not found: ${FILE_PATH}`);
	});

	it("YAML frontmatter parses without error", () => {
		const lines = content.split("\n");
		if (lines[0]?.trim() === "---") {
			let endIndex = -1;
			for (let i = 1; i < lines.length; i++) {
				if (lines[i]?.trim() === "---") {
					endIndex = i;
					break;
				}
			}
			assert.ok(endIndex > 0, "Unclosed YAML frontmatter");
		}
	});

	it("Section ordering preserved: Common Issues → Modular Architecture → Reuse APIs → Pitfalls → Error Visibility → Security Considerations → External References → Testing Strategy → Priority Matrix → Checklist", () => {
		const headings = extractHeadings(content);

		const expectedOrder = [
			"🏗 Common Issues (Apply to All Extensions)",
			"📐 Modular Architecture Best Practices (from supervisor.ts refactoring audit)",
			"♻️ Reuse Pi Built-in APIs",
			"🐞 Common Pitfalls — DO NOT REPEAT THESE",
			"🔥 Error Visibility",
			"🔒 Security Considerations",
			"📚 Key External References",
			"🧪 Testing Strategy",
			"🎯 Priority Matrix",
			"✅ Extension Anti-Pattern Checklist",
		];

		for (const expected of expectedOrder) {
			assert.ok(
				headings.includes(expected),
				`Missing heading: "${expected}". Found: ${JSON.stringify(headings)}`,
			);
		}

		// Verify relative order
		for (let i = 0; i < expectedOrder.length - 1; i++) {
			const idxA = headings.indexOf(expectedOrder[i]!);
			const idxB = headings.indexOf(expectedOrder[i + 1]!);
			assert.ok(
				idxA < idxB,
				`"${expectedOrder[i]}" (index ${idxA}) should come before "${expectedOrder[i + 1]}" (index ${idxB})`,
			);
		}
	});

	it("Existing anti-pattern sections (C1-C14, M1-M8, R1-R6, P1-P24) unchanged", () => {
		// Each existing rule heading should still be present in its table
		const existingRules = [
			"C1",
			"C2",
			"C3",
			"C4",
			"C5",
			"C6",
			"C7",
			"C8",
			"C9",
			"C10",
			"C11",
			"C12",
			"C13",
			"C14",
			"M1",
			"M2",
			"M3",
			"M4",
			"M5",
			"M6",
			"M7",
			"M8",
			"R1",
			"R2",
			"R3",
			"R4",
			"R5",
			"R6",
			"P1",
			"P2",
			"P3",
			"P4",
			"P5",
			"P6",
			"P7",
			"P8",
			"P9",
			"P10",
			"P11",
			"P12",
			"P13",
			"P14",
			"P15",
			"P16",
			"P17",
			"P18",
			"P19",
			"P20",
			"P21",
			"P22",
			"P23",
			"P24",
		];

		for (const rule of existingRules) {
			assert.ok(
				tableRowExists(content, rule),
				`Table row for existing rule ${rule} is missing or changed`,
			);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Error Visibility section (E1-E7) inserted correctly
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Error Visibility section (E1-E7)", () => {
	const content = readFile();

	it("New Error Visibility heading exists after Pitfalls table and before Security Considerations", () => {
		const headings = extractHeadings(content);
		const pitfallsIdx = headings.indexOf("🐞 Common Pitfalls — DO NOT REPEAT THESE");
		const errorVisIdx = headings.indexOf("🔥 Error Visibility");
		const securityIdx = headings.indexOf("🔒 Security Considerations");

		assert.ok(
			errorVisIdx !== -1,
			"Missing '🔥 Error Visibility' heading. Found: " + JSON.stringify(headings),
		);
		assert.ok(
			pitfallsIdx < errorVisIdx,
			`Error Visibility (index ${errorVisIdx}) should come after Pitfalls (index ${pitfallsIdx})`,
		);
		assert.ok(
			errorVisIdx < securityIdx,
			`Error Visibility (index ${errorVisIdx}) should come before Security Considerations (index ${securityIdx})`,
		);
	});

	it("E1 rule: Never empty catch", () => {
		assert.ok(tableRowExists(content, "E1"), "E1 table row missing");
		assert.ok(
			bodyIncludes(content, "Never empty") &&
				(bodyIncludes(content, "`catch`") || bodyIncludes(content, "catch")),
			"E1 missing 'Never empty catch' text",
		);
		assert.ok(
			bodyIncludes(content, "ctx.ui.notify") || bodyIncludes(content, "re-throw"),
			"E1 missing notification or re-throw requirement",
		);
	});

	it("E2 rule: console.error/console.warn not sufficient alone", () => {
		assert.ok(tableRowExists(content, "E2"), "E2 table row missing");
		assert.ok(
			bodyIncludes(content, "console.error") || bodyIncludes(content, "console.warn"),
			"E2 missing console.error/console.warn reference",
		);
		assert.ok(
			bodyIncludes(content, "ctx.ui.notify") || bodyIncludes(content, "pi.sendMessage"),
			"E2 missing ctx.ui.notify or pi.sendMessage pairing",
		);
	});

	it("E3 rule: Check pi.exec return code", () => {
		assert.ok(tableRowExists(content, "E3"), "E3 table row missing");
		assert.ok(
			bodyIncludes(content, "pi.exec") && bodyIncludes(content, "result.code"),
			"E3 missing pi.exec or result.code reference",
		);
	});

	it("E4 rule: Always clean up state in finally", () => {
		assert.ok(tableRowExists(content, "E4"), "E4 table row missing");
		assert.ok(
			bodyIncludes(content, "finally") || bodyIncludes(content, "setStatus"),
			"E4 missing finally or setStatus reference",
		);
	});

	it("E5 rule: Fail closed, not open", () => {
		assert.ok(tableRowExists(content, "E5"), "E5 table row missing");
		assert.ok(
			bodyIncludes(content, "Fail closed") || bodyIncludes(content, "fail closed"),
			"E5 missing 'fail closed' text",
		);
	});

	it("E6 rule: Prefer Result<T> for fallible operations", () => {
		assert.ok(tableRowExists(content, "E6"), "E6 table row missing");
		assert.ok(
			bodyIncludes(content, "Result<T>") || bodyIncludes(content, "Result<"),
			"E6 missing Result<T> reference",
		);
	});

	it("E7 rule: Never return partial success data", () => {
		assert.ok(tableRowExists(content, "E7"), "E7 table row missing");
		assert.ok(
			bodyIncludes(content, "partial success") || bodyIncludes(content, "partial"),
			"E7 missing 'partial success' text",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Checklist items added
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Checklist items added", () => {
	const content = readFile();

	it("E1 checklist item: No empty catch blocks", () => {
		assert.ok(
			checklistItemExists(content, "E1: No empty catch blocks"),
			"Missing E1 checklist item",
		);
	});

	it("E2 checklist item: console.error/warn paired with ctx.ui.notify", () => {
		assert.ok(
			checklistItemExists(content, "E2: console.error/warn paired with ctx.ui.notify"),
			"Missing E2 checklist item",
		);
	});

	it("E3 checklist item: pi.exec return code checked after every call", () => {
		assert.ok(
			checklistItemExists(content, "E3: pi.exec return code checked after every call"),
			"Missing E3 checklist item",
		);
	});

	it("E4 checklist item: State cleanup in finally", () => {
		assert.ok(
			checklistItemExists(content, "E4: State cleanup in finally"),
			"Missing E4 checklist item",
		);
	});

	it("E5 checklist item: Fail closed", () => {
		assert.ok(checklistItemExists(content, "E5: Fail closed"), "Missing E5 checklist item");
	});

	it("E6 checklist item: Result<T> used for fallible functions", () => {
		assert.ok(
			checklistItemExists(content, "E6: Result<T> used for fallible functions"),
			"Missing E6 checklist item",
		);
	});

	it("E7 checklist item: No partial success data on failure", () => {
		assert.ok(
			checklistItemExists(content, "E7: No partial success data on failure"),
			"Missing E7 checklist item",
		);
	});

	it("Existing checklist items (C10-C14, P15-P24, M8) still present", () => {
		const existingChecklistItems = [
			"C10: All local imports use `.ts` extension",
			"C11: `satisfies` used for object literals",
			"C12: Dynamic `import()` uses double-cast pattern",
			"C13: Unused callback parameters prefixed with underscore",
			"C14: Destructured object parameters have inline type annotations",
			"P15: `timer.unref()` uses safe escape pattern",
			"P16: `readdirSync` with `withFileTypes: true` uses `Dirent[]` type",
			"P17: `ctx.ui.notify()` level param uses valid literal",
			"P18: Optional nullable fields typed as `T | null`",
			"P19: Non-standard error properties accessed via `(err as any).stderr`",
			"P20: Theme API type limitations handled with `as any` escape",
			"P21: Literal unions widened to `string`",
			"P22: Non-null assertions (`!`) used only with API-contract guarantee",
			"P23: Property renames in interfaces include grep",
			"P24: `pi.sendMessage()` / `pi.sendUserMessage()` includes all required fields",
			"M8: Parameter count/type changes in signatures updated",
		];

		for (const item of existingChecklistItems) {
			assert.ok(checklistItemExists(content, item), `Existing checklist item "${item}" is missing`);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Integration checks
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: Integration checks", () => {
	const content = readFile();

	it("Error Visibility section is after the --- that follows P24 table", () => {
		// Find the position of P24 and the Error Visibility heading
		const p24Match = content.match(/\*\*P24\*\*/);
		const evMatch = content.match(/### 🔥 Error Visibility/);

		assert.ok(p24Match !== null, "P24 text not found");
		assert.ok(evMatch !== null, "Error Visibility heading not found");
		assert.ok(p24Match.index! < evMatch.index!, "Error Visibility should come after P24");
	});

	it("Error Visibility rules are in a table format consistent with other sections", () => {
		const evSection = content.match(/### 🔥 Error Visibility\n\n([\s\S]*?)(?=\n### )/);
		assert.ok(evSection !== null, "Cannot extract Error Visibility section");

		const sectionText = evSection[1]!;

		// Should contain a markdown table (| ... | ... |)
		assert.ok(
			sectionText.includes("|"),
			"Error Visibility section should contain a markdown table",
		);

		// Should have a table divider row
		assert.ok(
			sectionText.includes("| ---"),
			"Error Visibility section should have a markdown table divider",
		);
	});

	it("Priority Matrix still lists silent error swallowing as P0 blocker", () => {
		assert.ok(
			bodyIncludes(content, "silent error swallowing"),
			"Priority Matrix should still mention silent error swallowing",
		);
		assert.ok(
			bodyIncludes(content, "P0") || bodyIncludes(content, "Blocker"),
			"Priority Matrix should still have P0/Blocker row",
		);
	});
});
