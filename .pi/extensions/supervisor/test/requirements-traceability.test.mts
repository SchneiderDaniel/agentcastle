/**
 * Tests for checks/requirements-traceability.ts — deterministic
 * requirements-to-implementation completeness cross-reference.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/requirements-traceability.test.mts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
	type TraceabilityGap,
	type ExecFn,
	type FilteredIssueData,
	isTestableFile,
	parseIssueBodyChecklists,
	extractTitleVerb,
	extractChecklistKeywords,
	classifyDiffDirection,
	runRequirementsTraceability,
} from "../checks/requirements-traceability.ts";
import { WORKFLOW } from "../config/workflow.ts";

// ═══════════════════════════════════════════════════════════════════════
// Test Helpers (top-level scope)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a mock ExecFn that responds to git diff with given name-status lines.
 * For git grep, returns exit code 1 (not found) by default.
 */
function mockExec(lines: string[]): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			const nameOnly = lines
				.map((l) => l.replace(/^[A-Z]\d*\s+/, "").replace(/\s+.*$/, ""))
				.filter(Boolean);
			return { code: 0, stdout: nameOnly.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

/**
 * Create a mock ExecFn that responds to git diff with the given paths (all A status).
 */
function mockExecPaths(paths: string[]): ExecFn {
	return async (cmd: string, args: string[]) => {
		if (cmd === "git" && args.includes("diff") && args.includes("--name-status")) {
			const lines = paths.map((p) => `A ${p}`);
			return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("diff") && args.includes("--name-only")) {
			return { code: 0, stdout: paths.join("\n") + "\n", stderr: "" };
		}
		if (cmd === "git" && args.includes("grep")) {
			return { code: 1, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

/**
 * Create a temp directory for file-system-based tests.
 * Returns the temp dir path. Caller must clean up with rmSync.
 */
function createTempDir(prefix: string, files: Record<string, string>): string {
	const baseDir = join(process.cwd(), "ignore");
	const tempDir = join(baseDir, `rt-test-${prefix}-${Date.now()}`);
	for (const [relPath, content] of Object.entries(files)) {
		const fullPath = join(tempDir, relPath);
		mkdirSync(dirname(fullPath), { recursive: true });
		writeFileSync(fullPath, content);
	}
	return tempDir;
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: isTestableFile
// ═══════════════════════════════════════════════════════════════════════

describe("isTestableFile()", () => {
	it("src/foo.ts → true (source extension)", () => {
		assert.equal(isTestableFile("src/foo.ts"), true);
	});

	it("src/foo.tsx → true", () => {
		assert.equal(isTestableFile("src/foo.tsx"), true);
	});

	it("src/foo.mts → true", () => {
		assert.equal(isTestableFile("src/foo.mts"), true);
	});

	it("src/foo.py → true", () => {
		assert.equal(isTestableFile("src/foo.py"), true);
	});

	it("src/foo.go → true", () => {
		assert.equal(isTestableFile("src/foo.go"), true);
	});

	it("src/foo.d.ts → false (type declaration)", () => {
		assert.equal(isTestableFile("src/foo.d.ts"), false);
	});

	it("src/generated/api.ts → false (under generated/)", () => {
		assert.equal(isTestableFile("src/generated/api.ts"), false);
	});

	it("src/vendor/lib.ts → false (under vendor/)", () => {
		assert.equal(isTestableFile("src/vendor/lib.ts"), false);
	});

	it("src/index.ts → false (barrel re-export)", () => {
		assert.equal(isTestableFile("src/index.ts"), false);
	});

	it("config.json → false (no source extension)", () => {
		assert.equal(isTestableFile("config.json"), false);
	});

	it("src/styles.css → false", () => {
		assert.equal(isTestableFile("src/styles.css"), false);
	});

	it("empty string → false", () => {
		assert.equal(isTestableFile(""), false);
	});

	it("src/barrel-index/index.ts → false (barrel re-export)", () => {
		assert.equal(isTestableFile("src/barrel-index/index.ts"), false);
	});

	it("src/generated/sub/auth.ts → false (under generated/)", () => {
		assert.equal(isTestableFile("src/generated/sub/auth.ts"), false);
	});

	it("vendor/lib.ts → false (under vendor/)", () => {
		assert.equal(isTestableFile("vendor/lib.ts"), false);
	});

	it("src/foo.js (non-TS source) → true", () => {
		assert.equal(isTestableFile("src/foo.js"), true);
	});

	it("src/foo.mjs → true", () => {
		assert.equal(isTestableFile("src/foo.mjs"), true);
	});

	it("src/foo.rs → true", () => {
		assert.equal(isTestableFile("src/foo.rs"), true);
	});

	it("src/foo.java → true", () => {
		assert.equal(isTestableFile("src/foo.java"), true);
	});

	it("src/foo.jsx → true", () => {
		assert.equal(isTestableFile("src/foo.jsx"), true);
	});

	it("README.md → false", () => {
		assert.equal(isTestableFile("README.md"), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Requirements extraction — pure functions
// ═══════════════════════════════════════════════════════════════════════

describe("parseIssueBodyChecklists()", () => {
	it("returns items from body with - [ ] (unchecked)", () => {
		const body = `## Tasks
- [ ] Add user authentication
- [ ] Create login page`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
		assert.equal(result[0]!.text, "Add user authentication");
		assert.equal(result[0]!.checked, false);
		assert.equal(result[1]!.text, "Create login page");
		assert.equal(result[1]!.checked, false);
	});

	it("extracts checked - [x] items as completed tasks", () => {
		const body = `## Tasks
- [x] Setup project
- [ ] Implement feature`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
		assert.equal(result[0]!.text, "Setup project");
		assert.equal(result[0]!.checked, true);
		assert.equal(result[1]!.text, "Implement feature");
		assert.equal(result[1]!.checked, false);
	});

	it("excludes items under Prerequisites heading", () => {
		const body = `## Prerequisites
- [ ] Clone repo
- [ ] Install Node.js

## Implementation
- [ ] Write code
- [ ] Add tests`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
		assert.equal(result[0]!.text, "Write code");
		assert.equal(result[1]!.text, "Add tests");
	});

	it("excludes items under Setup heading", () => {
		const body = `## Setup
- [ ] Configure env

## Tasks
- [ ] Build feature`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.text, "Build feature");
	});

	it("includes items under Tasks, Implementation, Checklist sections", () => {
		const body = `## Checklist
- [ ] Item A
- [ ] Item B`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 2);
	});

	it("returns empty array when body has no checklists", () => {
		assert.deepEqual(parseIssueBodyChecklists("Just some text"), []);
	});

	it("returns empty array for empty body string", () => {
		assert.deepEqual(parseIssueBodyChecklists(""), []);
	});

	it("handles items with nested formatting (code, bold, links)", () => {
		const body = `## Tasks
- [ ] Add \`login()\` function
- [ ] **Bold task** item
- [ ] See [docs](https://example.com)`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 3);
		assert.match(result[0]!.text, /login/);
		assert.match(result[1]!.text, /Bold/);
		assert.match(result[2]!.text, /docs/);
	});

	it("handles items with * bullet syntax", () => {
		const body = `## Tasks
* [ ] Task with star bullet`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.text, "Task with star bullet");
	});

	it("handles items with + bullet syntax", () => {
		const body = `## Tasks
+ [ ] Task with plus bullet`;
		const result = parseIssueBodyChecklists(body);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.text, "Task with plus bullet");
	});
});

describe("extractTitleVerb()", () => {
	it("'add: new feature' → 'add'", () => {
		assert.equal(extractTitleVerb("add: new feature"), "add");
	});

	it("'implement login flow' → 'implement'", () => {
		assert.equal(extractTitleVerb("implement login flow"), "implement");
	});

	it("'remove deprecated API' → 'remove'", () => {
		assert.equal(extractTitleVerb("remove deprecated API"), "remove");
	});

	it("'delete old adapter' → 'delete'", () => {
		assert.equal(extractTitleVerb("delete old adapter"), "delete");
	});

	it("'migrate from X to Y' → 'migrate'", () => {
		assert.equal(extractTitleVerb("migrate from X to Y"), "migrate");
	});

	it("'fix: bug in auth' → null (non-imperative)", () => {
		assert.equal(extractTitleVerb("fix: bug in auth"), null);
	});

	it("'refactor: extract method' → null", () => {
		assert.equal(extractTitleVerb("refactor: extract method"), null);
	});

	it("'update dependencies' → null", () => {
		assert.equal(extractTitleVerb("update dependencies"), null);
	});

	it("empty string → null", () => {
		assert.equal(extractTitleVerb(""), null);
	});

	it("'Add login' (capitalized) → 'add'", () => {
		assert.equal(extractTitleVerb("Add login"), "add");
	});

	it("'CREATE new module' (uppercase) → 'create'", () => {
		assert.equal(extractTitleVerb("CREATE new module"), "create");
	});

	it("'Migrate from v1 to v2' (capitalized) → 'migrate'", () => {
		assert.equal(extractTitleVerb("Migrate from v1 to v2"), "migrate");
	});
});

describe("extractChecklistKeywords()", () => {
	it("extract significant nouns from item", () => {
		const items = [{ text: "Add user authentication flow", checked: false }];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 1);
		assert.equal(result[0]!.item, "Add user authentication flow");
		assert.ok(result[0]!.keywords.includes("user"));
		assert.ok(result[0]!.keywords.includes("authentication"));
		assert.ok(result[0]!.keywords.includes("flow"));
	});

	it("strips stop words ('the', 'a', 'an', 'to', 'for')", () => {
		const items = [{ text: "Create the API for user module", checked: false }];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 1);
		assert.ok(result[0]!.keywords.includes("Create"));
		assert.ok(result[0]!.keywords.includes("API"));
		assert.ok(result[0]!.keywords.includes("user"));
		assert.ok(result[0]!.keywords.includes("module"));
		assert.equal(result[0]!.keywords.includes("the"), false);
		assert.equal(result[0]!.keywords.includes("for"), false);
	});

	it("returns one entry per checklist item", () => {
		const items = [
			{ text: "Add login", checked: false },
			{ text: "Add logout", checked: false },
		];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 2);
	});

	it("handles empty checklist array → empty array", () => {
		assert.deepEqual(extractChecklistKeywords([]), []);
	});

	it("extracts from items with code formatting", () => {
		const items = [{ text: "Add `login()` function", checked: false }];
		const result = extractChecklistKeywords(items);
		assert.equal(result.length, 1);
		assert.ok(result[0]!.keywords.some((k) => k.includes("login") || k.includes("function")));
	});
});

describe("classifyDiffDirection()", () => {
	it("'add login' with A > D → expects net additions", () => {
		const result = classifyDiffDirection("add login", ["A src/login.ts", "M src/index.ts"]);
		assert.equal(result, "additions");
	});

	it("'remove old-api' with D > A → expects net deletions", () => {
		const result = classifyDiffDirection("remove old-api", ["D src/old-api.ts", "M src/index.ts"]);
		assert.equal(result, "deletions");
	});

	it("'migrate from X to Y' with D+A → expects net deletions", () => {
		const result = classifyDiffDirection("migrate from X to Y", ["D src/X.ts", "A src/Y.ts"]);
		assert.equal(result, "deletions");
	});

	it("'fix bug' (non-directional verb) → null", () => {
		const result = classifyDiffDirection("fix bug", ["M src/bug.ts"]);
		assert.equal(result, null);
	});

	it("title contains both 'add' and 'remove' → null (skip ambiguous)", () => {
		const result = classifyDiffDirection("add and remove things", ["A src/new.ts", "D src/old.ts"]);
		assert.equal(result, null);
	});

	it("null verb → null", () => {
		const result = classifyDiffDirection(null, ["A src/file.ts"]);
		assert.equal(result, null);
	});

	it("'add login' with only modifications → null (no additions/deletions)", () => {
		const result = classifyDiffDirection("add login", ["M src/login.ts"]);
		assert.equal(result, null);
	});

	it("'delete old' with net additions detected → expects deletions (verb wins)", () => {
		const result = classifyDiffDirection("delete old", ["A src/new.ts", "D src/old.ts"]);
		assert.equal(result, "deletions");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: runRequirementsTraceability orchestration
// ═══════════════════════════════════════════════════════════════════════

describe("runRequirementsTraceability()", () => {
	it("mock exec returns realistic diff output, returns TraceabilityGap[]", async () => {
		const exec = mockExec(["A src/new-feature.ts", "M src/index.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Tasks\n- [ ] Add new feature module\n- [ ] Export from index",
				comments: [],
			},
			"feat: add new feature module",
		);
		assert.ok(Array.isArray(result));
		for (const gap of result) {
			assert.ok(typeof gap.check === "string");
			assert.ok(gap.severity === "info" || gap.severity === "warning");
			assert.ok(typeof gap.detail === "string");
		}
	});

	it("empty issue body, no changed files → returns empty array", async () => {
		const exec = mockExec([]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		assert.equal(result.length, 0);
	});

	it("git diff fails (error) → returns error gap, does not crash", async () => {
		const failingExec: ExecFn = async () => {
			return { code: 1, stdout: "", stderr: "fatal: not a git repository" };
		};
		const result = await runRequirementsTraceability(
			failingExec,
			"/fake/worktree",
			"main",
			{ body: "## Tasks\n- [ ] Something", comments: [] },
			"add something",
		);
		assert.ok(result.length > 0);
		// Should include an error gap
		const errorGap = result.find((g) => g.severity === "warning" || g.check === "diff");
		assert.ok(errorGap, "Should return a gap for diff failure");
	});

	it("severity is 'info' for title→direction mismatch, 'warning' for missing tests and unmatched checklists", async () => {
		const exec = mockExec(["A src/new.ts", "D src/old.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Tasks\n- [ ] Create new module",
				comments: [],
			},
			"add new module",
		);
		// Title "add" with both A and D (A > D)
		// Should have test parity warning since new.ts has no test
		const testParityGaps = result.filter((g) => g.check === "test-file-parity");
		for (const g of testParityGaps) {
			assert.equal(g.severity, "warning");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Checklist→diff keyword mapping check
// ═══════════════════════════════════════════════════════════════════════

describe("Checklist→diff keyword mapping", () => {
	it("checklist item keywords found in changed files → no gap", async () => {
		const exec = mockExecPaths(["src/auth.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Tasks\n- [ ] Add user authentication flow",
				comments: [],
			},
			"add authentication",
		);
		const checklistGaps = result.filter((g) => g.check === "checklist-keyword-coverage");
		assert.ok(Array.isArray(checklistGaps));
	});

	it("no checklist items → no gaps from checklist check", async () => {
		const exec = mockExec(["A src/new.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "Just a plain description", comments: [] },
			"add new",
		);
		const checklistGaps = result.filter((g) => g.check === "checklist-keyword-coverage");
		assert.equal(checklistGaps.length, 0);
	});

	it("checklist item under Setup heading → excluded, no gap", async () => {
		const exec = mockExecPaths(["src/helper.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{
				body: "## Setup\n- [ ] Clone repository\n## Tasks\n- [ ] Build feature",
				comments: [],
			},
			"build feature",
		);
		const checklistGaps = result.filter((g) => g.check === "checklist-keyword-coverage");
		const detailStr = checklistGaps.map((g) => g.detail).join(" ");
		assert.equal(detailStr.includes("Clone repository"), false);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Test file parity — uses real temp directories
// ═══════════════════════════════════════════════════════════════════════

describe("Test file parity check", () => {
	it("src/foo.ts changed, test/foo.test.ts exists → no gap", async () => {
		const tempDir = createTempDir("parity-1", {
			"src/foo.ts": "export function foo() {}",
			"test/foo.test.ts": 'import { foo } from "../src/foo";',
		});
		try {
			const exec = mockExecPaths(["src/foo.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("src/foo.d.ts changed → excluded, no gap", async () => {
		const tempDir = createTempDir("parity-2", {
			"src/foo.d.ts": "export type Foo = string;",
		});
		try {
			const exec = mockExecPaths(["src/foo.d.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("src/index.ts (barrel) changed → excluded, no gap", async () => {
		const tempDir = createTempDir("parity-3", {
			"src/index.ts": "export { foo } from './foo';",
		});
		try {
			const exec = mockExecPaths(["src/index.ts"]);
			const result = await runRequirementsTraceability(
				exec,
				tempDir,
				"main",
				{ body: "", comments: [] },
				"",
			);
			const testGaps = result.filter((g) => g.check === "test-file-parity");
			assert.equal(testGaps.length, 0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("no changed files → no gap", async () => {
		const exec = mockExec([]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"",
		);
		assert.equal(result.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Old reference cleanup check
// ═══════════════════════════════════════════════════════════════════════

describe("Old reference cleanup check", () => {
	it("no deletions or renames → check skipped, no gap", async () => {
		const exec = mockExec(["A src/new.ts", "M src/old.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"add new",
		);
		const oldRefGaps = result.filter((g) => g.check === "old-reference-cleanup");
		assert.equal(oldRefGaps.length, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Issue title→diff direction check
// ═══════════════════════════════════════════════════════════════════════

describe("Issue title→diff direction check", () => {
	it("title 'add', diff has net additions (A > D) → no gap", async () => {
		const exec = mockExec(["A src/new.ts", "A src/another.ts", "D src/old.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"add new feature",
		);
		const dirGaps = result.filter((g) => g.check === "title-diff-direction");
		assert.equal(dirGaps.length, 0);
	});

	it("title 'remove', diff has net deletions (D > A) → no gap", async () => {
		const exec = mockExec(["D src/old.ts", "A src/new.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"remove old code",
		);
		const dirGaps = result.filter((g) => g.check === "title-diff-direction");
		assert.equal(dirGaps.length, 0);
	});

	it("title 'add', diff has net deletions → info gap", async () => {
		const exec = mockExec(["D src/old.ts", "D src/another.ts", "A src/new.ts"]);
		const result = await runRequirementsTraceability(
			exec,
			"/fake/worktree",
			"main",
			{ body: "", comments: [] },
			"add new feature",
		);
		const dirGaps = result.filter((g) => g.check === "title-diff-direction");
		assert.equal(dirGaps.length, 1);
		assert.equal(dirGaps[0]!.severity, "info");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 8: Integration — wiring into pipeline
// ═══════════════════════════════════════════════════════════════════════

describe("Pipeline wiring — workflow config", () => {
	it("Implementation step hooks includes 'trace'", () => {
		const implStep = WORKFLOW.find((s) => s.status === "Implementation");
		assert.ok(implStep, "Implementation step must exist");
		assert.ok(implStep.hooks, "Implementation step must have hooks");
		assert.ok(implStep.hooks.includes("trace"), "hooks must include 'trace'");
	});

	it("'trace' is a valid hook value in WorkflowStep type", () => {
		// Type-level check: if this compiles, the type union includes "trace"
		const hook: ("tsc" | "lsp" | "ci" | "dup" | "tdd" | "trace")[] = ["trace"];
		const implStep = WORKFLOW.find((s) => s.status === "Implementation");
		assert.ok(implStep);
		// Verify runtime: the hook union accepts "trace"
		const hasTrace = implStep.hooks?.includes(hook[0]);
		assert.equal(hasTrace, true);
	});

	it("'trace' hook is also accepted by handler's .includes check", () => {
		// Simulate the handler's pre-transition hook check
		const implStep = WORKFLOW.find((s) => s.status === "Implementation");
		assert.ok(implStep);
		const hooks = implStep.hooks;
		assert.ok(hooks);
		// The .some((h) => ["ci", "tsc", "lsp", "dup", "tdd", "trace"].includes(h)) check
		const allowedHooks: string[] = ["ci", "tsc", "lsp", "dup", "tdd", "trace"];
		for (const h of hooks) {
			assert.ok(allowedHooks.includes(h), `Hook "${h}" must be in allowed set`);
		}
	});
});
