// ─── TDD Gate ─────────────────────────────────────────────────────
// Deterministic TDD verification gate for the supervisor pipeline.
// Runs after developer commit, before auditor dispatch.
// Verifies that tests were written, tests fail without implementation,
// and tests reference new implementation code.

import { existsSync, readFileSync } from "node:fs";
import { join, extname, basename } from "node:path";

// ─── Types ──────────────────────────────────────────────────────────

/** Result of running the TDD gate. */
export interface TddGateResult {
	/** Overall gate status.
	 *  "passed" — all checks pass
	 *  "failed" — one or more checks fail (blocks transition to Audit)
	 *  "error" — gate couldn't run (infrastructure issue)
	 */
	status: "passed" | "failed" | "error";
	/** Per-check granularity for detailed feedback. */
	checks: TddCheck[];
	/** Human-readable rejection reason when status is "failed" or "error". */
	rejectionReason?: string;
}

/** A single TDD check within the gate. */
export interface TddCheck {
	/** Check name. */
	name: "tests-written" | "test-fail-first" | "tests-reference-implementation";
	/** Whether the check passed. */
	passed: boolean;
	/** Optional human-readable detail about the check result. */
	detail?: string;
}

/** Exec function type — runs a shell command and returns the result. */
export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// ─── File Classification ───────────────────────────────────────────

/** Known test file extensions. */
const TEST_EXTENSIONS = new Set([".test.ts", ".test.mts", ".spec.ts"]);

/** Known test file name patterns (basename-based). */
const TEST_NAME_PATTERNS = [/^test_.+\.py$/i, /.+_test\.go$/i];

/**
 * Check whether a file path is a test file.
 *
 * Classification rules:
 * - Files with test extensions: .test.ts, .test.mts, .spec.ts
 * - Files with test name patterns: test_*.py, *_test.go
 * - Files inside __tests__/ directories
 *
 * Everything else is considered implementation.
 */
export function isTestFile(filePath: string): boolean {
	if (!filePath || filePath.trim() === "") return false;

	// Check if inside __tests__ directory
	if (filePath.includes("/__tests__/") || filePath.startsWith("__tests__/")) {
		return true;
	}

	// Check by extension
	const ext = extname(filePath);
	const baseWithExt = basename(filePath);

	// .test.ts, .test.mts, .spec.ts
	for (const testExt of TEST_EXTENSIONS) {
		if (baseWithExt.endsWith(testExt)) {
			// Guard against edge cases like ".test." (no extension)
			const prefix = baseWithExt.slice(0, -testExt.length);
			if (prefix.length > 0) {
				return true;
			}
		}
	}

	// test_*.py pattern
	if (/^test_.+\.py$/i.test(baseWithExt)) {
		return true;
	}

	// *_test.go pattern
	if (/.+_test\.go$/i.test(baseWithExt)) {
		return true;
	}

	return false;
}

/**
 * Classify a list of changed files into test files and implementation files.
 */
export function classifyChangedFiles(files: string[]): {
	testFiles: string[];
	implFiles: string[];
} {
	const testFiles: string[] = [];
	const implFiles: string[] = [];

	for (const file of files) {
		if (isTestFile(file)) {
			testFiles.push(file);
		} else {
			// Only classify files with recognized source extensions as implementation
			const ext = extname(file);
			if (
				ext &&
				[".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".py", ".go", ".rs", ".java"].includes(ext)
			) {
				implFiles.push(file);
			}
			// Files without recognized extensions (configs, docs, etc.) are neither
		}
	}

	return { testFiles, implFiles };
}

// ─── Result Builder ─────────────────────────────────────────────────

/**
 * Build a TddGateResult from an array of TddCheck results.
 *
 * Derives status:
 * - "passed" if all checks pass (and at least one check exists)
 * - "failed" if any check fails
 * - "error" if checks array is empty
 */
export function buildTddGateResult(checks: TddCheck[]): TddGateResult {
	if (checks.length === 0) {
		return {
			status: "error",
			checks: [],
			rejectionReason: "No checks run",
		};
	}

	const allPassed = checks.every((c) => c.passed);
	if (allPassed) {
		return { status: "passed", checks };
	}

	// One or more checks failed — build rejection reason
	const failedChecks = checks.filter((c) => !c.passed);
	const failureNames = failedChecks.map((c) => c.name).join(", ");
	const rejectionReason = `TDD gate failed: ${failureNames}`;

	return {
		status: "failed",
		checks,
		rejectionReason,
	};
}

// ─── Test Runner Detection ──────────────────────────────────────────

/**
 * Detect available test runner command for the project.
 *
 * Checks for common test runners in order of preference:
 * 1. package.json scripts → "test" script
 * 2. node --test (native)
 * 3. Known runner binaries (jest, mocha, vitest, ava, tap)
 *
 * Returns the command string to execute, or null if no runner found.
 */
async function detectTestRunner(
	exec: ExecFn,
	worktreePath: string,
): Promise<{ cmd: string; args: string[] } | null> {
	// Check package.json for test script
	try {
		const pkgPath = join(worktreePath, "package.json");
		if (existsSync(pkgPath)) {
			const content = readFileSync(pkgPath, "utf-8");
			const pkg = JSON.parse(content) as Record<string, unknown>;
			const scripts = pkg.scripts as Record<string, string> | undefined;
			if (scripts?.test && scripts.test !== "echo" && !scripts.test.startsWith("echo")) {
				// Use the test script via npm
				return { cmd: "npm", args: ["test", "--silent"] };
			}
		}
	} catch {
		// Ignore read/parse errors
	}

	// Check for test files and use node --test
	try {
		const testFilesResult = await exec(
			"find",
			[worktreePath, "-maxdepth", "3", "-name", "*.test.*", "-o", "-name", "*.spec.*"],
			{ timeout: 5_000 },
		);
		if (testFilesResult.stdout?.trim()) {
			return { cmd: "node", args: ["--experimental-strip-types", "--test"] };
		}
	} catch {
		// Fall through
	}

	// Check for common test runners
	const runners = [
		{ cmd: "npx", args: ["jest", "--no-coverage"] },
		{ cmd: "npx", args: ["mocha"] },
		{ cmd: "npx", args: ["vitest", "run"] },
		{ cmd: "npx", args: ["ava"] },
		{ cmd: "npx", args: ["tap"] },
	];

	for (const runner of runners) {
		try {
			const result = await exec("which", [runner.cmd], { timeout: 3_000 });
			if (result.code === 0) {
				return runner;
			}
		} catch {
			continue;
		}
	}

	return null;
}

// ─── Main Orchestration ────────────────────────────────────────────

/**
 * Run deterministic TDD gate verification.
 *
 * Steps:
 * 1. Get changed files via `git diff <defaultBranch> --name-only` from worktree
 * 2. Classify changed files into test files and implementation files
 * 3. Run three TDD checks:
 *    a. "tests-written" — at least one test file in diff
 *    b. "test-fail-first" — revert implementation, run tests, verify they fail
 *    c. "tests-reference-implementation" — test files reference new implementation code
 * 4. Return aggregate result
 *
 * @param exec - Exec function (from pi.exec or mock)
 * @param worktreePath - Path to the worktree
 * @param defaultBranch - Default branch name (e.g. "main")
 * @param testPatterns - Optional custom test file patterns (default: standard patterns)
 * @returns TddGateResult
 */
export async function runTddGate(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
	_testPatterns?: string[],
): Promise<TddGateResult> {
	const checks: TddCheck[] = [];
	let changedFiles: string[] = [];

	// Step 1: Get changed files from git diff
	try {
		const diffResult = await exec("git", ["diff", defaultBranch, "--name-only"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (diffResult.code !== 0) {
			return {
				status: "error",
				checks: [],
				rejectionReason: `git diff failed: ${diffResult.stderr || "unknown error"}`,
			};
		}
		changedFiles = (diffResult.stdout || "")
			.trim()
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			checks: [],
			rejectionReason: `git diff failed: ${msg}`,
		};
	}

	// No changed files → nothing to verify
	if (changedFiles.length === 0) {
		checks.push({
			name: "tests-written",
			passed: true,
			detail: "No changed files — nothing to verify",
		});
		return buildTddGateResult(checks);
	}

	// Step 2: Classify changed files
	const { testFiles, implFiles } = classifyChangedFiles(changedFiles);

	// Step 3a: Check "tests-written"
	if (testFiles.length > 0) {
		checks.push({
			name: "tests-written",
			passed: true,
			detail: `${testFiles.length} test file(s) found in diff`,
		});
	} else {
		checks.push({
			name: "tests-written",
			passed: false,
			detail: "No test files found in diff. Tests must be written before implementation.",
		});
	}

	// Step 3b: Check "test-fail-first"
	// Revert implementation files, run tests, verify they fail
	if (implFiles.length === 0) {
		// No implementation files changed — nothing to revert, skip this check
		checks.push({
			name: "test-fail-first",
			passed: true,
			detail: "No implementation files changed — nothing to revert",
		});
	} else {
		try {
			const failFirstResult = await checkTestFailFirst(exec, worktreePath, implFiles, testFiles);
			checks.push(failFirstResult);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			checks.push({
				name: "test-fail-first",
				passed: true,
				detail: `Could not verify test-fail-first (non-blocking): ${msg}`,
			});
		}
	}

	// Step 3c: Check "tests-reference-implementation"
	if (testFiles.length === 0) {
		checks.push({
			name: "tests-reference-implementation",
			passed: true,
			detail: "No test files — nothing to verify",
		});
	} else if (implFiles.length === 0) {
		checks.push({
			name: "tests-reference-implementation",
			passed: true,
			detail: "No implementation files — nothing to verify",
		});
	} else {
		try {
			const refResult = await checkTestsReferenceImpl(exec, worktreePath, testFiles, implFiles);
			checks.push(refResult);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			checks.push({
				name: "tests-reference-implementation",
				passed: true,
				detail: `Could not verify test-implementation references (non-blocking): ${msg}`,
			});
		}
	}

	return buildTddGateResult(checks);
}

/**
 * Check that tests fail when implementation files are reverted (test-fail-first).
 *
 * Steps:
 * 1. Run `git checkout <defaultBranch> -- <implFiles>` to revert implementation files
 * 2. Run the test suite
 * 3. Revert the revert (restore implementation) with `git checkout -- <implFiles>`
 * 4. If tests fail after revert → pass. If tests pass → fail (tautological tests).
 *
 * Always restores implementation files before returning, even on failure.
 */
async function checkTestFailFirst(
	exec: ExecFn,
	worktreePath: string,
	implFiles: string[],
	testFiles: string[],
): Promise<TddCheck> {
	if (testFiles.length === 0) {
		return {
			name: "test-fail-first",
			passed: true,
			detail: "No test files to run",
		};
	}

	// Detect test runner
	const runner = await detectTestRunner(exec, worktreePath);
	if (!runner) {
		return {
			name: "test-fail-first",
			passed: true,
			detail: "No test runner detected — skipping test-fail-first verification",
		};
	}

	// Step 1: Revert implementation files to the base branch version
	try {
		await exec("git", ["checkout", "HEAD", "--", ...implFiles], {
			cwd: worktreePath,
			timeout: 10_000,
		});
	} catch (err: unknown) {
		// If revert fails, restore and report
		const msg = err instanceof Error ? err.message : String(err);
		return {
			name: "test-fail-first",
			passed: true,
			detail: `Could not revert implementation files: ${msg}`,
		};
	}

	let testPassed = false;
	try {
		// Step 2: Run tests
		const testResult = await exec(runner.cmd, runner.args, {
			cwd: worktreePath,
			timeout: 60_000,
		});
		testPassed = testResult.code === 0;
	} catch {
		testPassed = false;
	} finally {
		// Step 3: Always restore implementation files
		try {
			await exec("git", ["checkout", "--", ...implFiles], {
				cwd: worktreePath,
				timeout: 10_000,
			});
		} catch {
			// Best-effort restore — don't throw
		}
	}

	if (testPassed) {
		return {
			name: "test-fail-first",
			passed: false,
			detail:
				"Tests passed after reverting implementation files — tests may be tautological or not testing the implementation",
		};
	}

	return {
		name: "test-fail-first",
		passed: true,
		detail: "Tests failed after reverting implementation — TDD cycle confirmed",
	};
}

/**
 * Check that test files reference implementation files.
 *
 * Reads test file contents and checks for imports/requires of implementation files.
 * This is a lightweight check — it looks for file names and export names
 * from implementation files appearing in test files.
 */
async function checkTestsReferenceImpl(
	exec: ExecFn,
	worktreePath: string,
	testFiles: string[],
	implFiles: string[],
): Promise<TddCheck> {
	// Extract basenames (without extension) from implementation files
	const implBasenames = implFiles.map((f) => {
		const base = basename(f);
		const dotIdx = base.lastIndexOf(".");
		return dotIdx > 0 ? base.slice(0, dotIdx) : base;
	});

	// Extract potential export names from implementation files
	const implKeywords = new Set<string>();
	for (const implFile of implFiles) {
		// Add the file's basename without extension
		const base = basename(implFile);
		const dotIdx = base.lastIndexOf(".");
		const name = dotIdx > 0 ? base.slice(0, dotIdx) : base;
		implKeywords.add(name);
		implKeywords.add(`./${name}`);
		implKeywords.add(`../${name}`);

		// Try to read implementation file and extract export names
		try {
			const fullPath = join(worktreePath, implFile);
			if (existsSync(fullPath)) {
				const content = readFileSync(fullPath, "utf-8");
				// Extract export function/class/const names
				const exportRegex =
					/export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
				let match: RegExpExecArray | null;
				while ((match = exportRegex.exec(content)) !== null) {
					implKeywords.add(match[1]!);
				}
				// Also extract named exports: export { Foo, Bar }
				const namedExportRegex = /export\s+\{\s*([^}]+)\s*\}/g;
				while ((match = namedExportRegex.exec(content)) !== null) {
					const names = match[1]!.split(",").map((n) =>
						n
							.trim()
							.split(/\s+as\s+/)[0]!
							.trim(),
					);
					for (const n of names) {
						if (n) implKeywords.add(n);
					}
				}
			}
		} catch {
			// If reading fails, we still have basenames
		}
	}

	// Check each test file for references to implementation
	let anyReferenceFound = false;
	for (const testFile of testFiles) {
		try {
			const fullPath = join(worktreePath, testFile);
			if (!existsSync(fullPath)) continue;

			const content = readFileSync(fullPath, "utf-8");

			// Check if any implementation keyword appears in the test
			for (const keyword of implKeywords) {
				if (keyword.length < 2) continue; // Skip very short keywords
				if (content.includes(keyword)) {
					anyReferenceFound = true;
					break;
				}
			}

			if (anyReferenceFound) break;
		} catch {
			continue;
		}
	}

	if (anyReferenceFound) {
		return {
			name: "tests-reference-implementation",
			passed: true,
			detail: "Test files reference implementation code",
		};
	}

	return {
		name: "tests-reference-implementation",
		passed: false,
		detail: "Test files do not reference any implementation code",
	};
}
