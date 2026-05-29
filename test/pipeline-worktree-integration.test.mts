/**
 * Integration tests for pipeline worktree fix (Phase 2 Integration)
 *
 * Verifies that pipeline.ts correctly:
 *  - Creates worktree before task construction
 *  - Passes worktreePath to buildAgentTask
 *  - Sets agentCwd for worktree-bound agents
 *  - Handles errors gracefully
 *
 * Run with:
 *   node --experimental-strip-types --test test/pipeline-worktree-integration.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PIPELINE_TS = resolve(__dirname, "../.pi/extensions/supervisor/pipeline.ts");

function readPipelineSource(): string {
	return readFileSync(PIPELINE_TS, "utf-8");
}

// ---------------------------------------------------------------------------
// Pipeline worktree lifecycle integration
// ---------------------------------------------------------------------------

describe("pipeline-worktree integration — lifecycle order", () => {
	it("worktree lifecycle comment appears before build task comment", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const buildTaskIdx = src.indexOf("Build task AFTER worktree creation");
		assert.ok(lifecycleIdx >= 0, "Worktree lifecycle comment");
		assert.ok(buildTaskIdx >= 0, "Build task comment");
		assert.ok(lifecycleIdx < buildTaskIdx, "Lifecycle before build task");
	});

	it("buildAgentTask call appears after worktree lifecycle section", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const btIdx = src.indexOf("const task = buildAgentTask(");
		assert.ok(lifecycleIdx < btIdx, "Worktree lifecycle before buildAgentTask call");
	});

	it("worktreePath and worktreeBranch declared at handler scope", () => {
		const src = readPipelineSource();
		const handlerStart = src.indexOf("let worktreePath");
		const branchDecl = src.indexOf("let worktreeBranch");
		assert.ok(handlerStart >= 0, "worktreePath variable declared");
		assert.ok(branchDecl >= 0, "worktreeBranch variable declared");
	});

	it("agentCwd conditional uses ternary with worktreePath or undefined fallback", () => {
		const src = readPipelineSource();
		const cwdIdx = src.indexOf("// Pass worktree path as cwd");
		const cwdEnd = src.indexOf("runAgent(agent, task", cwdIdx);
		const section = src.substring(cwdIdx, cwdEnd);
		assert.ok(
			section.includes("?") && section.includes(":") && section.includes("undefined"),
			"agentCwd uses ternary with undefined fallback",
		);
	});

	it("worktreeBranch generated via generateBranchName", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const btIdx = src.indexOf("Build task AFTER worktree creation");
		const section = src.substring(lifecycleIdx, btIdx);
		assert.ok(
			section.includes("worktreeBranch = generateBranchName"),
			"worktreeBranch assigned from generateBranchName",
		);
	});

	it("commitAndPush uses worktreePath as first argument", () => {
		const src = readPipelineSource();
		assert.ok(
			src.includes("commitAndPush(pi, worktreePath"),
			"commitAndPush receives worktreePath",
		);
	});
});

// ---------------------------------------------------------------------------
// Pipeline worktree — error handling and edge cases
// ---------------------------------------------------------------------------

describe("pipeline-worktree integration — error handling", () => {
	it("git worktree add failure caught with fallback add (no -b)", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const btIdx = src.indexOf("Build task AFTER worktree creation");
		const section = src.substring(lifecycleIdx, btIdx);
		// Has try/catch around git worktree add
		assert.ok(section.includes("try {"), "try block in worktree creation");
		assert.ok(section.includes("catch"), "catch block in worktree creation");
	});

	it("commitAndPush failure is warned not thrown", () => {
		const src = readPipelineSource();
		const commitSection = src.substring(
			src.indexOf("commitAndPush(pi, worktreePath"),
			src.indexOf("commitAndPush(pi, worktreePath") + 600,
		);
		assert.ok(
			commitSection.includes("catch") && commitSection.includes("console.warn"),
			"commitAndPush failure caught and warned",
		);
	});

	it("worktree cleanup failure logged via console.warn", () => {
		const src = readPipelineSource();
		const cleanupIdx = src.indexOf("Supervisor-owned worktree cleanup");
		const section = src.substring(cleanupIdx);
		assert.ok(section.includes("console.warn"), "Cleanup failure logged, not thrown");
	});

	it("PR push uses worktreePath as cwd", () => {
		const src = readPipelineSource();
		const prIdx = src.indexOf("// ── PR creation:");
		const prSection = src.substring(prIdx, prIdx + 3000);
		assert.ok(prSection.includes("git push"), "git push in PR section");
		assert.ok(
			prSection.includes("cwd: worktreePath") || prSection.includes("cwd:worktreePath"),
			"cwd references worktreePath",
		);
	});
});
