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

const PIPELINE_TS = resolve(__dirname, "../.pi/extensions/supervisor/pipeline.ts");

function readPipelineSource(): string {
	return readFileSync(PIPELINE_TS, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 2a: Worktree created before buildAgentTask
// ---------------------------------------------------------------------------

describe("pipeline.ts — worktree creation before buildAgentTask (Phase 2a)", () => {
	it("Supervisor-owned worktree lifecycle comment before Build task comment", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const buildTaskIdx = src.indexOf("Build task AFTER worktree creation");
		assert.ok(lifecycleIdx >= 0, "Worktree lifecycle comment exists");
		assert.ok(buildTaskIdx >= 0, "Build task comment exists");
		assert.ok(lifecycleIdx < buildTaskIdx, "Worktree lifecycle precedes build task");
	});

	it("generateBranchName called between lifecycle and build-task comments", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const buildTaskIdx = src.indexOf("Build task AFTER worktree creation");
		const section = src.substring(lifecycleIdx, buildTaskIdx);
		assert.ok(section.includes("generateBranchName"), "generateBranchName in worktree section");
	});

	it("git worktree add command present in worktree section", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const buildTaskIdx = src.indexOf("Build task AFTER worktree creation");
		const section = src.substring(lifecycleIdx, buildTaskIdx);
		assert.ok(section.includes("git worktree add"), "git worktree add in worktree section");
	});

	it("worktreePath assigned after git worktree add", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const buildTaskIdx = src.indexOf("Build task AFTER worktree creation");
		const section = src.substring(lifecycleIdx, buildTaskIdx);
		assert.ok(section.includes("worktreePath = wt"), "worktreePath assigned from wt variable");
	});
});

// ---------------------------------------------------------------------------
// Phase 2b: buildAgentTask receives resolved worktreePath
// ---------------------------------------------------------------------------

describe("pipeline.ts — worktreePath passed to buildAgentTask (Phase 2b)", () => {
	it("buildAgentTask call receives worktreePath argument", () => {
		const src = readPipelineSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreePath,") || btSection.includes("worktreePath\n"),
			"worktreePath arg in buildAgentTask call",
		);
	});

	it("buildAgentTask call receives worktreeBranch argument", () => {
		const src = readPipelineSource();
		const btIdx = src.indexOf("const task = buildAgentTask(");
		const btSection = src.substring(btIdx, src.indexOf(");", btIdx) + 10);
		assert.ok(
			btSection.includes("worktreeBranch,") || btSection.includes("worktreeBranch\n"),
			"worktreeBranch arg in buildAgentTask call",
		);
	});

	it("comment documents worktree path embedding purpose", () => {
		const src = readPipelineSource();
		const btIdx = src.indexOf("// Build task AFTER worktree creation");
		const buildTaskEnd = src.indexOf("const task = buildAgentTask(", btIdx);
		const commentSection = src.substring(btIdx, buildTaskEnd);
		assert.ok(
			commentSection.includes("worktreePath") || commentSection.includes("worktree"),
			"Comment explains worktree context embedding",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2c: agentCwd set to worktreePath for developer and auditor
// ---------------------------------------------------------------------------

describe("pipeline.ts — agentCwd for developer/auditor (Phase 2c)", () => {
	it("agentCwd conditional references developer and auditor", () => {
		const src = readPipelineSource();
		const cwdIdx = src.indexOf("// Pass worktree path as cwd");
		const cwdEnd = src.indexOf("runAgent(agent, task", cwdIdx);
		const section = src.substring(cwdIdx, cwdEnd);
		assert.ok(section.includes("developer"), "agentCwd checks for developer");
		assert.ok(section.includes("auditor"), "agentCwd checks for auditor");
		assert.ok(section.includes("worktreePath"), "agentCwd uses worktreePath");
	});

	it("initial runAgent call passes agentCwd", () => {
		const src = readPipelineSource();
		const count = (src.match(/runAgent\(agent, task, ctx, pi, timeoutMs, agentCwd\)/g) || [])
			.length;
		assert.ok(count >= 2, "agentCwd passed to both initial and retry runAgent calls");
	});
});

// ---------------------------------------------------------------------------
// Phase 2d: Architect agent does NOT get agentCwd set to worktree
// ---------------------------------------------------------------------------

describe("pipeline.ts — architect agentCwd unchanged (Phase 2d)", () => {
	it("agentCwd ternary has undefined fallback for non-worktree agents", () => {
		const src = readPipelineSource();
		const cwdIdx = src.indexOf("// Pass worktree path as cwd");
		const cwdEnd = src.indexOf("runAgent(agent, task", cwdIdx);
		const section = src.substring(cwdIdx, cwdEnd);
		assert.ok(
			section.includes("undefined"),
			"agentCwd defaults to undefined for non-developer/auditor agents",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 2e: Worktree creation idempotent
// ---------------------------------------------------------------------------

describe("pipeline.ts — worktree creation idempotent (Phase 2e)", () => {
	it("worktree creation guarded by !worktreePath check", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const buildTaskIdx = src.indexOf("Build task AFTER worktree creation");
		const section = src.substring(lifecycleIdx, buildTaskIdx);
		assert.ok(section.includes("!worktreePath"), "Guard prevents duplicate worktree creation");
	});

	it("worktreePath assigned only once", () => {
		const src = readPipelineSource();
		const matches = src.match(/worktreePath\s*=\s*wt/g);
		assert.ok(matches && matches.length === 1, "worktreePath assigned exactly once");
	});

	it("generateBranchName inside !worktreePath guard", () => {
		const src = readPipelineSource();
		const lifecycleIdx = src.indexOf("Supervisor-owned worktree lifecycle");
		const buildTaskIdx = src.indexOf("Build task AFTER worktree creation");
		const section = src.substring(lifecycleIdx, buildTaskIdx);
		// generateBranchName should be inside the guard (after !worktreePath)
		const guardIdx = section.indexOf("!worktreePath");
		const genIdx = section.indexOf("generateBranchName");
		assert.ok(guardIdx < genIdx, "generateBranchName called inside guard block");
	});
});

// ---------------------------------------------------------------------------
// Phase 2f: Worktree cleanup at end of pipeline
// ---------------------------------------------------------------------------

describe("pipeline.ts — worktree cleanup (Phase 2f)", () => {
	it("worktree cleanup uses git worktree remove --force", () => {
		const src = readPipelineSource();
		const cleanupIdx = src.indexOf("Supervisor-owned worktree cleanup");
		assert.ok(
			src.indexOf("git worktree remove", cleanupIdx) >= 0,
			"git worktree remove in cleanup",
		);
	});

	it("cleanup uses git worktree prune", () => {
		const src = readPipelineSource();
		const cleanupIdx = src.indexOf("Supervisor-owned worktree cleanup");
		assert.ok(src.indexOf("git worktree prune", cleanupIdx) >= 0, "git worktree prune in cleanup");
	});

	it("cleanup guarded by worktreePath check", () => {
		const src = readPipelineSource();
		const cleanupIdx = src.indexOf("Supervisor-owned worktree cleanup");
		const section = src.substring(cleanupIdx);
		assert.ok(section.includes("if (worktreePath)"), "Cleanup guarded by worktreePath");
	});

	it("cleanup deletes branch after worktree removal", () => {
		const src = readPipelineSource();
		const cleanupIdx = src.indexOf("Supervisor-owned worktree cleanup");
		const section = src.substring(cleanupIdx);
		assert.ok(section.includes("git branch -D"), "Branch deletion in cleanup");
	});

	it("cleanup wrapped in try/catch (non-fatal)", () => {
		const src = readPipelineSource();
		const cleanupIdx = src.indexOf("Supervisor-owned worktree cleanup");
		const section = src.substring(cleanupIdx);
		assert.ok(section.includes("try {"), "try block in cleanup");
		assert.ok(section.includes("catch"), "catch in cleanup");
		assert.ok(section.includes("console.warn"), "console.warn in cleanup");
	});
});

// ---------------------------------------------------------------------------
// Phase 2g: PR creation uses worktree branch
// ---------------------------------------------------------------------------

describe("pipeline.ts — PR creation uses worktree branch (Phase 2g)", () => {
	it("PR head uses worktreeBranch", () => {
		const src = readPipelineSource();
		const prIdx = src.indexOf("// ── PR creation");
		const prSection = src.substring(
			prIdx,
			src.indexOf("// ── PR creation", prIdx + 1) >= 0
				? src.indexOf("// ── PR creation", prIdx + 1)
				: prIdx + 2000,
		);
		assert.ok(prSection.includes("worktreeBranch"), "PR creation uses worktreeBranch for head");
	});

	it("PR push section contains git push and worktreePath", () => {
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

// ---------------------------------------------------------------------------
// Issue 299: Retry-success post-processing gate fix
// ---------------------------------------------------------------------------

describe("pipeline.ts — retry-success post-processing (Issue 299)", () => {
	it("removes !usedRetry gate — if (result.success) without && !usedRetry", () => {
		const src = readPipelineSource();
		const idx = src.indexOf("// ── Phase 2: Post issue comments deterministically");
		const section = src.substring(idx, idx + 500);
		assert.ok(section.includes("if (result.success)"), "condition uses if (result.success)");
		assert.ok(
			!section.includes("&& !usedRetry"),
			"!usedRetry gate removed from post-processing condition",
		);
	});

	it("validateAgentResult called after retry runAgent", () => {
		const src = readPipelineSource();
		// Find the retry block: first runAgent call that comes after usedRetry = true
		const retrySectionStart = src.indexOf("usedRetry = true;");
		const retrySectionEnd = src.indexOf("const statusLabel", retrySectionStart);
		const retrySection = src.substring(retrySectionStart, retrySectionEnd);
		assert.ok(
			retrySection.includes("validateAgentResult(result)"),
			"validateAgentResult called after retry runAgent",
		);
	});

	it("two validateAgentResult calls in pipeline loop", () => {
		const src = readPipelineSource();
		// Count validateAgentResult calls in the pipeline loop (after "for (let i = 0;")
		const loopStart = src.indexOf("for (let i = 0; i < MAX_LOOPS; i++)");
		const loopSection = src.substring(loopStart);
		const matches = loopSection.match(/validateAgentResult\(result\)/g);
		assert.strictEqual(
			matches ? matches.length : 0,
			2,
			"validateAgentResult(result) called exactly twice in pipeline loop (initial + retry)",
		);
	});

	it("first validateAgentResult call precedes usedRetry declaration", () => {
		const src = readPipelineSource();
		const loopStart = src.indexOf("for (let i = 0; i < MAX_LOOPS; i++)");
		const loopSection = src.substring(loopStart);
		const firstValidateIdx = loopSection.indexOf("validateAgentResult(result)");
		const usedRetryDeclIdx = loopSection.indexOf("let usedRetry = false;");
		assert.ok(
			firstValidateIdx < usedRetryDeclIdx,
			"first validateAgentResult call precedes let usedRetry declaration",
		);
	});

	it("retry validateAgentResult call is after retry runAgent", () => {
		const src = readPipelineSource();
		const retryIfStart = src.indexOf("if (!result.success)");
		const retrySectionEnd = src.indexOf("const statusLabel", retryIfStart);
		const retrySection = src.substring(retryIfStart, retrySectionEnd);
		// The retry block should have: runAgent(...) then validateAgentResult(result)
		const lastRunAgentIdx = retrySection.lastIndexOf("runAgent(");
		const validateIdx = retrySection.indexOf("validateAgentResult(result)");
		assert.ok(
			lastRunAgentIdx >= 0 && validateIdx >= 0 && lastRunAgentIdx < validateIdx,
			"validateAgentResult called after runAgent in retry block",
		);
	});
});
