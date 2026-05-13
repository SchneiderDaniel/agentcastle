/**
 * Phase 2: Supervisor pre-audit hook (extracted pure helper)
 *
 * Tests that determineLspPreAuditDecision() correctly gates the
 * Implementation→Audit transition based on pre-audit result.
 *
 * Uses createRequire to import from supervisor.ts (pattern from
 * test/supervisor-stream-activity.test.mts).
 *
 * Run with:
 *   npx tsx --test test/supervisor-lsp-audit.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
	determineLspPreAuditDecision,
} = require("../.pi/extensions/supervisor.ts");

type PreAuditResult = { proceed: boolean; note: string };

describe("determineLspPreAuditDecision", () => {
	it("nextStatus='Audit', has files, preAudit={proceed:true} → returns Audit", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: true, note: "clean" },
			0,
			true,
		);
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.auditTriggered, true);
		assert.strictEqual(result.note, "clean");
	});

	it("nextStatus='Audit', has files, preAudit={proceed:false}, retryCount=0 → returns Implementation (block)", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: false, note: "2 errors" },
			0,
			true,
		);
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.auditTriggered, true);
		assert.strictEqual(result.note, "2 errors");
	});

	it("nextStatus='Audit', has files, preAudit={proceed:false}, retryCount=3 → returns Audit (exhausted)", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: false, note: "errors remain" },
			3,
			true,
		);
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.auditTriggered, true);
	});

	it("nextStatus='Audit', no modified files → skip audit, return Audit", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			null,
			0,
			false,
		);
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.auditTriggered, false);
		assert.ok(result.note.includes("skipped"));
	});

	it("nextStatus='Audit', preAudit=null → proceed to Audit", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			null,
			0,
			true,
		);
		assert.strictEqual(result.nextStatus, "Audit");
		assert.strictEqual(result.auditTriggered, false);
	});

	it("nextStatus≠'Audit' → pass through, no hook call", () => {
		const result = determineLspPreAuditDecision(
			"Implementation",
			null,
			0,
			true,
		);
		assert.strictEqual(result.nextStatus, "Implementation");
		assert.strictEqual(result.auditTriggered, false);
	});

	it("nextStatus='Architecture' → pass through", () => {
		const result = determineLspPreAuditDecision(
			"Architecture",
			null,
			0,
			true,
		);
		assert.strictEqual(result.nextStatus, "Architecture");
		assert.strictEqual(result.auditTriggered, false);
	});

	it("retryCount is NaN → treated as 0 → block transition", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: false, note: "err" },
			NaN,
			true,
		);
		assert.strictEqual(result.nextStatus, "Implementation");
	});

	it("retryCount is 2 → still can retry (block)", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: false, note: "err" },
			2,
			true,
		);
		assert.strictEqual(result.nextStatus, "Implementation");
	});

	it("retryCount is 3 → exhausted (proceed to Audit)", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: false, note: "err" },
			3,
			true,
		);
		assert.strictEqual(result.nextStatus, "Audit");
	});

	it("retryCount is 4 → still exhausted (proceed to Audit)", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: false, note: "err" },
			4,
			true,
		);
		assert.strictEqual(result.nextStatus, "Audit");
	});

	it("nextStatus='Done' → pass through", () => {
		const result = determineLspPreAuditDecision(
			"Done",
			null,
			0,
			true,
		);
		assert.strictEqual(result.nextStatus, "Done");
		assert.strictEqual(result.auditTriggered, false);
	});

	it("retryCount negative → treated as 0 → block", () => {
		const result = determineLspPreAuditDecision(
			"Audit",
			{ proceed: false, note: "err" },
			-1,
			true,
		);
		assert.strictEqual(result.nextStatus, "Implementation");
	});
});
