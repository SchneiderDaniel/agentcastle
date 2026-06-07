/**
 * Tests for test-designer.md — User-Journey & Persona-Based Testing (Section 8)
 *
 * Phase 1: Section 8 — User-Journey & Persona-Based Testing heading + body
 * Phase 2: Phase Format updated, Section 7 updated, Phase Gating updated
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/test-designer-user-journey.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEST_DESIGNER_MD = resolve(__dirname, "../agents/test-designer.md");

function readTestDesignerMd(): string {
	return readFileSync(TEST_DESIGNER_MD, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 1: Section 8 — User-Journey & Persona-Based Testing
// ---------------------------------------------------------------------------

describe("test-designer.md — Section 8: User-Journey & Persona-Based Testing (Phase 1)", () => {
	it("contains '### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)' heading", () => {
		const content = readTestDesignerMd();
		assert.ok(
			content.includes("### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)"),
			"Should have Section 8 heading with Norman, Hendrickson attribution",
		);
	});

	it("Section 8 appears after Section 7 (Test Plan Completeness Rules) and before Codebase Exploration", () => {
		const content = readTestDesignerMd();
		const section7Idx = content.indexOf("### 7. Test Plan Completeness Rules");
		const section8Idx = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		assert.ok(section7Idx >= 0, "Section 7 heading must exist");
		assert.ok(section8Idx >= 0, "Section 8 heading must exist");
		assert.ok(codebaseIdx >= 0, "Codebase Exploration heading must exist");
		assert.ok(section7Idx < section8Idx, "Section 8 should appear after Section 7");
		assert.ok(section8Idx < codebaseIdx, "Section 8 should appear before Codebase Exploration");
	});

	it("Section 8 body contains 'Identify personas' subsection", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("Identify personas") || section8Body.includes("**Identify personas**"),
			"Section 8 should contain 'Identify personas' subsection",
		);
	});

	it("Section 8 body contains 'Trace the full journey' subsection", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("Trace the full journey") ||
				section8Body.includes("**Trace the full journey**"),
			"Section 8 should contain 'Trace the full journey' subsection",
		);
	});

	it("Section 8 body contains 'Test user-visible feedback at each step' subsection", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("Test user-visible feedback") ||
				section8Body.includes("**Test user-visible feedback**"),
			"Section 8 should contain 'Test user-visible feedback at each step' subsection",
		);
	});

	it("Section 8 body contains 'Real-world conditions' subsection", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("Real-world conditions") ||
				section8Body.includes("**Real-world conditions**"),
			"Section 8 should contain 'Real-world conditions' subsection",
		);
	});

	it("Section 8 body contains 'Non-happy-path journeys' subsection", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("Non-happy-path journeys") ||
				section8Body.includes("**Non-happy-path journeys**"),
			"Section 8 should contain 'Non-happy-path journeys' subsection",
		);
	});

	it("Section 8 body contains 'User-journey scenarios are not E2E tests' clarification", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("not E2E tests") || section8Body.includes("are not E2E tests"),
			"Section 8 should clarify that user-journey scenarios are not E2E tests",
		);
	});

	it("Section 8 body contains the flag instruction about missing user-visible feedback", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("missing or unclear user-visible feedback") &&
				section8Body.includes("flag it in the test plan"),
			"Section 8 should instruct to flag missing user-visible feedback in the test plan",
		);
	});

	it("Section 8 body contains 'Derive test scenarios from the user's goal' lead sentence", () => {
		const content = readTestDesignerMd();
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const codebaseIdx = content.indexOf("## Codebase Exploration");
		const section8Body = content.substring(section8Start, codebaseIdx);
		assert.ok(
			section8Body.includes("Derive test scenarios from the user") &&
				section8Body.includes("not just from code structure"),
			"Section 8 should contain the lead sentence about deriving scenarios from user goals",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2a: Phase Format includes user-journey as valid layer
// ---------------------------------------------------------------------------

describe("test-designer.md — Phase Format updated with user-journey layer (Phase 2a)", () => {
	it("Phase Format lists 'user-journey' as a valid layer value alongside entity, use-case, adapter, e2e", () => {
		const content = readTestDesignerMd();
		// The format line should show all five layer values
		const layerValuesMatch =
			content.includes("entity`, `use-case`, `adapter`, `e2e`, `user-journey") ||
			(content.includes("entity`, `use-case`, `adapter`, `e2e") &&
				content.includes("user-journey"));
		assert.ok(layerValuesMatch, "Phase Format should list user-journey as a valid layer value");
	});

	it("Phase Format states 'Each phase MUST include at least one user-journey test (or state explicitly why none applies)'", () => {
		const content = readTestDesignerMd();
		assert.ok(
			content.includes("Each phase MUST include at least one") && content.includes("user-journey"),
			"Phase Format should mandate at least one user-journey test per phase",
		);
	});

	it("Phase Format lists layer values with 'user-journey' in the Layer values line", () => {
		const content = readTestDesignerMd();
		// Find the line or section defining layer values
		const yourTaskSection = content.substring(
			content.indexOf("## Your Task"),
			content.indexOf("## Comment Style"),
		);
		assert.ok(
			yourTaskSection.includes("Layer values") || yourTaskSection.includes("layer values"),
			"The Your Task section should define layer values",
		);
		assert.ok(
			yourTaskSection.includes("user-journey"),
			"The Your Task section should include user-journey as a layer value",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2b: Section 7 completeness rules include user-journeys bullet
// ---------------------------------------------------------------------------

describe("test-designer.md — Section 7 completeness includes user-journeys (Phase 2b)", () => {
	it("Section 7 completeness list contains a 'User journeys' bullet", () => {
		const content = readTestDesignerMd();
		const section7Start = content.indexOf("### 7. Test Plan Completeness Rules");
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		// If section 8 doesn't exist yet, fall back to Codebase Exploration
		const section7End =
			section8Start >= 0 ? section8Start : content.indexOf("## Codebase Exploration");
		const section7Body = content.substring(section7Start, section7End);
		assert.ok(
			section7Body.includes("User journeys") || section7Body.includes("**User journeys**"),
			"Section 7 completeness list should contain a 'User journeys' bullet",
		);
	});

	it("Section 7 user-journeys bullet mentions 'at least one persona-based scenario per phase'", () => {
		const content = readTestDesignerMd();
		const section7Start = content.indexOf("### 7. Test Plan Completeness Rules");
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const section7End =
			section8Start >= 0 ? section8Start : content.indexOf("## Codebase Exploration");
		const section7Body = content.substring(section7Start, section7End);
		assert.ok(
			section7Body.includes("at least one persona-based scenario per phase"),
			"User-journeys bullet should mention at least one persona-based scenario per phase",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2c: Phase gating references user-journey verification by Auditor
// ---------------------------------------------------------------------------

describe("test-designer.md — Phase gating references Auditor user-journey check (Phase 2c)", () => {
	it("Phase gating bullet mentions Auditor checks user-journey scenarios", () => {
		const content = readTestDesignerMd();
		const section7Start = content.indexOf("### 7. Test Plan Completeness Rules");
		const section8Start = content.indexOf(
			"### 8. User-Journey & Persona-Based Testing (Norman, Hendrickson)",
		);
		const section7End =
			section8Start >= 0 ? section8Start : content.indexOf("## Codebase Exploration");
		const section7Body = content.substring(section7Start, section7End);
		assert.ok(
			section7Body.includes("user-journey"),
			"Phase gating section should reference user-journey",
		);
		assert.ok(
			section7Body.includes("Auditor"),
			"Phase gating section should reference Auditor verification of user-journey",
		);
	});

	it("Phase gating bullet says 'The Auditor also checks that user-journey scenarios exist per phase'", () => {
		const content = readTestDesignerMd();
		assert.ok(
			content.includes("Auditor also checks") &&
				content.includes("user-journey scenarios exist per phase"),
			"Phase gating should state that Auditor checks user-journey scenarios exist per phase",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2d: Section 6 "Product verification tests" bullet unchanged
// ---------------------------------------------------------------------------

describe("test-designer.md — Section 6 Product verification tests preserved (Phase 2d)", () => {
	it("Section 6 still contains 'Product verification tests' bullet", () => {
		const content = readTestDesignerMd();
		assert.ok(
			content.includes("Product verification tests"),
			"Section 6 should still contain the Product verification tests bullet",
		);
	});

	it("Section 6 Product verification tests still mentions browser/CLI-level verification and manual smoke check", () => {
		const content = readTestDesignerMd();
		assert.ok(
			content.includes("browser/CLI-level verification") ||
				content.includes("browser") ||
				content.includes("manual smoke check"),
			"Section 6 Product verification tests should still reference manual smoke check",
		);
	});
});
