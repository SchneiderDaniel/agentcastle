import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildAuditCommentFallback } from "../.pi/extensions/supervisor/github.ts";

// ─── REJECTED fallback tests ──────────────────────────────────────

const REJECT_OUTPUT_WITH_FINDINGS = `
AUDIT_DECISION: REJECTED
AUDIT_REJECTED

### 4a. Architecture Compliance

**🔴 Critical — Architecture Compliance: Dependency direction wrong**
  - Symptom: Domain layer imports from adapter layer
  - Consequence: Breaks dependency rule
  - Remedy: Invert dependency, introduce port interface
  - Location: \`src/domain/service.ts:42\`

### 4b. Test Quality

**🟡 Warning — Test Quality: Missing edge case tests**
  - Symptom: No test for empty input
  - Consequence: Empty input causes runtime error
  - Remedy: Add test case for empty input
  - Location: \`src/adapter/controller.test.ts:15\`
`;

const REJECT_OUTPUT_NO_FINDINGS = `
AUDIT_REJECTED
Some random text with no structure.
`;

const APPROVE_OUTPUT = `
AUDIT_DECISION: APPROVED
AUDIT_APPROVED

AUDIT_SCORE: 6/6

### Summary
Implementation follows architecture correctly.

- Architecture compliance: ✅
- Ticket fulfillment: ✓
- Tests passed: ✓
- Test quality: ✓
- Correctness & Safety: ✓
- Code quality: ✓
- Completeness: ✓
`;

describe("buildAuditCommentFallback — REJECTED with structured findings", () => {
	const result = buildAuditCommentFallback("REJECTED", REJECT_OUTPUT_WITH_FINDINGS);

	it("returns non-null", () => {
		assert.ok(result !== null, "Should produce fallback comment");
	});

	it("starts with ## Audit Rejected", () => {
		assert.ok(result!.startsWith("## Audit Rejected"), "Should start with header");
	});

	it("contains 🔴 Critical finding", () => {
		assert.ok(result!.includes("🔴 Critical"), "Should include critical finding");
		assert.ok(result!.includes("Dependency direction wrong"), "Should include finding title");
	});

	it("contains 🟡 Warning finding", () => {
		assert.ok(result!.includes("🟡 Warning"), "Should include warning");
	});

	it("contains Symptom/Consequence/Remedy/Location for critical", () => {
		assert.ok(result!.includes("Symptom:"), "Should include Symptom");
		assert.ok(result!.includes("Consequence:"), "Should include Consequence");
		assert.ok(result!.includes("Remedy:"), "Should include Remedy");
		assert.ok(result!.includes("Location:"), "Should include Location");
	});

	it("ends with Fix and resubmit", () => {
		assert.ok(result!.trim().endsWith("Fix and resubmit."), "Should end with fix message");
	});
});

describe("buildAuditCommentFallback — REJECTED without structured findings", () => {
	const result = buildAuditCommentFallback("REJECTED", REJECT_OUTPUT_NO_FINDINGS);

	it("returns null for truly unstructured output", () => {
		assert.equal(result, null, "Should return null when no findings found");
	});
});

describe("buildAuditCommentFallback — APPROVED", () => {
	const result = buildAuditCommentFallback("APPROVED", APPROVE_OUTPUT);

	it("returns non-null", () => {
		assert.ok(result !== null, "Should produce fallback comment");
	});

	it("starts with ## Audit Approved", () => {
		assert.ok(result!.startsWith("## Audit Approved"), "Should start with header");
	});

	it("contains score", () => {
		assert.ok(result!.includes("Score:"), "Should include score");
		assert.ok(result!.includes("6/6"), "Should include score value");
	});

	it("contains checklist items with status", () => {
		assert.ok(result!.includes("Architecture compliance: ✅"), "Should include checklist item");
		assert.ok(result!.includes("Ticket fulfillment: ✅"), "Should include checklist item");
	});

	it("contains Summary section", () => {
		assert.ok(result!.includes("### Summary"), "Should include summary section");
		assert.ok(
			result!.includes("Implementation follows architecture"),
			"Should include summary text",
		);
	});
});

describe("buildAuditCommentFallback — edge cases", () => {
	it("returns null for empty string", () => {
		assert.equal(buildAuditCommentFallback("REJECTED", ""), null);
	});

	it("returns null for whitespace-only", () => {
		assert.equal(buildAuditCommentFallback("APPROVED", "   \n  \n"), null);
	});

	it("does not crash on non-printable chars", () => {
		const result = buildAuditCommentFallback(
			"REJECTED",
			"\x00\x01\x02**🔴 Critical — X: Y**\n- Symptom: z\n",
		);
		assert.ok(result !== null);
	});
});
