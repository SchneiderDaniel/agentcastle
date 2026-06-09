/**
 * Tests for workflow.ts — config-driven pipeline transitions
 *
 * Pure function tests for resolveNextStatus().
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/workflow.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { resolveNextStatus, type WorkflowStep } from "../config/workflow.ts";

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("resolveNextStatus", () => {
	it("returns null when step has no markerMap", () => {
		const step: WorkflowStep = { status: "Backlog", builtIn: "backlog" };
		const result = resolveNextStatus(step, "anything");
		assert.strictEqual(result, null);
	});

	it("returns matching status when marker found (Architecture → TestDesign)", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "some output ARCHITECTURE_COMPLETE more text");
		assert.strictEqual(result, "TestDesign");
	});

	it("returns null when no marker matches", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "some random output with no marker");
		assert.strictEqual(result, null);
	});

	it("last occurring marker wins when multiple exist (Architecture feedback loop)", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: {
				ARCHITECTURE_COMPLETE: "TestDesign",
				FEEDBACK_RESEARCH: "Research",
			},
		};
		const result = resolveNextStatus(step, "ARCHITECTURE_COMPLETE\nsome design\nFEEDBACK_RESEARCH");
		// FEEDBACK_RESEARCH appears last → Research
		assert.strictEqual(result, "Research");
	});

	it("RESEARCH_COMPLETE alone (no feedback) → Architecture", () => {
		const step: WorkflowStep = {
			status: "Research",
			agentName: "researcher",
			markerMap: {
				RESEARCH_COMPLETE: "Architecture",
			},
		};
		const result = resolveNextStatus(step, "RESEARCH_COMPLETE no feedback needed");
		assert.strictEqual(result, "Architecture");
	});

	it("auditor reject appears after approve → Implementation", () => {
		const step: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: {
				AUDIT_APPROVED: "Done",
				AUDIT_REJECTED: "Implementation",
			},
		};
		const result = resolveNextStatus(
			step,
			"AUDIT_APPROVED\nsome checks\nAUDIT_REJECTED\nmissing test coverage",
		);
		assert.strictEqual(result, "Implementation");
	});

	it("auditor approve appears after reject → Done", () => {
		const step: WorkflowStep = {
			status: "Audit",
			agentName: "auditor",
			markerMap: {
				AUDIT_APPROVED: "Done",
				AUDIT_REJECTED: "Implementation",
			},
		};
		const result = resolveNextStatus(step, "AUDIT_REJECTED\nfix applied\nAUDIT_APPROVED\nall good");
		assert.strictEqual(result, "Done");
	});

	it("case sensitivity — lowercase marker does not match", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "architecture_complete");
		assert.strictEqual(result, null);
	});

	it("markerMap with single entry works", () => {
		const step: WorkflowStep = {
			status: "TestDesign",
			agentName: "test-designer",
			markerMap: { TEST_PLAN_COMPLETE: "Implementation" },
		};
		const result = resolveNextStatus(step, "some output TEST_PLAN_COMPLETE");
		assert.strictEqual(result, "Implementation");
	});

	it("empty output string returns null", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: { ARCHITECTURE_COMPLETE: "TestDesign" },
		};
		const result = resolveNextStatus(step, "");
		assert.strictEqual(result, null);
	});

	it("empty markerMap returns null", () => {
		const step: WorkflowStep = {
			status: "Architecture",
			agentName: "architect",
			markerMap: {},
		};
		const result = resolveNextStatus(step, "anything");
		assert.strictEqual(result, null);
	});
});
