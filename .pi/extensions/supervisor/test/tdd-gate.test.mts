/**
 * Tests for checks/tdd-gate.ts — deterministic TDD verification gate
 *
 * Pure function tests for TddGateResult/TddCheck interfaces, file
 * classification logic, and runTddGate orchestration.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/tdd-gate.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import {
	type TddGateResult,
	type TddCheck,
	type ExecFn,
	isTestFile,
	classifyChangedFiles,
	buildTddGateResult,
	runTddGate,
} from "../checks/tdd-gate.ts";

// ═══════════════════════════════════════════════════════════════════════
// Domain: TddGateResult interface
// ═══════════════════════════════════════════════════════════════════════

describe("TddGateResult interface", () => {
	it("status field accepts all 3 literal string values", () => {
		const passed: TddGateResult = {
			status: "passed",
			checks: [],
		};
		const failed: TddGateResult = {
			status: "failed",
			checks: [],
			rejectionReason: "Tests not written",
		};
		const error: TddGateResult = {
			status: "error",
			checks: [],
			rejectionReason: "No checks run",
		};

		assert.equal(passed.status, "passed");
		assert.equal(failed.status, "failed");
		assert.equal(error.status, "error");
	});

	it("accepts checks array with TddCheck items", () => {
		const result: TddGateResult = {
			status: "failed",
			checks: [
				{ name: "tests-written", passed: false, detail: "No test files found in diff" },
				{ name: "test-fail-first", passed: true },
				{ name: "tests-reference-implementation", passed: true },
			],
			rejectionReason: "Tests not written",
		};

		assert.equal(result.checks.length, 3);
		assert.equal(result.checks[0]!.name, "tests-written");
		assert.equal(result.checks[0]!.passed, false);
		assert.equal(result.checks[0]!.detail, "No test files found in diff");
		assert.equal(result.checks[1]!.name, "test-fail-first");
		assert.equal(result.checks[1]!.passed, true);
		assert.equal(result.checks[2]!.name, "tests-reference-implementation");
		assert.equal(result.checks[2]!.passed, true);
	});

	it("rejectionReason is optional", () => {
		const passed: TddGateResult = { status: "passed", checks: [] };
		assert.equal(passed.rejectionReason, undefined);

		const failed: TddGateResult = {
			status: "failed",
			checks: [{ name: "tests-written", passed: false }],
		};
		assert.equal(failed.rejectionReason, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: TddCheck interface
// ═══════════════════════════════════════════════════════════════════════

describe("TddCheck interface", () => {
	it("name field accepts all 3 literal string values", () => {
		const written: TddCheck = { name: "tests-written", passed: true };
		const failFirst: TddCheck = { name: "test-fail-first", passed: true };
		const reference: TddCheck = { name: "tests-reference-implementation", passed: true };

		assert.equal(written.name, "tests-written");
		assert.equal(failFirst.name, "test-fail-first");
		assert.equal(reference.name, "tests-reference-implementation");
	});

	it("detail field is optional", () => {
		const withDetail: TddCheck = {
			name: "tests-written",
			passed: false,
			detail: "No test files found",
		};
		const without: TddCheck = { name: "tests-written", passed: true };

		assert.equal(withDetail.detail, "No test files found");
		assert.equal(without.detail, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: isTestFile
// ═══════════════════════════════════════════════════════════════════════

describe("isTestFile()", () => {
	it("classifies .test.ts files as test files", () => {
		assert.equal(isTestFile("src/foo.test.ts"), true);
	});

	it("classifies .test.mts files as test files", () => {
		assert.equal(isTestFile("src/foo.test.mts"), true);
	});

	it("classifies .spec.ts files as test files", () => {
		assert.equal(isTestFile("src/foo.spec.ts"), true);
	});

	it("classifies test_*.py files as test files", () => {
		assert.equal(isTestFile("tests/test_foo.py"), true);
	});

	it("classifies *_test.go files as test files", () => {
		assert.equal(isTestFile("src/foo_test.go"), true);
	});

	it("classifies __tests__ subdirectory files as test files", () => {
		assert.equal(isTestFile("__tests__/foo.ts"), true);
		assert.equal(isTestFile("src/__tests__/foo.test.ts"), true);
	});

	it("rejects .test. with no extension after (edge case)", () => {
		assert.equal(isTestFile("src/.test."), false);
	});

	it("rejects test.ts (no .test. prefix — just a .ts file named test)", () => {
		assert.equal(isTestFile("test.ts"), false);
	});

	it("rejects paths with .test. in directory name", () => {
		assert.equal(isTestFile("src/.test.index/foo.ts"), false);
	});

	it("classifies plain .ts files as implementation", () => {
		assert.equal(isTestFile("src/foo.ts"), false);
	});

	it("classifies .tsx files as implementation", () => {
		assert.equal(isTestFile("src/foo.tsx"), false);
	});

	it("classifies .js files as implementation", () => {
		assert.equal(isTestFile("src/foo.js"), false);
	});

	it("classifies .py files (non-test pattern) as implementation", () => {
		assert.equal(isTestFile("src/foo.py"), false);
	});

	it("classifies .go files (non-test pattern) as implementation", () => {
		assert.equal(isTestFile("src/foo.go"), false);
	});

	it("classifies directory-only paths without file extension as implementation", () => {
		assert.equal(isTestFile("some/dir/"), false);
	});

	it("rejects empty string", () => {
		assert.equal(isTestFile(""), false);
	});

	it("handles .mts files with test pattern in parent dir only", () => {
		assert.equal(isTestFile("src/test-helpers/util.mts"), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: classifyChangedFiles
// ═══════════════════════════════════════════════════════════════════════

describe("classifyChangedFiles()", () => {
	it("classifies mixed test and implementation files", () => {
		const files = ["src/foo.ts", "src/foo.test.ts", "src/bar.ts", "src/bar.spec.ts"];
		const result = classifyChangedFiles(files);
		assert.deepEqual(result.testFiles, ["src/foo.test.ts", "src/bar.spec.ts"]);
		assert.deepEqual(result.implFiles, ["src/foo.ts", "src/bar.ts"]);
	});

	it("returns empty arrays when no files match either category", () => {
		const result = classifyChangedFiles([".gitkeep", "Makefile"]);
		assert.deepEqual(result.testFiles, []);
		assert.deepEqual(result.implFiles, []);
	});

	it("returns empty arrays for empty input", () => {
		const result = classifyChangedFiles([]);
		assert.deepEqual(result.testFiles, []);
		assert.deepEqual(result.implFiles, []);
	});

	it("classifies only test files when no implementation files present", () => {
		const result = classifyChangedFiles(["src/foo.test.ts", "src/bar.spec.ts"]);
		assert.deepEqual(result.testFiles, ["src/foo.test.ts", "src/bar.spec.ts"]);
		assert.deepEqual(result.implFiles, []);
	});

	it("classifies only implementation files when no test files present", () => {
		const result = classifyChangedFiles(["src/foo.ts", "src/bar.tsx"]);
		assert.deepEqual(result.testFiles, []);
		assert.deepEqual(result.implFiles, ["src/foo.ts", "src/bar.tsx"]);
	});

	it("classifies __tests__ files as tests", () => {
		const result = classifyChangedFiles(["__tests__/foo.ts", "src/impl.ts"]);
		assert.deepEqual(result.testFiles, ["__tests__/foo.ts"]);
		assert.deepEqual(result.implFiles, ["src/impl.ts"]);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: buildTddGateResult
// ═══════════════════════════════════════════════════════════════════════

describe("buildTddGateResult()", () => {
	it("returns passed when all checks pass", () => {
		const checks: TddCheck[] = [
			{ name: "tests-written", passed: true },
			{ name: "test-fail-first", passed: true },
			{ name: "tests-reference-implementation", passed: true },
		];
		const result = buildTddGateResult(checks);
		assert.equal(result.status, "passed");
		assert.equal(result.checks.length, 3);
		assert.equal(result.rejectionReason, undefined);
	});

	it("returns failed when any check fails", () => {
		const checks: TddCheck[] = [
			{ name: "tests-written", passed: true },
			{
				name: "test-fail-first",
				passed: false,
				detail: "Tests passed after reverting implementation",
			},
			{ name: "tests-reference-implementation", passed: true },
		];
		const result = buildTddGateResult(checks);
		assert.equal(result.status, "failed");
		assert.ok(result.rejectionReason!.includes("test-fail-first"));
	});

	it("returns failed with multiple failing check names in reason", () => {
		const checks: TddCheck[] = [
			{ name: "tests-written", passed: false, detail: "No test files found" },
			{ name: "test-fail-first", passed: true },
			{ name: "tests-reference-implementation", passed: false, detail: "No imports from impl" },
		];
		const result = buildTddGateResult(checks);
		assert.equal(result.status, "failed");
		assert.ok(result.rejectionReason!.includes("tests-written"));
		assert.ok(result.rejectionReason!.includes("tests-reference-implementation"));
	});

	it("returns error for empty checks array", () => {
		const result = buildTddGateResult([]);
		assert.equal(result.status, "error");
		assert.equal(result.checks.length, 0);
		assert.equal(result.rejectionReason, "No checks run");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Use-case: runTddGate (with mocked exec)
// ═══════════════════════════════════════════════════════════════════════

interface ExecCall {
	cmd: string;
	args: string[];
	opts?: Record<string, unknown>;
}

/**
 * Create a mock exec function that returns pre-configured results.
 */

function createMockExec(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
	delayMs?: number,
): ExecFn {
	const callLog = calls || [];
	let idx = 0;
	return async (cmd, args, opts) => {
		callLog.push({ cmd, args: args || [], opts });
		const r = results[idx] || { code: 0, stdout: "", stderr: "" };
		idx++;
		if (delayMs) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		return Promise.resolve(r);
	};
}

describe("runTddGate()", () => {
	it("calls git diff <defaultBranch> --name-only with cwd=worktreePath", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[{ code: 0, stdout: "src/foo.ts\nsrc/foo.test.ts", stderr: "" }],
			calls,
		);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");

		const gitDiffCall = calls.find((c) => c.cmd === "git" && c.args[0] === "diff");
		assert.ok(gitDiffCall, "should call git diff");
		assert.ok(gitDiffCall!.args.includes("main"), "should diff against default branch");
		assert.ok(gitDiffCall!.args.includes("--name-only"), "should use --name-only");
		assert.equal(gitDiffCall!.opts?.cwd, "/repo/worktree");
	});

	it("returns error status when git diff fails (non-zero exit)", async () => {
		const mockExec = createMockExec([
			{ code: 128, stdout: "", stderr: "fatal: not a git repository" },
		]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "error");
		assert.equal(result.checks.length, 0);
		assert.ok(result.rejectionReason!.includes("fatal: not a git repository"));
	});

	it("returns passed when no changed files detected (empty diff)", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "", stderr: "" }]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "passed");
		assert.equal(result.checks.length, 1);
		assert.equal(result.checks[0]!.name, "tests-written");
		assert.equal(result.checks[0]!.passed, true);
		assert.equal(result.checks[0]!.detail, "No changed files — nothing to verify");
	});

	it("classifies changed files — test file detected", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec(
			[{ code: 0, stdout: "src/foo.test.ts\nsrc/impl.ts", stderr: "" }],
			calls,
		);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		assert.equal(result.checks.length, 3);
		// tests-written should pass because we have a test file
		const writtenCheck = result.checks.find((c) => c.name === "tests-written");
		assert.ok(writtenCheck, "tests-written check should exist");
		assert.equal(writtenCheck!.passed, true);
	});

	it("check 'tests-written' passes when at least one test file is in the diff", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/foo.test.ts\nsrc/impl.ts", stderr: "" },
		]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const writtenCheck = result.checks.find((c) => c.name === "tests-written");
		assert.equal(writtenCheck!.passed, true);
	});

	it("check 'tests-written' fails when no test files are in the diff", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "src/impl.ts\nsrc/util.ts", stderr: "" }]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const writtenCheck = result.checks.find((c) => c.name === "tests-written");
		assert.equal(writtenCheck!.passed, false);
		assert.ok(writtenCheck!.detail!.includes("No test files found"));
	});

	it("check 'tests-written' passes when test files but no impl files exist", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/foo.test.ts\nsrc/bar.spec.ts", stderr: "" },
		]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const writtenCheck = result.checks.find((c) => c.name === "tests-written");
		assert.equal(writtenCheck!.passed, true);
	});

	it("check 'test-fail-first' passes when tests fail after reverting implementation", async () => {
		const calls: ExecCall[] = [];
		const mockExec: ExecFn = async (cmd, args, opts) => {
			calls.push({ cmd, args: args || [], opts });
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "src/impl.ts\nsrc/impl.test.ts", stderr: "" };
			}
			if (cmd === "git" && args[0] === "checkout") {
				// Revert or restore implementation files
				return { code: 0, stdout: "", stderr: "" };
			}
			// Test runner detection: find command returns test files
			if (cmd === "find") {
				return { code: 0, stdout: "/repo/worktree/src/impl.test.ts", stderr: "" };
			}
			// Test runner detection: which command fails (we'll use node --test)
			if (cmd === "which") {
				return { code: 1, stdout: "", stderr: "not found" };
			}
			// Test runner — tests fail because impl is reverted
			if (cmd === "node" && args[0] === "--experimental-strip-types") {
				return { code: 1, stdout: "FAIL: test failed", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const failFirstCheck = result.checks.find((c) => c.name === "test-fail-first");
		assert.equal(failFirstCheck!.passed, true);
	});

	it("check 'test-fail-first' fails when tests pass after reverting implementation", async () => {
		const calls: ExecCall[] = [];
		const mockExec: ExecFn = async (cmd, args, opts) => {
			calls.push({ cmd, args: args || [], opts });
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "src/impl.ts\nsrc/impl.test.ts", stderr: "" };
			}
			if (cmd === "git" && args[0] === "checkout" && args.includes("--")) {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "node" && args.some((a) => a.endsWith(".mts") || a.endsWith(".test.ts"))) {
				// Tests pass even without impl — tautological tests!
				return { code: 0, stdout: "PASS: all tests passed", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const failFirstCheck = result.checks.find((c) => c.name === "test-fail-first");
		assert.equal(failFirstCheck!.passed, false);
		assert.ok(failFirstCheck!.detail!.includes("Tests passed"));
	});

	it("check 'test-fail-first' skips when no implementation files exist (no impl to revert)", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "src/foo.test.ts\n", stderr: "" }]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const failFirstCheck = result.checks.find((c) => c.name === "test-fail-first");
		assert.equal(failFirstCheck!.passed, true);
		assert.ok(failFirstCheck!.detail!.includes("No implementation files"));
	});

	it("check 'tests-reference-implementation' passes when test files reference new code", async () => {
		const calls: ExecCall[] = [];
		const mockExec: ExecFn = async (cmd, args, opts) => {
			calls.push({ cmd, args: args || [], opts });
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "src/impl.ts\nsrc/impl.test.ts", stderr: "" };
			}
			if (cmd === "git" && args[0] === "checkout") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// Test runner detection: find command returns nothing (no test files found via find)
			if (cmd === "find") {
				return { code: 0, stdout: "", stderr: "" };
			}
			// Test runner detection: which command fails
			if (cmd === "which") {
				return { code: 1, stdout: "", stderr: "not found" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const testDir = join(process.cwd(), "ignore/tdd-gate-ref-test");
		const implFile = join(testDir, "src/impl.ts");
		const testFile = join(testDir, "src/impl.test.ts");
		mkdirSync(dirname(implFile), { recursive: true });
		writeFileSync(implFile, "export function newFeature() { return 42; }");
		writeFileSync(
			testFile,
			"import { newFeature } from './impl'; describe('newFeature', () => { it('works', () => { assert.equal(newFeature(), 42); }); });",
		);

		const result = await runTddGate(mockExec, testDir, "main");

		// Cleanup
		rmSync(testDir, { recursive: true, force: true });

		const referenceCheck = result.checks.find((c) => c.name === "tests-reference-implementation");
		assert.equal(referenceCheck!.passed, true);
	});

	it("check 'tests-reference-implementation' passes when no test files exist", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "src/impl.ts", stderr: "" }]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const writtenCheck = result.checks.find((c) => c.name === "tests-written");
		assert.equal(writtenCheck!.passed, false);
		const referenceCheck = result.checks.find((c) => c.name === "tests-reference-implementation");
		assert.equal(referenceCheck!.passed, true);
		assert.ok(referenceCheck!.detail!.includes("No test files"));
	});

	it("returns passed when only test files changed (no impl to verify)", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/foo.test.ts\nsrc/bar.spec.ts", stderr: "" },
		]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");

		// With only test files and no impl, tests-written passes,
		// test-fail-first is skipped (no impl), tests-reference-implementation is skipped (no impl)
		assert.equal(result.status, "passed");
	});

	it("returns error result if exec throws unexpectedly", async () => {
		const mockExec: ExecFn = async (_cmd: string) => {
			throw new Error("Unexpected exec error");
		};

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		assert.equal(result.status, "error");
		assert.ok(result.rejectionReason!.includes("Unexpected exec error"));
	});

	it("uses provided default branch, not hardcoded", async () => {
		const calls: ExecCall[] = [];
		const mockExec = createMockExec([{ code: 0, stdout: "", stderr: "" }], calls);

		await runTddGate(mockExec, "/repo/worktree", "develop");
		const gitDiffCall = calls.find((c) => c.cmd === "git" && c.args[0] === "diff");
		assert.ok(gitDiffCall!.args.includes("develop"), "should use provided branch");
	});

	it("check 'test-fail-first' reverts using <defaultBranch> not HEAD (critical fix)", async () => {
		// This test verifies the critical bug fix: checkTestFailFirst must use
		// git checkout <defaultBranch> -- ... (not HEAD) so implementation is
		// actually reverted to the base branch version.
		const checkoutCalls: Array<{ args: string[] }> = [];
		const mockExec: ExecFn = async (cmd, args, _opts) => {
			if (cmd === "git" && args[0] === "checkout") {
				checkoutCalls.push({ args });
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "src/impl.ts\nsrc/impl.test.ts", stderr: "" };
			}
			if (cmd === "find") {
				return { code: 0, stdout: "/repo/worktree/src/impl.test.ts", stderr: "" };
			}
			if (cmd === "which") {
				return { code: 1, stdout: "", stderr: "not found" };
			}
			if (cmd === "node" && args[0] === "--experimental-strip-types") {
				return { code: 1, stdout: "FAIL", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		await runTddGate(mockExec, "/repo/worktree", "develop");

		// First checkout should be revert using defaultBranch (develop, not HEAD)
		const revertCall = checkoutCalls[0];
		assert.ok(revertCall, "should call git checkout for revert");
		assert.ok(revertCall!.args.includes("develop"), "revert should use defaultBranch (develop)");
		assert.ok(revertCall!.args.includes("--"), "revert should include -- separator");
		assert.ok(revertCall!.args.includes("src/impl.ts"), "revert should include impl file");
		assert.ok(!revertCall!.args.includes("HEAD"), "revert should NOT use HEAD");

		// Second checkout should be restore using HEAD
		const restoreCall = checkoutCalls[1];
		assert.ok(restoreCall, "should call git checkout for restore");
		assert.ok(restoreCall!.args.includes("HEAD"), "restore should use HEAD");
		assert.ok(restoreCall!.args.includes("--"), "restore should include -- separator");
	});

	it("check 'test-fail-first' restore uses HEAD not index (critical fix)", async () => {
		// After git checkout <defaultBranch> -- files, the index contains the
		// base branch version. The restore must use git checkout HEAD -- files
		// (from HEAD commit), not git checkout -- files (from index).
		const checkoutCalls: Array<{ args: string[] }> = [];
		const mockExec: ExecFn = async (cmd, args, _opts) => {
			if (cmd === "git" && args[0] === "checkout") {
				checkoutCalls.push({ args });
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "src/impl.ts\nsrc/impl.test.ts", stderr: "" };
			}
			if (cmd === "find") {
				return { code: 0, stdout: "/repo/worktree/src/impl.test.ts", stderr: "" };
			}
			if (cmd === "which") {
				return { code: 1, stdout: "", stderr: "not found" };
			}
			if (cmd === "node" && args[0] === "--experimental-strip-types") {
				return { code: 1, stdout: "FAIL", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		await runTddGate(mockExec, "/repo/worktree", "main");

		// First checkout: revert with defaultBranch
		const revertCall = checkoutCalls[0];
		assert.ok(revertCall, "should have revert call");
		assert.ok(revertCall!.args.includes("main"), "revert should use main");

		// Second checkout: restore must explicitly use HEAD
		const restoreCall = checkoutCalls[1];
		assert.ok(restoreCall, "should have restore call");
		assert.ok(
			restoreCall!.args.includes("HEAD"),
			"restore must use 'git checkout HEAD -- files' not 'git checkout -- files'",
		);
		assert.ok(restoreCall!.args.includes("--"), "restore should include --");
		assert.ok(restoreCall!.args.includes("src/impl.ts"), "restore should include impl file");

		// Verify there are exactly 2 checkouts (revert + restore)
		assert.equal(checkoutCalls.length, 2, "should have exactly 2 git checkout calls");
	});
});
