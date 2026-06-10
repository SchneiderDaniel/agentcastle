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
	checkTestAssertions,
	checkTestCoversSymbols,
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
				{ name: "test-covers-symbols", passed: true },
			],
			rejectionReason: "Tests not written",
		};

		assert.equal(result.checks.length, 2);
		assert.equal(result.checks[0]!.name, "tests-written");
		assert.equal(result.checks[0]!.passed, false);
		assert.equal(result.checks[0]!.detail, "No test files found in diff");
		assert.equal(result.checks[1]!.name, "test-covers-symbols");
		assert.equal(result.checks[1]!.passed, true);
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
	it("name field accepts all new and legacy literal string values", () => {
		const written: TddCheck = { name: "tests-written", passed: true };
		const assertions: TddCheck = { name: "test-assertions", passed: true };
		const symbols: TddCheck = { name: "test-covers-symbols", passed: true };

		assert.equal(written.name, "tests-written");
		assert.equal(assertions.name, "test-assertions");
		assert.equal(symbols.name, "test-covers-symbols");
	});

	it("detail field is optional", () => {
		const withDetail: TddCheck = {
			name: "test-assertions",
			passed: false,
			detail: "No assertion statements found",
		};
		const without: TddCheck = { name: "tests-written", passed: true };

		assert.equal(withDetail.detail, "No assertion statements found");
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
			{ name: "test-assertions", passed: true },
			{ name: "test-covers-symbols", passed: true },
		];
		const result = buildTddGateResult(checks);
		assert.equal(result.status, "passed");
		assert.equal(result.checks.length, 3);
		assert.equal(result.rejectionReason, undefined);
	});

	it("returns failed when any check fails", () => {
		const checks: TddCheck[] = [
			{ name: "tests-written", passed: true },
			{ name: "test-covers-symbols", passed: false, detail: "No symbols covered" },
		];
		const result = buildTddGateResult(checks);
		assert.equal(result.status, "failed");
		assert.ok(result.rejectionReason!.includes("test-covers-symbols"));
	});

	it("returns failed with multiple failing check names in reason", () => {
		const checks: TddCheck[] = [
			{ name: "tests-written", passed: false, detail: "No test files found" },
			{ name: "test-assertions", passed: false, detail: "No assertions found" },
		];
		const result = buildTddGateResult(checks);
		assert.equal(result.status, "failed");
		assert.ok(result.rejectionReason!.includes("tests-written"));
		assert.ok(result.rejectionReason!.includes("test-assertions"));
	});

	it("returns error for empty checks array", () => {
		const result = buildTddGateResult([]);
		assert.equal(result.status, "error");
		assert.equal(result.checks.length, 0);
		assert.equal(result.rejectionReason, "No checks run");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: checkTestAssertions
// ═══════════════════════════════════════════════════════════════════════

describe("checkTestAssertions()", () => {
	function createTempFile(dir: string, relPath: string, content: string): string {
		const fullPath = join(dir, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
		return fullPath;
	}

	it("empty test file (zero content) → fails", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-empty");
		createTempFile(dir, "test.test.ts", "");
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
		assert.match(result.detail!, /no assertion statements found/i);
	});

	it("test file with only imports and describe block, no assertions → fails", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-only-import");
		createTempFile(
			dir,
			"test.test.ts",
			`import { foo } from "./foo";\ndescribe("foo", () => {\n  it("works", () => {});\n});`,
		);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
	});

	it("test file with assert.equal(a, b) → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-eq");
		createTempFile(dir, "test.test.ts", `import assert from "node:assert";\nassert.equal(a, b);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file with expect(fn()).toBe(42) → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-expect");
		createTempFile(dir, "test.test.ts", `expect(fn()).toBe(42);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file with t.is(result, expected) → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-tap");
		createTempFile(dir, "test.test.ts", `t.is(result, expected);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file with ok(condition) → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-ok");
		createTempFile(dir, "test.test.ts", `ok(condition);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file with deepEqual(actual, expected) → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-deep");
		createTempFile(dir, "test.test.ts", `deepEqual(actual, expected);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file with assert.ok(value) → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-ok-method");
		createTempFile(dir, "test.test.ts", `assert.ok(value);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file with only comment containing assert text → fails", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-assert-comment");
		createTempFile(
			dir,
			"test.test.ts",
			`// assert.equal(a, b) but it's just a comment\nok = true;`,
		);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
	});

	it("test file with expect(true).toBe(true) (placeholder) → fails", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-placeholder-expect");
		createTempFile(dir, "test.test.ts", `expect(true).toBe(true);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
		assert.match(result.detail!, /placeholder|trivial|literal/i);
	});

	it("test file with assert.equal(3, 3) (placeholder) → fails", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-placeholder-eq");
		createTempFile(dir, "test.test.ts", `assert.equal(3, 3);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
	});

	it("test file with assert.ok(true) (placeholder) → fails", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-placeholder-ok");
		createTempFile(dir, "test.test.ts", `assert.ok(true);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
	});

	it("test file with assert.equal(calculateTotal(items), 42) → passes (non-literal first arg)", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-nonliteral-arg");
		createTempFile(dir, "test.test.ts", `assert.equal(calculateTotal(items), 42);`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file with assert.ok(hasPermission(user)) → passes (non-literal arg)", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-nonliteral-fn");
		createTempFile(dir, "test.test.ts", `assert.ok(hasPermission(user));`);
		const result = checkTestAssertions(["test.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("test file that doesn't exist → passes with detail mentioning file not found", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-notfound");
		mkdirSync(dir, { recursive: true });
		const result = checkTestAssertions(["nonexistent.test.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
		assert.match(result.detail!, /not found|no test files/i);
	});

	it("custom assertFunctionNames list includes ['verify'], test uses verify.strictEqual(a, b) → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-custom-assert");
		createTempFile(dir, "test.test.ts", `verify.strictEqual(a, b);`);
		const result = checkTestAssertions(["test.test.ts"], dir, ["verify"]);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("empty assertFunctionNames list falls back to default patterns", () => {
		const dir = join(process.cwd(), "ignore/tdd-test-empty-custom");
		createTempFile(dir, "test.test.ts", `expect(a).toBe(b);`);
		const result = checkTestAssertions(["test.test.ts"], dir, []);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Domain: checkTestCoversSymbols
// ═══════════════════════════════════════════════════════════════════════

describe("checkTestCoversSymbols()", () => {
	function createTempFile(dir: string, relPath: string, content: string): string {
		const fullPath = join(dir, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
		return fullPath;
	}

	it("impl exports function, test asserts on it → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-fn");
		createTempFile(
			dir,
			"src/calc.ts",
			"export function calculateTotal(items: number[]): number { return 42; }",
		);
		createTempFile(
			dir,
			"src/calc.test.ts",
			`import { calculateTotal } from "./calc";\nassert.equal(calculateTotal([1,2]), 3);`,
		);
		const result = checkTestCoversSymbols(["src/calc.test.ts"], ["src/calc.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("impl exports const, test asserts on it → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-const");
		createTempFile(dir, "src/size.ts", "export const MAX_SIZE = 100;");
		createTempFile(
			dir,
			"src/size.test.ts",
			`import { MAX_SIZE } from "./size";\nassert.equal(MAX_SIZE, 100);`,
		);
		const result = checkTestCoversSymbols(["src/size.test.ts"], ["src/size.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("impl exports class, test asserts with it → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-class");
		createTempFile(
			dir,
			"src/calc.ts",
			"export class Calculator { add(a: number, b: number) { return a + b; } }",
		);
		createTempFile(
			dir,
			"src/calc.test.ts",
			`import { Calculator } from "./calc";\nconst calc = new Calculator();\nassert.ok(calc instanceof Calculator);`,
		);
		const result = checkTestCoversSymbols(["src/calc.test.ts"], ["src/calc.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("impl has only type-only exports → passes with detail about skipped types", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-typeonly");
		createTempFile(
			dir,
			"src/types.ts",
			"export type Options = { debug: boolean };\nexport interface Config { host: string; }",
		);
		createTempFile(
			dir,
			"src/types.test.ts",
			`import type { Options, Config } from "./types";\nconst opts: Options = { debug: true };`,
		);
		const result = checkTestCoversSymbols(["src/types.test.ts"], ["src/types.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
		assert.match(result.detail!, /type-only|no runtime exports|skipped/i);
	});

	it("impl has zero exports → passes with detail", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-zero-exports");
		createTempFile(dir, "src/util.ts", "function internalHelper() { return 42; }");
		createTempFile(
			dir,
			"src/util.test.ts",
			"import assert from 'node:assert';\nassert.equal(true, true);",
		);
		const result = checkTestCoversSymbols(["src/util.test.ts"], ["src/util.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
		assert.match(result.detail!, /no exports|no runtime exports/i);
	});

	it("impl exports function but test only imports without asserting → fails", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-no-assert");
		createTempFile(
			dir,
			"src/calc.ts",
			"export function calculateTotal(items: number[]): number { return 42; }",
		);
		createTempFile(
			dir,
			"src/calc.test.ts",
			`import { calculateTotal } from "./calc";\ndescribe("calc", () => {\n  it("exists", () => {});\n});`,
		);
		const result = checkTestCoversSymbols(["src/calc.test.ts"], ["src/calc.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
	});

	it("mock-isolated test with one covered symbol per file → passes (relaxed rule)", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-mock");
		createTempFile(
			dir,
			"src/user-service.ts",
			"export class UserService { getUser(id: string) { return null; } }\nexport class EmailService { send(email: string) {} }",
		);
		createTempFile(
			dir,
			"src/user-service.test.ts",
			`import { UserService } from "./user-service";\nconst svc = new UserService();\nassert.ok(svc instanceof UserService);`,
		);
		const result = checkTestCoversSymbols(
			["src/user-service.test.ts"],
			["src/user-service.ts"],
			dir,
		);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("export { helper, util } named re-export block → detected", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-named-rexport");
		createTempFile(
			dir,
			"src/helpers.ts",
			"export function helper() { return 1; }\nexport function util() { return 2; }",
		);
		createTempFile(dir, "src/index.ts", "export { helper, util } from './helpers';");
		createTempFile(
			dir,
			"src/index.test.ts",
			`import { helper } from "./index";\nassert.ok(helper());`,
		);
		const result = checkTestCoversSymbols(
			["src/index.test.ts"],
			["src/index.ts", "src/helpers.ts"],
			dir,
		);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("no test files provided → passes with detail", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-no-tests");
		mkdirSync(dir, { recursive: true });
		const result = checkTestCoversSymbols([], ["src/foo.ts"], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
		assert.match(result.detail!, /no test files/i);
	});

	it("no impl files provided → passes with detail", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-no-impl");
		mkdirSync(dir, { recursive: true });
		const result = checkTestCoversSymbols(["src/foo.test.ts"], [], dir);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
		assert.match(result.detail!, /no implementation files/i);
	});

	it("two impl files, both covered → passes", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-multi-file");
		createTempFile(
			dir,
			"src/calc.ts",
			"export function calculateTotal(items: number[]): number { return 42; }",
		);
		createTempFile(
			dir,
			"src/format.ts",
			"export function formatCurrency(n: number): string { return '$' + n; }",
		);
		createTempFile(
			dir,
			"src/test.test.ts",
			`import { calculateTotal } from "./calc";\nimport { formatCurrency } from "./format";\nassert.equal(calculateTotal([1,2]), 3);\nassert.equal(formatCurrency(5), '$5');`,
		);
		const result = checkTestCoversSymbols(
			["src/test.test.ts"],
			["src/calc.ts", "src/format.ts"],
			dir,
		);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, true);
	});

	it("two impl files, one uncovered → fails with detail naming uncovered file", () => {
		const dir = join(process.cwd(), "ignore/tdd-covers-one-uncovered");
		createTempFile(
			dir,
			"src/calc.ts",
			"export function calculateTotal(items: number[]): number { return 42; }",
		);
		createTempFile(
			dir,
			"src/logger.ts",
			"export function log(message: string): void { console.log(message); }",
		);
		createTempFile(
			dir,
			"src/test.test.ts",
			`import { calculateTotal } from "./calc";\nassert.equal(calculateTotal([1,2]), 3);`,
		);
		const result = checkTestCoversSymbols(
			["src/test.test.ts"],
			["src/calc.ts", "src/logger.ts"],
			dir,
		);
		rmSync(dir, { recursive: true, force: true });
		assert.equal(result.passed, false);
		assert.match(result.detail!, /logger/i);
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

	it("all 3 checks present in correct order when test+impl files present", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/impl.ts\nsrc/impl.test.ts", stderr: "" },
		]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		assert.equal(result.checks.length, 3);
		assert.equal(result.checks[0]!.name, "tests-written");
		assert.equal(result.checks[1]!.name, "test-assertions");
		assert.equal(result.checks[2]!.name, "test-covers-symbols");
	});

	it("when no test files in diff, test-assertions is skipped, test-covers-symbols passes with detail", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "src/impl.ts", stderr: "" }]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const assertionsCheck = result.checks.find((c) => c.name === "test-assertions");
		const coversCheck = result.checks.find((c) => c.name === "test-covers-symbols");
		assert.equal(assertionsCheck, undefined); // Skipped when no test files
		assert.ok(coversCheck!.passed);
		assert.match(coversCheck!.detail!, /no test files/i);
	});

	it("when no impl files in diff, test-covers-symbols passes with detail", async () => {
		const mockExec = createMockExec([{ code: 0, stdout: "src/foo.test.ts", stderr: "" }]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");
		const coversCheck = result.checks.find((c) => c.name === "test-covers-symbols");
		assert.ok(coversCheck!.passed);
		assert.match(coversCheck!.detail!, /no implementation files/i);
	});

	it("check 'test-covers-symbols' passes when test files cover new code", async () => {
		const testDir = join(process.cwd(), "ignore/tdd-gate-covers-pass-test");
		const implFile = join(testDir, "src/impl.ts");
		const testFile = join(testDir, "src/impl.test.ts");
		mkdirSync(dirname(implFile), { recursive: true });
		writeFileSync(implFile, "export function newFeature() { return 42; }");
		writeFileSync(
			testFile,
			"import { newFeature } from './impl'; describe('newFeature', () => { it('works', () => { assert.equal(newFeature(), 42); }); });",
		);

		const mockExec: ExecFn = async (cmd, args) => {
			if (cmd === "git" && args[0] === "diff") {
				return { code: 0, stdout: "src/impl.ts\nsrc/impl.test.ts", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const result = await runTddGate(mockExec, testDir, "main");
		rmSync(testDir, { recursive: true, force: true });

		const coversCheck = result.checks.find((c) => c.name === "test-covers-symbols");
		assert.equal(coversCheck!.passed, true);
	});

	it("returns passed when only test files changed (no impl to verify)", async () => {
		const mockExec = createMockExec([
			{ code: 0, stdout: "src/foo.test.ts\nsrc/bar.spec.ts", stderr: "" },
		]);

		const result = await runTddGate(mockExec, "/repo/worktree", "main");

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
});
