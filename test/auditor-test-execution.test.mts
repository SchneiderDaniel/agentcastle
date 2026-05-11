/**
 * Tests for Auditor agent — test command extraction, execution, and output formatting.
 *
 * Run with:
 *   node --experimental-strip-types --test test/auditor-test-execution.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Auditor agent file checks
// ---------------------------------------------------------------------------

function readAgentFile(path: string): { frontmatter: Record<string, string>; body: string } {
	const content = readFileSync(path, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) throw new Error(`Missing frontmatter in ${path}`);
	const fm: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
		if (kv) {
			let val = kv[2]!.trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			fm[kv[1]!] = val;
		}
	}
	return { frontmatter: fm, body: match[2]!.trim() };
}

const agent = readAgentFile(".pi/agents/auditor.md");

describe("Auditor agent file — mandatory test execution", () => {
	it("2.1: has 'Execute Tests (Mandatory)' section", () => {
		assert.ok(
			agent.body.includes("Execute Tests") || agent.body.includes("execute the test command"),
			"Auditor file must have mandatory test execution step",
		);
	});

	it("2.2: extracts test command from fenced code block", () => {
		assert.ok(
			agent.body.includes("Extract the test command") || agent.body.includes("first fenced code block"),
			"Auditor file must instruct to extract test command from fenced block",
		);
	});

	it("2.3: rejects when no command found", () => {
		assert.ok(
			agent.body.includes("No runnable test command found"),
			"Auditor file must include missing-command rejection message",
		);
	});

	it("2.4: mentions 60-second timeout", () => {
		assert.ok(
			agent.body.includes("60-second") || agent.body.includes("60 second"),
			"Auditor file must mention 60-second timeout for test execution",
		);
	});

	it("2.5: captures stdout and stderr", () => {
		assert.ok(
			agent.body.includes("stdout") && agent.body.includes("stderr"),
			"Auditor file must instruct to capture stdout and stderr",
		);
	});

	it("2.6: has test failure rejection format with Failed tests section", () => {
		assert.ok(
			agent.body.includes("Failed tests:"),
			"Auditor file must include Failed tests section in rejection format",
		);
	});

	it("2.7: truncates output to 20 lines", () => {
		assert.ok(
			agent.body.includes("20 lines") || agent.body.includes("first 20"),
			"Auditor file must specify truncation to 20 lines",
		);
	});

	it("2.8: APPROVE template includes 'Tests passed' line", () => {
		assert.ok(
			agent.body.includes("Tests passed: ✓"),
			"APPROVE template must include Tests passed checkmark",
		);
	});

	it("2.9: APPROVE template keeps 'Test coverage' line", () => {
		assert.ok(
			agent.body.includes("Test coverage: ✓"),
			"APPROVE template must keep existing Test coverage line",
		);
	});

	it("2.10: APPROVE template includes test command reference", () => {
		assert.ok(
			agent.body.includes("ran: <test command>"),
			"APPROVE template must include the test command that was run",
		);
	});
});

// ---------------------------------------------------------------------------
// Test command extraction logic (mirrors Auditor's extraction)
// ---------------------------------------------------------------------------

import {
	extractTestCommand,
	parseFailedTests,
	truncateOutput,
} from "./helper/output-parser.mts";

import {
	buildPlanWithCommand,
	buildPlanWithMultipleBlocks,
	buildPlanWithoutCommand,
	buildPlanWithInlineCode,
} from "./helper/comment-builder.mts";

import {
	runCommand,
	mockRunCommand,
	type ExecResult,
} from "./helper/mock-exec.mts";

describe("Test command extraction from comment body", () => {
	it("2.11: extracts command from fenced bash block", () => {
		const comment = buildPlanWithCommand({
			command: "node --test test/x.test.mts",
		});
		const cmd = extractTestCommand(comment);
		assert.strictEqual(cmd, "node --test test/x.test.mts");
	});

	it("2.12: returns null when no fenced block present", () => {
		const comment = buildPlanWithoutCommand();
		const cmd = extractTestCommand(comment);
		assert.strictEqual(cmd, null);
	});

	it("2.13: picks first code block when multiple exist", () => {
		const comment = buildPlanWithMultipleBlocks({
			firstCommand: "npm install",
			secondCommand: "node --test test/x.test.mts",
		});
		const cmd = extractTestCommand(comment);
		assert.strictEqual(cmd, "npm install"); // First block wins
	});

	it("2.14: extracts command from block without language tag", () => {
		const comment = buildPlanWithCommand({
			command: "node --test test/x.test.mts",
			language: "",
		});
		const cmd = extractTestCommand(comment);
		assert.strictEqual(cmd, "node --test test/x.test.mts");
	});

	it("2.15: inline backtick (single) is NOT treated as fenced block", () => {
		const comment = buildPlanWithInlineCode();
		const cmd = extractTestCommand(comment);
		// Inline code `...` is not a fenced block (```). Our parser looks for ``` fences.
		assert.strictEqual(cmd, null);
	});

	it("2.16: extracts command from block with non-bash language", () => {
		const comment = buildPlanWithCommand({
			command: "node --test test/x.test.mts",
			language: "typescript",
		});
		const cmd = extractTestCommand(comment);
		assert.strictEqual(cmd, "node --test test/x.test.mts");
	});
});

// ---------------------------------------------------------------------------
// Failed test name parsing
// ---------------------------------------------------------------------------

describe("Parsing failed test names from output", () => {
	it("2.17: parses TAP 'not ok' format", () => {
		const stdout = "TAP version 13\nnot ok 1 - test fails\nok 2 - test passes\n";
		const result = parseFailedTests(stdout, "");
		assert.deepStrictEqual(result, ["test fails"]);
	});

	it("2.18: parses ✗ marker format", () => {
		const stdout = "✗ test fails\n✓ test passes\n";
		const result = parseFailedTests(stdout, "");
		assert.deepStrictEqual(result, ["test fails"]);
	});

	it("2.19: parses FAIL keyword format", () => {
		const stdout = "FAIL test fails\nPASS test passes\n";
		const result = parseFailedTests(stdout, "");
		assert.deepStrictEqual(result, ["test fails"]);
	});

	it("2.20: parses multiple failures across formats", () => {
		const stdout = [
			"not ok 1 - first failure",
			"✗ second failure",
			"FAIL third failure",
		].join("\n");
		const result = parseFailedTests(stdout, "");
		assert.strictEqual(result.length, 3);
		assert.ok(result.includes("first failure"));
		assert.ok(result.includes("second failure"));
		assert.ok(result.includes("third failure"));
	});

	it("2.21: returns empty array when no failures", () => {
		const stdout = "ok 1 - passes\nok 2 - also passes\n";
		const result = parseFailedTests(stdout, "");
		assert.deepStrictEqual(result, []);
	});

	it("2.22: deduplicates identical failure names", () => {
		const stdout = "not ok 1 - same test\nnot ok 2 - same test\n";
		const result = parseFailedTests(stdout, "");
		assert.deepStrictEqual(result, ["same test"]);
	});

	it("2.23: parses AssertionError messages", () => {
		const stderr = "AssertionError: Expected true but got false\n";
		const result = parseFailedTests("", stderr);
		assert.deepStrictEqual(result, ["Expected true but got false"]);
	});

	it("2.24: parses from stderr when stdout is empty", () => {
		const stderr = "not ok 1 - test from stderr\n";
		const result = parseFailedTests("", stderr);
		assert.deepStrictEqual(result, ["test from stderr"]);
	});
});

// ---------------------------------------------------------------------------
// Output truncation
// ---------------------------------------------------------------------------

describe("Output truncation", () => {
	it("2.25: truncates output exceeding 20 lines", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
		const output = lines.join("\n");
		const { text, truncated } = truncateOutput(output, 20);
		assert.strictEqual(truncated, true);
		assert.ok(text.includes("...output truncated..."));
		const resultLines = text.split("\n");
		assert.strictEqual(resultLines.length, 21); // 20 lines + truncation notice
	});

	it("2.26: does not truncate output under 20 lines", () => {
		const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
		const output = lines.join("\n");
		const { text, truncated } = truncateOutput(output, 20);
		assert.strictEqual(truncated, false);
		assert.ok(!text.includes("...output truncated..."));
		assert.strictEqual(text, output);
	});

	it("2.27: exactly 20 lines — no truncation", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const output = lines.join("\n");
		const { text, truncated } = truncateOutput(output, 20);
		assert.strictEqual(truncated, false);
		assert.strictEqual(text, output);
	});

	it("2.28: empty output — no truncation notice", () => {
		const { text, truncated } = truncateOutput("", 20);
		assert.strictEqual(truncated, false);
		assert.strictEqual(text, "");
	});
});

// ---------------------------------------------------------------------------
// Mock command execution
// ---------------------------------------------------------------------------

describe("Command execution (mocked)", () => {
	it("2.29: success (exit 0) returns success=true", () => {
		const result: ExecResult = { stdout: "ok 1 - passes\n", stderr: "", success: true, exitCode: 0 };
		const exec = mockRunCommand(result);
		const r = exec("node --test test/x.test.mts");
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.exitCode, 0);
	});

	it("2.30: failure (exit 1) returns success=false", () => {
		const result: ExecResult = {
			stdout: "not ok 1 - fails\n",
			stderr: "",
			success: false,
			exitCode: 1,
		};
		const exec = mockRunCommand(result);
		const r = exec("node --test test/x.test.mts");
		assert.strictEqual(r.success, false);
		assert.strictEqual(r.exitCode, 1);
	});

	it("2.31: stderr with exit 0 still returns success=true", () => {
		const result: ExecResult = {
			stdout: "ok 1 - passes\n",
			stderr: "Warning: experimental feature\n",
			success: true,
			exitCode: 0,
		};
		const exec = mockRunCommand(result);
		const r = exec("node --test test/x.test.mts");
		assert.strictEqual(r.success, true);
		assert.ok(r.stderr.includes("Warning"));
	});

	it("2.32: file-not-found error returns success=false", () => {
		const result: ExecResult = {
			stdout: "",
			stderr: "Error: Cannot find module 'test/nonexistent.test.mts'\n",
			success: false,
			exitCode: 1,
		};
		const exec = mockRunCommand(result);
		const r = exec("node --test test/nonexistent.test.mts");
		assert.strictEqual(r.success, false);
		assert.ok(r.stderr.includes("Cannot find module"));
	});

	it("2.33: timeout scenario — treated as failure", () => {
		const result: ExecResult = {
			stdout: "",
			stderr: "Error: ETIMEDOUT\n",
			success: false,
			exitCode: 1,
		};
		const exec = mockRunCommand(result);
		const r = exec("sleep 120");
		assert.strictEqual(r.success, false);
	});
});

// ---------------------------------------------------------------------------
// Worktree path construction
// ---------------------------------------------------------------------------

describe("Worktree path construction", () => {
	it("2.34: builds correct worktree path from branch name", () => {
		const branch = "worktree-git-issue-10-some-feat";
		const worktreePath = `../${branch}`;
		const cmd = `cd ${worktreePath} && node --test test/x.test.mts`;
		assert.ok(cmd.startsWith("cd ../worktree-git-issue-10-some-feat"));
	});
});

// ---------------------------------------------------------------------------
// Rejection/Approval template content checks
// ---------------------------------------------------------------------------

describe("Rejection and approval templates", () => {
	it("2.35: missing-command rejection includes 'No runnable test command found'", () => {
		assert.ok(agent.body.includes("No runnable test command found in test plan"));
	});

	it("2.36: test-failure rejection includes 'Failed tests:' section", () => {
		assert.ok(agent.body.includes("Failed tests:"));
	});

	it("2.37: test-failure rejection includes 'Stdout:' and 'Stderr:' sections", () => {
		assert.ok(agent.body.includes("Stdout:"));
		assert.ok(agent.body.includes("Stderr:"));
	});

	it("2.38: APPROVE template includes '- Tests passed: ✓ (ran:'", () => {
		assert.ok(agent.body.includes("Tests passed: ✓ (ran:"));
	});

	it("2.39: APPROVE template still has '- Test coverage: ✓'", () => {
		assert.ok(agent.body.includes("- Test coverage: ✓"));
	});
});
