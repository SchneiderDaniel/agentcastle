/**
 * Tests for TestDesigner agent — verifies test plan comment format requirements.
 *
 * Run with:
 *   node --experimental-strip-types --test test/test-designer-format.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Test: TestDesigner agent file contains mandatory test command instructions
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

const agent = readAgentFile(".pi/agents/test-designer.md");

describe("TestDesigner agent file — test command requirement", () => {
	it("1.1: instructs to include a fenced code block with test command", () => {
		const hasFencedBlock = agent.body.includes("```bash") || agent.body.includes("\\`\\`\\`bash");
		assert.ok(hasFencedBlock, "Agent file must mention fenced bash code block for test command");
	});

	it("1.2: mentions glob/wildcard pattern for multiple test suites", () => {
		const hasGlobMention = agent.body.includes("glob") || agent.body.includes("test/*.test");
		assert.ok(hasGlobMention, "Agent file must mention glob pattern for multiple test files");
	});

	it("1.3: mentions concrete test file paths", () => {
		const hasTestFilePath = agent.body.includes("test/foo.test.mts") || agent.body.includes(".test.");
		assert.ok(hasTestFilePath, "Agent file must reference concrete test file paths");
	});

	it("1.4: mentions Developer-created test files", () => {
		const hasExpectedMention = agent.body.includes("Developer is expected to create") || agent.body.includes("files the Developer");
		assert.ok(hasExpectedMention, "Agent file must mention that Developer creates test files");
	});

	it("1.5: has 'ALWAYS include a runnable test command' in rules", () => {
		assert.ok(
			agent.body.includes("ALWAYS") && agent.body.includes("runnable test command"),
			"Rules must mandate runnable test command",
		);
	});

	it("1.6: mentions 60-second timeout for Auditor", () => {
		assert.ok(
			agent.body.includes("60-second") || agent.body.includes("60 second"),
			"Agent file must mention 60-second timeout",
		);
	});
});

// ---------------------------------------------------------------------------
// Fixture-based format validation
// ---------------------------------------------------------------------------

import {
	buildPlanWithCommand,
	buildPlanWithoutCommand,
	buildPlanWithGlob,
} from "./helper/comment-builder.mts";

describe("Test plan comment format — builder validation", () => {
	it("1.7: plan with command includes fenced bash block", () => {
		const plan = buildPlanWithCommand({ command: "node --test test/x.test.mts" });
		assert.ok(plan.includes("```bash"));
		assert.ok(plan.includes("node --test test/x.test.mts"));
	});

	it("1.8: plan without command has no fenced block", () => {
		const plan = buildPlanWithoutCommand();
		assert.ok(!plan.includes("```bash"));
	});

	it("1.9: plan with glob uses wildcard pattern", () => {
		const plan = buildPlanWithGlob();
		assert.ok(plan.includes("test/*.test.*"));
	});
});
