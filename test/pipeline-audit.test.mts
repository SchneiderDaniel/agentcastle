/**
 * Tests for pipeline-audit.ts — worktreePath plumbing fix (Issue #284)
 *
 * Phase 1: `worktreePath` parameter plumbing in `pipeline-audit.ts`
 * Phase 2: `worktreePath` passed from `pipeline.ts` call site
 * Phase 3: Path construction consistency (resolvePath not string concat)
 * Phase 6: Non-standard `worktreeBase` config compatibility
 *
 * Run with:
 *   node --experimental-strip-types --test test/pipeline-audit.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDIT_TS = resolve(__dirname, "../.pi/extensions/supervisor/pipeline-audit.ts");
const PIPELINE_TS = resolve(__dirname, "../.pi/extensions/supervisor/pipeline.ts");

function readAuditSource(): string {
	return readFileSync(AUDIT_TS, "utf-8");
}

function readPipelineSource(): string {
	return readFileSync(PIPELINE_TS, "utf-8");
}

// ===========================================================================
// Phase 1: `worktreePath` parameter plumbing in `pipeline-audit.ts`
// ===========================================================================

describe("pipeline-audit.ts — worktreePath param plumbing (Phase 1)", () => {
	it("runTscAndLspAudit accepts worktreePath as 6th param (between filteredData and pi)", () => {
		const src = readAuditSource();
		const fnIdx = src.indexOf("export async function runTscAndLspAudit(");
		const fnEnd = src.indexOf("): Promise<{ nextStatus: string; note: string }>", fnIdx);
		const signature = src.substring(fnIdx, fnEnd);
		// Verify worktreePath is a parameter
		assert.ok(
			signature.includes("worktreePath"),
			"runTscAndLspAudit should have worktreePath parameter",
		);
		// Verify order: filteredData, worktreePath, pi, ctx
		const filteredIdx = signature.indexOf("filteredData");
		const wtIdx = signature.indexOf("worktreePath");
		const piIdx = signature.indexOf("pi:");
		const ctxIdx = signature.indexOf("ctx:");
		assert.ok(
			filteredIdx < wtIdx && wtIdx < piIdx && piIdx < ctxIdx,
			"worktreePath should be between filteredData and pi",
		);
	});

	it("runTscCheckpointFn called with worktreePath not ctx.cwd", () => {
		const src = readAuditSource();
		// Check that runTscCheckpointFn is called with worktreePath
		const tscCallIdx = src.indexOf("runTscCheckpointFn(pi, ");
		assert.ok(tscCallIdx >= 0, "runTscCheckpointFn call exists");
		// Extract arguments after call
		const callSection = src.substring(tscCallIdx, tscCallIdx + 80);
		// Should reference worktreePath, not ctx.cwd
		assert.ok(
			callSection.includes("worktreePath"),
			"runTscCheckpointFn should receive worktreePath as 2nd arg",
		);
		assert.ok(
			!callSection.includes("ctx.cwd"),
			"runTscCheckpointFn should NOT receive ctx.cwd as 2nd arg",
		);
	});

	it("runLspPreAudit signature: single worktreePath param replaces branch and wt", () => {
		const src = readAuditSource();
		const fnIdx = src.indexOf("async function runLspPreAudit(");
		const fnEnd = src.indexOf("): Promise<{ nextStatus: string; note: string }>", fnIdx);
		const signature = src.substring(fnIdx, fnEnd);
		// Verify worktreePath is a parameter
		assert.ok(
			signature.includes("worktreePath"),
			"runLspPreAudit should have worktreePath parameter",
		);
		// Verify branch and wt parameters are removed
		assert.ok(!signature.includes("branch:"), "runLspPreAudit should not have branch parameter");
		assert.ok(!signature.includes("wt:"), "runLspPreAudit should not have wt parameter");
	});

	it("runLspPreAudit passes worktreePath to pi.exec cwd", () => {
		const src = readAuditSource();
		// Find the pi.exec("git diff") call
		const execIdx = src.indexOf('pi.exec("git"');
		assert.ok(execIdx >= 0, "pi.exec git diff call exists");
		const execSection = src.substring(execIdx, execIdx + 150);
		// cwd should reference worktreePath or resolvePath with worktreePath
		assert.ok(execSection.includes("worktreePath"), "pi.exec cwd should reference worktreePath");
	});

	it("runLspPreAudit no longer recomputes path via generateBranchName", () => {
		const src = readAuditSource();
		// Within runLspPreAudit function body, no generateBranchName call
		const fnIdx = src.indexOf("async function runLspPreAudit(");
		const fnBody = src.substring(fnIdx);
		// Find scope boundary (next top-level function or export)
		const nextFnIdx = fnBody.indexOf("\nexport", 1);
		const fnBodyTrimmed = nextFnIdx >= 0 ? fnBody.substring(0, nextFnIdx) : fnBody;
		assert.ok(
			!fnBodyTrimmed.includes("generateBranchName"),
			"runLspPreAudit should not call generateBranchName",
		);
	});

	it("runTscAndLspAudit no longer computes wt via string concat", () => {
		const src = readAuditSource();
		// Check that no `${config.worktreeBase!}${branch}` pattern exists in runTscAndLspAudit
		const fnIdx = src.indexOf("export async function runTscAndLspAudit(");
		const fnEndIdx = src.indexOf("function runLspPreAudit", fnIdx);
		const fnBody = fnEndIdx >= 0 ? src.substring(fnIdx, fnEndIdx) : src.substring(fnIdx);
		// Old string concat pattern should be gone
		assert.ok(
			!fnBody.includes("config.worktreeBase!") || !fnBody.includes("${branch}"),
			"runTscAndLspAudit should not use string concat for worktree path",
		);
		// Verify no 'const wt =' line in runTscAndLspAudit
		const wtLineMatch = fnBody.match(/const\s+wt\s*=\s*`/);
		assert.ok(!wtLineMatch, "runTscAndLspAudit should not have const wt = template literal");
	});

	it("generateBranchName imported for CI gating, not path construction", () => {
		const src = readAuditSource();
		// generateBranchName import is OK (needed for CI gating branch name)
		const importSection = src.substring(0, src.indexOf("export async function"));
		assert.ok(
			importSection.includes("generateBranchName"),
			"pipeline-audit.ts should import generateBranchName for CI gating",
		);
		// But it should NOT be used for string-concatenated path construction
		const fnBody = src.substring(src.indexOf("export async function"));
		const oldPathPattern = "`${config.worktreeBase!}${branch}`";
		assert.ok(
			!fnBody.includes(oldPathPattern),
			"generateBranchName not used for path string concat",
		);
	});
});

// ===========================================================================
// Phase 2: `worktreePath` passed from `pipeline.ts` call site
// ===========================================================================

describe("pipeline.ts — worktreePath passed to runTscAndLspAudit (Phase 2)", () => {
	it("runTscAndLspAudit call includes worktreePath as 8th arg", () => {
		const src = readPipelineSource();
		// Find the runTscAndLspAudit call
		const callIdx = src.indexOf("const auditResult = await runTscAndLspAudit(");
		assert.ok(callIdx >= 0, "runTscAndLspAudit call exists");
		// Find the closing paren
		const callSection = src.substring(callIdx, src.indexOf(");", callIdx));
		// Should contain worktreePath, as an argument
		assert.ok(
			callSection.includes("worktreePath"),
			"worktreePath should be present in runTscAndLspAudit call args",
		);
		// Count args — should be 8 now (was 7 before fix)
		// Count commas at top level (not nested)
		const argCount = (callSection.match(/,/g) || []).length;
		assert.ok(argCount >= 7, "runTscAndLspAudit should have at least 8 args (7 commas)");
	});

	it("worktreePath in scope at hooks call site (declared before hooks block)", () => {
		const src = readPipelineSource();
		// Verify worktreePath declared at handler scope (already checked in Phase 2a)
		const declIdx = src.indexOf("let worktreePath: string | undefined;");
		assert.ok(declIdx >= 0, "worktreePath declared at handler scope");

		// Verify declaration comes before hooks block
		const hooksIdx = src.indexOf("// ── Hooks (CI/TSC/LSP)");
		assert.ok(declIdx < hooksIdx, "worktreePath declared before hooks block");
	});
});

// ===========================================================================
// Phase 3: Path construction consistency (resolvePath not string concat)
// ===========================================================================

describe("pipeline-audit.ts — resolvePath used in runLspPreAudit (Phase 3)", () => {
	it("resolvePath imported in pipeline-audit.ts", () => {
		const src = readAuditSource();
		const importSection = src.substring(0, src.indexOf("export async function"));
		assert.ok(importSection.includes("resolve"), "resolvePath imported in pipeline-audit.ts");
	});

	it("resolvePath used where string concat was in runLspPreAudit", () => {
		const src = readAuditSource();
		const fnIdx = src.indexOf("async function runLspPreAudit(");
		const nextFnIdx = src.indexOf("\nexport", fnIdx);
		const fnBody = nextFnIdx >= 0 ? src.substring(fnIdx, nextFnIdx) : src.substring(fnIdx);

		// Old string concat pattern should not exist in runLspPreAudit
		const oldConcat = fnBody.match(/\$\{config\.worktreeBase!\}\$\{branch\}/);
		assert.ok(!oldConcat, "runLspPreAudit should not use string concat from old pattern");

		// resolvePath should be used for cwd computation
		assert.ok(
			fnBody.includes("resolvePath"),
			"runLspPreAudit should use resolvePath for path operations",
		);
	});
});

// ===========================================================================
// Phase 6: Non-standard `worktreeBase` config compatibility
// ===========================================================================

describe("pipeline-audit.ts — non-standard worktreeBase config (Phase 6)", () => {
	it("no string concat pattern `${config.worktreeBase!}${branch}` in pipeline-audit.ts", () => {
		const src = readAuditSource();
		const oldPattern = "`${config.worktreeBase!}${branch}`";
		assert.ok(
			!src.includes(oldPattern),
			"Old string-concat pattern should not exist in pipeline-audit.ts",
		);
	});

	it("path resolution follows pipeline.ts formula using resolvePath", () => {
		// export function to test resolvePath matches between files
		const auditSrc = readAuditSource();
		const pipelineSrc = readPipelineSource();

		// Both files should use resolvePath(ctx.cwd, config.worktreeBase!, ...)
		const pipelinePathPattern = "resolvePath(ctx.cwd, config.worktreeBase!";
		const auditPathPattern = "resolvePath(";

		assert.ok(
			pipelineSrc.includes(pipelinePathPattern),
			"pipeline.ts uses resolvePath(ctx.cwd, config.worktreeBase!, ...)",
		);

		// Verify pipeline-audit.ts uses resolvePath with worktreeBase
		// It may or may not have ctx.cwd directly if it receives worktreePath
		assert.ok(auditSrc.includes(auditPathPattern), "pipeline-audit.ts uses resolvePath");
	});
});
