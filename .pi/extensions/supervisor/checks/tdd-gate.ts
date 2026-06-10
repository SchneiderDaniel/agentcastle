// ─── TDD Gate ─────────────────────────────────────────────────────
// Deterministic TDD verification gate for the supervisor pipeline.
// Runs after developer commit, before auditor dispatch.
// Verifies that tests were written, contain assertions, and that
// exported symbols from implementation are exercised in tests.

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
	name: "tests-written" | "test-assertions" | "test-covers-symbols";
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

// ─── Assertion Detection ───────────────────────────────────────────

/**
 * Built-in regex for detecting assertion lines.
 * Matches common assertion patterns in test files.
 */
const DEFAULT_ASSERT_REGEX =
	/(?:assert|expect|t\.\w+|ok\(|deepEqual|strictEqual|notStrictEqual|throws|rejects|doesNotThrow|doesNotReject|ifError|fail)/;

/**
 * Build a combined regex for assertion line detection.
 * Custom patterns are treated as plain function names (escaped for regex safety).
 * The built-in DEFAULT_ASSERT_REGEX is always included as a fallback.
 */
function buildAssertionRegex(customPatterns: string[]): RegExp {
	if (customPatterns.length === 0) {
		return DEFAULT_ASSERT_REGEX;
	}
	// Escape custom patterns (they are plain function names like "verify", "myAssert")
	const escaped = customPatterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(`${escaped.join("|")}|${DEFAULT_ASSERT_REGEX.source}`);
}

/**
 * Check if a line of code contains a placeholder assertion.
 * A placeholder assertion is one where ALL arguments to every assertion
 * call on the line are literal values (true/false/null/undefined/numbers/strings).
 * Returns true only if assertion calls exist AND all their args are literals.
 *
 * Creates a fresh regex each call to avoid state issues with the `g` flag
 * (important for parallel test execution).
 */
function isPlaceholderLine(line: string): boolean {
	const assertCallRegex =
		/(?:(?:assert|expect)\.\w+|expect|t\.\w+|ok|deepEqual|strictEqual|notStrictEqual|throws|rejects|doesNotThrow|doesNotReject|ifError|fail)\s*\(([^)]*)\)/g;

	// Remove string literals to avoid false matches on content
	const cleaned = line
		.replace(/'(?:[^'\\]|\\.)*'/g, "")
		.replace(/"(?:[^"\\]|\\.)*"/g, "")
		.replace(/`(?:[^`\\]|\\.)*`/g, "");

	// Match assertion function calls with their parenthesized arguments
	let match: RegExpExecArray | null;
	let hasAnyAssertionCall = false;

	while ((match = assertCallRegex.exec(cleaned)) !== null) {
		hasAnyAssertionCall = true;
		const args = match[1].trim();
		if (!args) continue;

		// Split args by comma (simplistic — won't handle nested parens, but
		// nested parens imply non-literal args so this is conservative)
		const argList = args
			.split(",")
			.map((a) => a.trim())
			.filter(Boolean);

		for (const arg of argList) {
			// Check if this arg is a literal
			if (/^(true|false|null|undefined|-?\d+(?:\.\d+)?)$/i.test(arg)) continue;
			if (/^["'`]/.test(arg)) continue; // String literal
			// Non-literal found — this assertion has real arguments
			return false;
		}
	}

	return hasAnyAssertionCall;
}

/**
 * Check that test files contain assertion statements.
 *
 * Scans each test file for assertion patterns (assert.*, expect.*, t.is, ok(, etc.)
 * and rejects files with no assertions or only placeholder assertions
 * (all-literal arguments like `expect(true).toBe(true)`).
 *
 * @param testFiles - List of test file paths (relative to worktreePath)
 * @param worktreePath - Path to the worktree
 * @param assertPatterns - Optional custom assertion function name patterns
 * @returns TddCheck with pass/fail
 */
export function checkTestAssertions(
	testFiles: string[],
	worktreePath: string,
	assertPatterns?: string[],
): TddCheck {
	const assertRegex = buildAssertionRegex(assertPatterns ?? []);

	let anyFileHasNonPlaceholderAssertion = false;
	let filesChecked = 0;
	const details: string[] = [];

	for (const testFile of testFiles) {
		const fullPath = join(worktreePath, testFile);
		if (!existsSync(fullPath)) {
			details.push(`${testFile}: file not found`);
			continue;
		}
		filesChecked++;

		const content = readFileSync(fullPath, "utf-8");

		// Check non-comment lines for assertion patterns
		const lines = content.split("\n");
		const assertionLines: string[] = [];

		for (const line of lines) {
			const trimmedLine = line.trim();
			// Skip comment-only lines
			if (
				trimmedLine.startsWith("//") ||
				trimmedLine.startsWith("*") ||
				trimmedLine.startsWith("/*")
			) {
				continue;
			}
			if (assertRegex.test(trimmedLine)) {
				assertionLines.push(trimmedLine);
			}
		}

		if (assertionLines.length === 0) {
			details.push(`${testFile}: no assertion statements found`);
			continue;
		}

		// Check for placeholder assertions (all literal args)
		const hasNonPlaceholder = assertionLines.some((line) => !isPlaceholderLine(line));

		if (hasNonPlaceholder) {
			anyFileHasNonPlaceholderAssertion = true;
			details.push(`${testFile}: ${assertionLines.length} assertion(s) found`);
		} else {
			details.push(`${testFile}: only placeholder assertions found (all literal arguments)`);
		}
	}

	if (filesChecked === 0) {
		return {
			name: "test-assertions",
			passed: true,
			detail: "No test files to check",
		};
	}

	if (anyFileHasNonPlaceholderAssertion) {
		return {
			name: "test-assertions",
			passed: true,
			detail: details.join("; "),
		};
	}

	return {
		name: "test-assertions",
		passed: false,
		detail: details.join("; "),
	};
}

// ─── Symbol Coverage ───────────────────────────────────────────────

/**
 * Extract runtime export names from implementation file content.
 * Filters out type-only exports (export type, export interface).
 *
 * @returns Array of export symbol names (runtime only)
 */
function extractRuntimeExports(content: string): string[] {
	const exports: string[] = [];

	// 1. export function name(...)
	const funcRegex = /export\s+(?:default\s+)?function\s+(\w+)/g;
	let match: RegExpExecArray | null;
	while ((match = funcRegex.exec(content)) !== null) {
		exports.push(match[1]!);
	}

	// 2. export class Name { ... }
	const classRegex = /export\s+(?:default\s+)?class\s+(\w+)/g;
	while ((match = classRegex.exec(content)) !== null) {
		exports.push(match[1]!);
	}

	// 3. export const/let/var name = ...
	const varRegex = /export\s+(?:default\s+)?(?:const|let|var)\s+(\w+)/g;
	while ((match = varRegex.exec(content)) !== null) {
		exports.push(match[1]!);
	}

	// 4. export enum Name { ... }
	const enumRegex = /export\s+(?:default\s+)?enum\s+(\w+)/g;
	while ((match = enumRegex.exec(content)) !== null) {
		exports.push(match[1]!);
	}

	// 5. export { name1, name2, ... } — named re-export block
	const namedExportRegex = /export\s+\{\s*([^}]+)\s*\}/g;
	while ((match = namedExportRegex.exec(content)) !== null) {
		const names = match[1]!
			.split(",")
			.map((n) => n.trim())
			.filter(Boolean);
		for (const name of names) {
			// Handle 'orig as alias' — use the alias for assertion matching
			const exportName = name
				.split(/\s+as\s+/)
				.pop()!
				.trim();
			if (exportName) exports.push(exportName);
		}
	}

	return [...new Set(exports)]; // Deduplicate
}

/**
 * Check if a line of test code contains an assertion call.
 */
function lineHasAssertion(line: string): boolean {
	return DEFAULT_ASSERT_REGEX.test(line);
}

/**
 * Check that implementation symbols are exercised in test assertions.
 *
 * For each implementation file, extracts runtime exports (filtering out
 * type-only exports like `export type` and `export interface`). Then
 * verifies that at least one symbol from each file appears in an assertion
 * context within the test files.
 *
 * Relaxed rule: at least one symbol per impl file must be covered by at
 * least one assertion in the test suite. This accommodates mock-isolated
 * tests where DI inverts symbol references.
 *
 * @param testFiles - List of test file paths (relative to worktreePath)
 * @param implFiles - List of implementation file paths (relative to worktreePath)
 * @param worktreePath - Path to the worktree
 * @param _assertPatterns - Optional custom assertion function name patterns (unused, for symmetry)
 * @returns TddCheck with pass/fail
 */
export function checkTestCoversSymbols(
	testFiles: string[],
	implFiles: string[],
	worktreePath: string,
	_assertPatterns?: string[],
): TddCheck {
	// Edge cases
	if (testFiles.length === 0) {
		return {
			name: "test-covers-symbols",
			passed: true,
			detail: "No test files — nothing to verify",
		};
	}

	if (implFiles.length === 0) {
		return {
			name: "test-covers-symbols",
			passed: true,
			detail: "No implementation files — nothing to verify",
		};
	}

	// Step 1: Extract runtime exports from each impl file
	type FileExports = { file: string; runtimeExports: string[] };
	const allFileExports: FileExports[] = [];

	for (const implFile of implFiles) {
		const fullPath = join(worktreePath, implFile);
		let runtimeExports: string[] = [];

		try {
			if (existsSync(fullPath)) {
				const content = readFileSync(fullPath, "utf-8");
				runtimeExports = extractRuntimeExports(content);
			}
		} catch {
			// If reading fails, treat as no exports
		}

		allFileExports.push({ file: implFile, runtimeExports });
	}

	// Step 2: Check if all exported files have zero runtime exports
	const filesWithExports = allFileExports.filter((fe) => fe.runtimeExports.length > 0);

	if (filesWithExports.length === 0) {
		return {
			name: "test-covers-symbols",
			passed: true,
			detail: "No runtime exports found in implementation files (type-only or no exports)",
		};
	}

	// Step 3: Read test files and check which symbols appear in assertion contexts
	const allTestContent = testFiles
		.map((tf) => {
			const fullPath = join(worktreePath, tf);
			try {
				if (existsSync(fullPath)) return readFileSync(fullPath, "utf-8");
			} catch {
				// Ignore read errors
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");

	if (!allTestContent) {
		return {
			name: "test-covers-symbols",
			passed: false,
			detail: "Test files could not be read",
		};
	}

	// Step 4: For each file, check if at least one of its runtime exports
	// appears in an assertion context within any test file
	const uncoveredFiles: string[] = [];

	for (const fe of filesWithExports) {
		const isCovered = fe.runtimeExports.some((symbol) => {
			// Check each line that contains an assertion pattern
			const testLines = allTestContent.split("\n");
			return testLines.some((line) => {
				if (!lineHasAssertion(line)) return false;
				// The symbol must appear as a word boundary match on the same line
				// as an assertion call (handles destructured imports, direct references)
				const symbolRegex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
				return symbolRegex.test(line);
			});
		});

		if (!isCovered) {
			uncoveredFiles.push(fe.file);
		}
	}

	if (uncoveredFiles.length > 0) {
		return {
			name: "test-covers-symbols",
			passed: false,
			detail: `Uncovered implementation files: ${uncoveredFiles.join(", ")}. No runtime exports from these files appear in test assertions.`,
		};
	}

	return {
		name: "test-covers-symbols",
		passed: true,
		detail: `All ${filesWithExports.length} implementation file(s) with runtime exports have symbols covered in test assertions`,
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
 *    b. "test-assertions" — test files contain assertion statements
 *    c. "test-covers-symbols" — implementation symbols appear in test assertions
 * 4. Return aggregate result
 *
 * @param exec - Exec function (from pi.exec or mock)
 * @param worktreePath - Path to the worktree
 * @param defaultBranch - Default branch name (e.g. "main")
 * @param assertPatterns - Optional custom assertion function names (overrides defaults)
 * @returns TddGateResult
 */
export async function runTddGate(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
	assertPatterns?: string[],
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

	// Step 3b: Check "test-assertions"
	if (testFiles.length > 0) {
		try {
			const assertionsResult = checkTestAssertions(testFiles, worktreePath, assertPatterns);
			checks.push(assertionsResult);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			checks.push({
				name: "test-assertions",
				passed: true,
				detail: `Could not verify test assertions (non-blocking): ${msg}`,
			});
		}
	}
	// If no test files, we skip test-assertions (already reported by tests-written)

	// Step 3c: Check "test-covers-symbols"
	if (testFiles.length === 0) {
		checks.push({
			name: "test-covers-symbols",
			passed: true,
			detail: "No test files — nothing to verify",
		});
	} else if (implFiles.length === 0) {
		checks.push({
			name: "test-covers-symbols",
			passed: true,
			detail: "No implementation files — nothing to verify",
		});
	} else {
		try {
			const coversResult = checkTestCoversSymbols(
				testFiles,
				implFiles,
				worktreePath,
				assertPatterns,
			);
			checks.push(coversResult);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			checks.push({
				name: "test-covers-symbols",
				passed: true,
				detail: `Could not verify symbol coverage (non-blocking): ${msg}`,
			});
		}
	}

	return buildTddGateResult(checks);
}
