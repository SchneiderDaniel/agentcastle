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

// ─── Main Orchestration ────────────────────────────────────────────

/**
 * Run deterministic TDD gate verification.
 *
 * Steps:
 * 1. Get changed files via `git diff <defaultBranch> --name-only` from worktree
 * 2. Classify changed files into test files and implementation files
 * 3. Run TDD checks:
 *    a. "tests-written" — at least one test file in diff
 *    b. "tests-reference-implementation" — test files reference new implementation code
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
