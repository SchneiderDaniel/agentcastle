/**
 * Tests for scripts/session-query.sh
 *
 * Uses Node built-in test runner with spawn for bash script tests.
 * Run with:
 *   node --experimental-strip-types --test test/session-query.test.mts
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

const SCRIPT_PATH = path.join(process.cwd(), "scripts", "session-query.sh");
const FIXTURES_DIR = path.join(process.cwd(), "test", "fixtures");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runScript(
	args: string,
	cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execSync(`${SCRIPT_PATH} ${args}`, {
			cwd: cwd || process.cwd(),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (e: any) {
		return {
			stdout: e.stdout?.toString() || "",
			stderr: e.stderr?.toString() || "",
			exitCode: e.status ?? 1,
		};
	}
}

function runScriptPipe(
	input: string,
	args: string,
	cwd?: string,
): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execSync(`echo '${input}' | ${SCRIPT_PATH} ${args}`, {
			cwd: cwd || process.cwd(),
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (e: any) {
		return {
			stdout: e.stdout?.toString() || "",
			stderr: e.stderr?.toString() || "",
			exitCode: e.status ?? 1,
		};
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-query.sh", () => {
	it("script exists and is readable", () => {
		assert.ok(fs.existsSync(SCRIPT_PATH));
		const stat = fs.statSync(SCRIPT_PATH);
		assert.ok(stat.isFile());
	});

	it("shebang line is correct", () => {
		const content = fs.readFileSync(SCRIPT_PATH, "utf-8");
		const firstLine = content.split("\n")[0];
		assert.ok(
			firstLine === "#!/usr/bin/env bash" || firstLine === "#!/bin/bash",
			`Unexpected shebang: ${firstLine}`,
		);
	});

	it("--help prints usage", () => {
		const result = runScript("--help");
		assert.strictEqual(result.exitCode, 0);
		assert.ok(result.stdout.includes("Usage"));
		assert.ok(result.stdout.includes("jq"));
	});

	it("queries error lines from fixture file", () => {
		const fixturePath = path.join(FIXTURES_DIR, "sample-session.jsonl");
		const result = runScript(`-f ${fixturePath} 'select(.error != null)'`);
		assert.strictEqual(result.exitCode, 0);
		const lines = result.stdout.trim().split("\n");
		assert.strictEqual(lines.length, 1);
		const parsed = JSON.parse(lines[0]);
		assert.ok(parsed.error !== null);
	});

	it("queries tool field from fixture file", () => {
		const fixturePath = path.join(FIXTURES_DIR, "sample-session.jsonl");
		const result = runScript(`-f ${fixturePath} 'select(.tool == "bash")'`);
		assert.strictEqual(result.exitCode, 0);
		const lines = result.stdout.trim().split("\n");
		assert.strictEqual(lines.length, 1);
	});

	it("returns all records with no filter (.)", () => {
		const fixturePath = path.join(FIXTURES_DIR, "sample-session.jsonl");
		const result = runScript(`-f ${fixturePath} '.'`);
		assert.strictEqual(result.exitCode, 0);
		const lines = result.stdout.trim().split("\n");
		assert.strictEqual(lines.length, 5);
	});

	it("extracts specific field", () => {
		const fixturePath = path.join(FIXTURES_DIR, "sample-session.jsonl");
		const result = runScript(`-f ${fixturePath} '.tool'`);
		assert.strictEqual(result.exitCode, 0);
		const lines = result.stdout.trim().split("\n");
		// jq outputs strings with quotes by default
		assert.ok(lines.includes('"session_start"'));
		assert.ok(lines.includes('"bash"'));
	});

	it("gracefully handles empty file", () => {
		let tmpDir: string;
		try {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "query-test-"));
			const emptyFile = path.join(tmpDir, "empty.jsonl");
			fs.writeFileSync(emptyFile, "");
			const result = runScript(`-f ${emptyFile} '.'`);
			// Empty file should produce no output, but not crash
			assert.ok(result.stdout.trim() === "" || result.exitCode === 0);
		} finally {
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("error on missing file", () => {
		const result = runScript("-f /tmp/nonexistent-file-12345.jsonl '.'");
		assert.ok(result.exitCode !== 0);
		assert.ok(result.stderr.includes("not found") || result.stderr.includes("Error"));
	});

	it("pipe mode works", () => {
		const jsonLine =
			'{"timestamp":"T1","agent":"user","tool":"message","error":null,"loop_step":1,"payload":{}}';
		const result = runScriptPipe(jsonLine, "'.'");
		assert.strictEqual(result.exitCode, 0);
		const parsed = JSON.parse(result.stdout.trim());
		assert.strictEqual(parsed.agent, "user");
	});

	it("pipe mode with filter", () => {
		const jsonLine =
			'{"timestamp":"T1","agent":"bash","tool":"bash","error":"fail","loop_step":1,"payload":{}}';
		const result = runScriptPipe(jsonLine, "'select(.error != null)'");
		assert.strictEqual(result.exitCode, 0);
		const parsed = JSON.parse(result.stdout.trim());
		assert.ok(parsed.error !== null);
	});

	it("malformed JSONL propagates jq error", () => {
		let tmpDir: string;
		try {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "query-test-"));
			const badFile = path.join(tmpDir, "bad.jsonl");
			fs.writeFileSync(badFile, "not valid json\n");
			const result = runScript(`-f ${badFile} '.'`);
			// jq should fail on invalid JSON
			assert.ok(result.exitCode !== 0 || result.stderr.length > 0);
		} finally {
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
