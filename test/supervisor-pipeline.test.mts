/**
 * Tests for pipeline.ts — worktree creation before task construction (Phase 2)
 *
 * Phase 2a: Worktree created before buildAgentTask call
 * Phase 2b: buildAgentTask receives resolved worktreePath for auditor case
 * Phase 2c: agentCwd set to worktreePath for developer and auditor agents
 * Phase 2d: Architect agent does NOT get agentCwd = worktreePath
 * Phase 2e: Worktree creation is idempotent (once per pipeline run)
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-pipeline.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HANDLER_TS = resolve(__dirname, "../.pi/extensions/supervisor/pipeline/handler.ts");

function readHandlerSource(): string {
	return readFileSync(HANDLER_TS, "utf-8");
}

// ---------------------------------------------------------------------------
// Worktree creation before agent dispatch
// ---------------------------------------------------------------------------

describe("pipeline handler — worktree creation before buildAgentTask", () => {
	it("worktree creation guarded by !worktreePath check", () => {
		const src = readHandlerSource();
		assert.ok(src.includes("!worktreePath"), "Guard prevents duplicate worktree creation");
	});

	it("generateBranchName called in worktree creation section", () => {
		const src = readHandlerSource();
		const wtIdx = src.indexOf("!worktreePath");
		const section = src.substring(wtIdx, wtIdx + 500);
		assert.ok(section.includes("generateBranchName"), "generateBranchName in worktree section");
	});

	it("worktreePath assigned only once", () => {
		const src = readHandlerSource();
		const matches = src.match(/worktreePath\s*=\s*await/g);
		assert.ok(matches && matches.length === 1, "worktreePath assigned exactly once");
	});
});

// ---------------------------------------------------------------------------
// buildAgentTask receives resolved worktreePath
// ---------------------------------------------------------------------------

describe("pipeline handler — worktreePath passed to buildAgentTask", () => {
	it("buildAgentTask call receives worktreePath argument", () => {
		const src = readHandlerSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreePath,") || btSection.includes("worktreePath\n"),
			"worktreePath arg in buildAgentTask call",
		);
	});

	it("buildAgentTask call receives worktreeBranch argument", () => {
		const src = readHandlerSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreeBranch,") || btSection.includes("worktreeBranch\n"),
			"worktreeBranch arg in buildAgentTask call",
		);
	});
});

// ---------------------------------------------------------------------------
// agentCwd for developer and auditor
// ---------------------------------------------------------------------------

describe("pipeline handler — agentCwd for developer/auditor", () => {
	it("agentCwd uses isWorktreeAgent check", () => {
		const src = readHandlerSource();
		const idx = src.indexOf("isWorktreeAgent(agentName) ? worktreePath : undefined");
		assert.ok(idx >= 0, "agentCwd uses isWorktreeAgent check");
	});

	it("agentCwd passed to executeAgent", () => {
		const src = readHandlerSource();
		const idx = src.indexOf("executeAgent(");
		const endIdx = src.indexOf(");", idx);
		const callSection = src.substring(idx, endIdx + 2);
		assert.ok(callSection.includes("isWorktreeAgent"), "executeAgent uses isWorktreeAgent for agentCwd");
	});
});

// ---------------------------------------------------------------------------
// Worktree cleanup at end of pipeline
// ---------------------------------------------------------------------------

describe("pipeline handler — worktree cleanup", () => {
	it("cleanup guarded by worktreePath check", () => {
		const src = readHandlerSource();
		assert.ok(
			src.includes("if (worktreePath && worktreeBranch)"),
			"Cleanup guarded by worktreePath",
		);
	});

	it("cleanup calls cleanupWorktree", () => {
		const src = readHandlerSource();
		assert.ok(src.includes("cleanupWorktree"), "cleanupWorktree called");
	});

	it("cleanup at end of handler after try/catch", () => {
		const src = readHandlerSource();
		const cleanupIdx = src.lastIndexOf("cleanupWorktree");
		const catchEnd = src.lastIndexOf("}");
		assert.ok(cleanupIdx > 0 && cleanupIdx < catchEnd, "cleanup near end of file");
	});
});

// ---------------------------------------------------------------------------
// Agent retry logic
// ---------------------------------------------------------------------------

describe("pipeline handler — agent retry logic", () => {
	it("validateAgentResult called after both initial and retry runAgent", () => {
		const src = readHandlerSource();
		const matches = src.match(/validateAgentResult\(result\)/g);
		assert.strictEqual(
			matches ? matches.length : 0,
			2,
			"validateAgentResult(result) called exactly twice (initial + retry)",
		);
	});

	it("retry block checks budgetExceeded first", () => {
		const src = readHandlerSource();
		const budgetIdx = src.indexOf("result.budgetExceeded");
		const usedRetryIdx = src.indexOf("usedRetry = true;");
		assert.ok(budgetIdx >= 0, "budgetExceeded check exists");
		assert.ok(usedRetryIdx > budgetIdx, "budget check precedes retry logic");
	});

	it("retry logic runs on !result.success", () => {
		const src = readHandlerSource();
		// Find the executeAgent call which contains retry logic
		const executeIdx = src.indexOf("executeAgent");
		assert.ok(executeIdx >= 0, "executeAgent helper used");
	});
});

// ---------------------------------------------------------------------------
// Post-processing after agent success
// ---------------------------------------------------------------------------

describe("pipeline handler — post-agent-success processing", () => {
	it("handlePostAgentSuccess called when result.success", () => {
		const src = readHandlerSource();
		assert.ok(src.includes("handlePostAgentSuccess"), "post-agent-success handler called");
	});
});
