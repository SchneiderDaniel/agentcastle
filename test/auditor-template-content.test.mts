/**
 * Tests for Auditor agent — APPROVE comment template content.
 *
 * Verifies that the expanded template in .pi/agents/auditor.md includes
 * Summary, How it works, Key decisions sections, Mermaid guidance,
 * trivial-change guidance, and preserves the existing checklist.
 *
 * Run with:
 *   node --experimental-strip-types --test test/auditor-template-content.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Reuse readAgentFile from auditor-test-execution.test.mts
// ---------------------------------------------------------------------------

function readAgentFile(path: string): { frontmatter: Record<string, string>; body: string } {
	const content = readFileSync(path, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) throw new Error(`Missing frontmatter in ${path}`);
	const fm: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
		if (kv) {
			let val = kv[2]!.trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			fm[kv[1]!] = val;
		}
	}
	return { frontmatter: fm, body: match[2]!.trim() };
}

const agent = readAgentFile(".pi/agents/auditor.md");

// ---------------------------------------------------------------------------
// Helper: find position of a substring in the body (case-insensitive).
// Returns -1 if not found.
// ---------------------------------------------------------------------------

function pos(text: string): number {
	const idx = agent.body.toLowerCase().indexOf(text.toLowerCase());
	return idx;
}

// ---------------------------------------------------------------------------
// 1. APPROVE template has Summary heading
// ---------------------------------------------------------------------------

describe("APPROVE template — new explanation sections", () => {
	it("1: has Summary heading", () => {
		assert.ok(
			agent.body.includes("### Summary") || agent.body.includes("**Summary**"),
			"Body must contain Summary heading",
		);
	});

	it("2: has How it works heading", () => {
		assert.ok(
			agent.body.includes("### How it works") || agent.body.includes("**How it works**"),
			"Body must contain How it works heading",
		);
	});

	it("3: has Key decisions heading", () => {
		assert.ok(
			agent.body.includes("### Key decisions") || agent.body.includes("**Key decisions**"),
			"Body must contain Key decisions heading",
		);
	});

	it("4: Summary appears before checklist", () => {
		const summaryPos = pos("### summary");
		const checklistPos = pos("architecture compliance");
		assert.ok(summaryPos > -1, "Summary must be present");
		assert.ok(checklistPos > -1, "Checklist must be present");
		assert.ok(summaryPos < checklistPos, "Summary must appear before checklist");
	});

	it("5: How it works appears before checklist", () => {
		const howPos = pos("### how it works");
		const checklistPos = pos("architecture compliance");
		assert.ok(howPos > -1, "How it works must be present");
		assert.ok(howPos < checklistPos, "How it works must appear before checklist");
	});

	it("6: Key decisions appears before checklist", () => {
		const decisionsPos = pos("### key decisions");
		const checklistPos = pos("architecture compliance");
		assert.ok(decisionsPos > -1, "Key decisions must be present");
		assert.ok(decisionsPos < checklistPos, "Key decisions must appear before checklist");
	});
});

// ---------------------------------------------------------------------------
// 2. Existing 5-item checklist preserved
// ---------------------------------------------------------------------------

describe("APPROVE template — checklist preserved", () => {
	// Use checklist-specific strings (with `: ✓`) to avoid matching
	// the same words elsewhere in the agent instructions (e.g. step 3 "Tests passed",
	// step 4 "Code quality", "Completeness").
	const checklistItems = [
		"Architecture compliance: ✓",
		"Tests passed: ✓",
		"Test coverage: ✓",
		"Code quality: ✓",
		"Completeness: ✓",
	];

	it("7: all 5 checklist items present", () => {
		for (const item of checklistItems) {
			assert.ok(
				agent.body.includes(item),
				`Checklist must include: ${item}`,
			);
		}
	});

	it("8: checklist items in original order", () => {
		const body = agent.body;
		const positions = checklistItems.map((item) => body.indexOf(item));
		for (let i = 1; i < positions.length; i++) {
			assert.ok(
				positions[i]! > positions[i - 1]!,
				`"${checklistItems[i]}" must appear after "${checklistItems[i - 1]}" in the body`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Mermaid diagram guidance
// ---------------------------------------------------------------------------

describe("APPROVE template — Mermaid diagram guidance", () => {
	it("9: mentions Mermaid and mermaid code block", () => {
		assert.ok(
			agent.body.toLowerCase().includes("mermaid"),
			"Body must mention Mermaid",
		);
		assert.ok(
			agent.body.includes("```mermaid") || agent.body.includes("\\`\\`\\`mermaid"),
			"Body must reference ```mermaid code block",
		);
	});

	it("13: diagrams are optional", () => {
		assert.ok(
			agent.body.toLowerCase().includes("optional"),
			"Body must state that diagrams are optional",
		);
	});
});

// ---------------------------------------------------------------------------
// 4. Trivial-change guidance
// ---------------------------------------------------------------------------

describe("APPROVE template — trivial-change guidance", () => {
	it("10: mentions trivial changes allow minimal comment", () => {
		assert.ok(
			agent.body.toLowerCase().includes("trivial"),
			"Body must mention trivial changes",
		);
		assert.ok(
			agent.body.toLowerCase().includes("minimal comment") ||
				agent.body.toLowerCase().includes("minimal"),
			"Body must allow minimal comment for trivial changes",
		);
	});

	it("14: gives auditor discretion for trivial", () => {
		assert.ok(
			agent.body.toLowerCase().includes("discretion") ||
				agent.body.toLowerCase().includes("judgment") ||
				agent.body.toLowerCase().includes("judgement"),
			"Body must give auditor discretion for trivial changes",
		);
	});
});

// ---------------------------------------------------------------------------
// 5. APPROVE starts with ## Audit Approved
// ---------------------------------------------------------------------------

describe("APPROVE template — heading", () => {
	it("11: APPROVE section starts with ## Audit Approved", () => {
		assert.ok(
			agent.body.includes("## Audit Approved"),
			"APPROVE template must start with ## Audit Approved",
		);
	});
});

// ---------------------------------------------------------------------------
// 6. Code snippets guidance
// ---------------------------------------------------------------------------

describe("APPROVE template — code snippets", () => {
	it("12: code snippets allowed in How it works", () => {
		assert.ok(
			agent.body.toLowerCase().includes("code snippet"),
			"Body must mention code snippets at auditor discretion",
		);
	});
});

// ---------------------------------------------------------------------------
// 7. Test command reference preserved
// ---------------------------------------------------------------------------

describe("APPROVE template — test command reference", () => {
	it("15: test command reference preserved", () => {
		assert.ok(
			agent.body.includes("ran: <test command>"),
			"Body must include ran: <test command> reference",
		);
	});
});

// ---------------------------------------------------------------------------
// 8. Rejection templates unchanged
// ---------------------------------------------------------------------------

describe("Rejection templates — unchanged", () => {
	it("16a: test-failure rejection format still present", () => {
		assert.ok(
			agent.body.includes("## Audit Rejected"),
			"Rejection template heading must exist",
		);
		assert.ok(
			agent.body.includes("Failed tests:"),
			"Test-failure format must still have Failed tests section",
		);
	});

	it("16b: missing-command rejection format still present", () => {
		assert.ok(
			agent.body.includes("No runnable test command found in test plan"),
			"Missing-command rejection message must exist",
		);
	});
});
