/**
 * Tests for audit.ts — sendUserMessage with deliverAs: "followUp" removal (Issue #604)
 *
 * Phase 1: Remove sendUserMessage calls from audit.ts
 * Phase 2: CI failure path preserves behavior (ctx.ui.notify, return value)
 * Phase 3: TSC checkpoint failure path preserves behavior (ctx.ui.notify, return value)
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/audit-sendusermessage.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDIT_TS = resolve(__dirname, "../pipeline/audit.ts");

function readAuditSource(): string {
	return readFileSync(AUDIT_TS, "utf-8");
}

// ===========================================================================
// Phase 1: Remove sendUserMessage calls from audit.ts
// ===========================================================================

describe("audit.ts — sendUserMessage removed (Phase 1)", () => {
	it("no sendUserMessage on CI failure path (was line 65)", () => {
		const src = readAuditSource();
		// Find the CI failure block
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('return { nextStatus: "Implementation"'),
		);
		// sendUserMessage should not appear in CI failure block
		assert.ok(
			!ciFailBlock.includes("sendUserMessage"),
			"CI failure block should not contain sendUserMessage",
		);
	});

	it("no sendUserMessage on TSC failure path (was line 131)", () => {
		const src = readAuditSource();
		// Find the TSC failure block
		const tscFailBlock = src.substring(
			src.indexOf('tscDecision.nextStatus !== "Audit"'),
			src.indexOf("return { nextStatus: tscDecision.nextStatus, note: tscDecision.note }"),
		);
		// sendUserMessage should not appear in TSC failure block
		assert.ok(
			!tscFailBlock.includes("sendUserMessage"),
			"TSC failure block should not contain sendUserMessage",
		);
	});

	it("entire file contains no pi.sendUserMessage call", () => {
		const src = readAuditSource();
		// Count all occurrences of sendUserMessage in the file
		const matches = src.match(/sendUserMessage/g);
		assert.ok(
			!matches || matches.length === 0,
			"audit.ts should contain no sendUserMessage references at all",
		);
	});

	it("no deliverAs reference exists in audit.ts", () => {
		const src = readAuditSource();
		assert.ok(!src.includes("deliverAs"), "audit.ts should contain no deliverAs references");
	});
});

// ===========================================================================
// Phase 2: CI failure path preserves behavior
// ===========================================================================

describe("audit.ts — CI failure path preserves behavior (Phase 2)", () => {
	it("CI failure path still has ctx.ui.notify call", () => {
		const src = readAuditSource();
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "pending"'),
		);
		assert.ok(
			ciFailBlock.includes("ctx.ui.notify"),
			"CI failure block should still contain ctx.ui.notify",
		);
	});

	it("CI failure path still returns nextStatus Implementation", () => {
		const src = readAuditSource();
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "pending"'),
		);
		assert.ok(
			ciFailBlock.includes('return { nextStatus: "Implementation"'),
			"CI failure block should still return nextStatus Implementation",
		);
	});

	it("CI failure notification is warning type", () => {
		const src = readAuditSource();
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "pending"'),
		);
		assert.ok(ciFailBlock.includes('"warning"'), "CI failure notify should use warning level");
	});

	it("CI failure notification mentions 'CI checks failing'", () => {
		const src = readAuditSource();
		const ciFailBlock = src.substring(
			src.indexOf('ciResult.status === "failing"'),
			src.indexOf('ciResult.status === "pending"'),
		);
		assert.ok(
			ciFailBlock.includes("CI checks failing"),
			"CI failure notify should mention 'CI checks failing'",
		);
	});
});

// ===========================================================================
// Phase 3: TSC checkpoint failure path preserves behavior
// ===========================================================================

describe("audit.ts — TSC failure path preserves behavior (Phase 3)", () => {
	it("TSC failure path still has ctx.ui.notify call", () => {
		const src = readAuditSource();
		// Find the if (tscDecision.note) block which contains the notify
		const noteBlockStart = src.indexOf("if (tscDecision.note)");
		const returnStr = "return { nextStatus: tscDecision.nextStatus, note: tscDecision.note }";
		const returnEnd = src.indexOf(returnStr);
		// Find the enclosing closing brace after the return
		const blockEnd = src.indexOf("}", returnEnd) + 1;
		const tscFailBlock = src.substring(noteBlockStart, blockEnd);
		assert.ok(
			tscFailBlock.includes("ctx.ui.notify"),
			"TSC failure block should still contain ctx.ui.notify",
		);
	});

	it("TSC failure path still returns nextStatus from tscDecision", () => {
		const src = readAuditSource();
		const returnStr = "return { nextStatus: tscDecision.nextStatus, note: tscDecision.note }";
		assert.ok(
			src.includes(returnStr),
			"audit.ts should still contain the TSC failure return statement",
		);
	});

	it("TSC failure notification is warning type", () => {
		const src = readAuditSource();
		const notifyLine = 'ctx.ui.notify(tscDecision.note, "warning");';
		assert.ok(src.includes(notifyLine), "TSC failure notify should use warning level");
	});
});
