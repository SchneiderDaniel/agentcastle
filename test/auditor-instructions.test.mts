/**
 * Tests for auditor.md — cwd verification + worktree guard (Phase 4)
 *
 * Phase 4a: Step 0 "Verify Working Directory" heading present
 * Phase 4b: Step 0 contains "pwd" and "git branch --show-current" commands
 * Phase 4c: Step 0 references "worktreePath" and "branchName" variables
 *
 * Run with:
 *   node --experimental-strip-types --test test/auditor-instructions.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDITOR_MD = resolve(__dirname, "../.pi/extensions/supervisor/agents/auditor.md");

function readAuditorMd(): string {
	return readFileSync(AUDITOR_MD, "utf-8");
}

// ---------------------------------------------------------------------------
// Phase 4a: Step 0 "Verify Working Directory" heading
// ---------------------------------------------------------------------------

describe("auditor.md — Step 0 Verify Working Directory (Phase 4a)", () => {
	it("contains '## Step 0: Verify Working Directory' heading", () => {
		const content = readAuditorMd();
		assert.ok(
			content.includes("## Step 0: Verify Working Directory"),
			"Should have '## Step 0: Verify Working Directory' heading",
		);
	});

	it("Step 0 appears before the 'Your Role' section", () => {
		const content = readAuditorMd();
		const step0Idx = content.indexOf("## Step 0: Verify Working Directory");
		const roleIdx = content.indexOf("You are the **Auditor** agent");
		assert.ok(step0Idx >= 0, "Step 0 heading must exist");
		assert.ok(roleIdx >= 0, "'Your Role' section must exist");
		assert.ok(step0Idx < roleIdx, "Step 0 should appear before 'Your Role' section");
	});
});

// ---------------------------------------------------------------------------
// Phase 4b: Step 0 contains "pwd" and "git branch --show-current" commands
// ---------------------------------------------------------------------------

describe("auditor.md — Step 0 commands (Phase 4b)", () => {
	it("Step 0 body contains 'pwd' command", () => {
		const content = readAuditorMd();
		const step0Section = content.substring(
			content.indexOf("## Step 0"),
			content.indexOf("You are the **Auditor** agent"),
		);
		assert.ok(
			step0Section.includes("pwd") || step0Section.includes("`pwd`"),
			"Step 0 should contain pwd command",
		);
	});

	it("Step 0 body contains 'git branch --show-current' command", () => {
		const content = readAuditorMd();
		const step0Section = content.substring(
			content.indexOf("## Step 0"),
			content.indexOf("You are the **Auditor** agent"),
		);
		assert.ok(
			step0Section.includes("git branch --show-current") ||
				step0Section.includes("`git branch --show-current`"),
			"Step 0 should contain git branch --show-current command",
		);
	});

	it("Step 0 contains 'git rev-parse --is-inside-work-tree' for worktree validation", () => {
		const content = readAuditorMd();
		const step0Section = content.substring(
			content.indexOf("## Step 0"),
			content.indexOf("You are the **Auditor** agent"),
		);
		assert.ok(
			step0Section.includes("git rev-parse --is-inside-work-tree") ||
				step0Section.includes("is-inside-work-tree"),
			"Step 0 should contain git rev-parse --is-inside-work-tree check",
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 4c: Step 0 references "worktreePath" and "branchName" variables
// ---------------------------------------------------------------------------

describe("auditor.md — Step 0 references worktree path + branch (Phase 4c)", () => {
	it("Step 0 mentions 'worktree path' or 'worktreePath'", () => {
		const content = readAuditorMd();
		const step0Section = content.substring(
			content.indexOf("## Step 0"),
			content.indexOf("You are the **Auditor** agent"),
		);
		assert.ok(
			step0Section.toLowerCase().includes("worktree path") || step0Section.includes("worktreePath"),
			"Step 0 should reference worktree path",
		);
	});

	it("Step 0 mentions 'branch name' or 'branchName'", () => {
		const content = readAuditorMd();
		const step0Section = content.substring(
			content.indexOf("## Step 0"),
			content.indexOf("You are the **Auditor** agent"),
		);
		assert.ok(
			step0Section.toLowerCase().includes("branch name") || step0Section.includes("branchName"),
			"Step 0 should reference branch name",
		);
	});

	it("Step 0 references 'main checkout' as the wrong directory to avoid", () => {
		const content = readAuditorMd();
		const step0Section = content.substring(
			content.indexOf("## Step 0"),
			content.indexOf("You are the **Auditor** agent"),
		);
		assert.ok(
			step0Section.toLowerCase().includes("main checkout") ||
				step0Section.toLowerCase().includes("main checkout"),
			"Step 0 should warn about main checkout",
		);
	});

	it("Step 0 instructs to 'cd' to worktree path if pwd shows main checkout", () => {
		const content = readAuditorMd();
		const step0Section = content.substring(
			content.indexOf("## Step 0"),
			content.indexOf("You are the **Auditor** agent"),
		);
		assert.ok(
			step0Section.includes("cd to the worktree path") ||
				step0Section.includes("cd") ||
				step0Section.includes("`cd`"),
			"Step 0 should instruct to cd to worktree if in wrong directory",
		);
	});
});
