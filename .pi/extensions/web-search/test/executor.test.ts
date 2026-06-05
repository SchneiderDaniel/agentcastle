/**
 * Tests for executor.ts — shSingleQuote, runSearchScript, parseSearchOutput, parseSearchResults
 *
 * Layer: (D) Domain/Unit — mock pi.exec, temp fs via fs.mkdtempSync.
 * No real Python, no network.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecResult, ExecFn } from "../types.ts";
import { SEARCH_SCRIPT } from "../python-script.ts";
import {
	shSingleQuote,
	runSearchScript,
	parseSearchOutput,
	parseSearchResults,
} from "../executor.ts";

type ExecHandler = ExecFn;

function makeMockExec(): ReturnType<typeof mock.fn<ExecHandler>> {
	return mock.fn<ExecHandler>();
}

describe("shSingleQuote — domain tests", () => {
	it("(D) empty string returns '' (two single quotes)", () => {
		assert.equal(shSingleQuote(""), "''", "empty string should produce two single quotes");
	});

	it("(D) plain string hello returns 'hello'", () => {
		assert.equal(
			shSingleQuote("hello"),
			"'hello'",
			"plain string should be wrapped in single quotes",
		);
	});

	it("(D) string with embedded single quote it's returns 'it'\\''s'", () => {
		const result = shSingleQuote("it's");
		assert.equal(result, "'it'\\''s'", "embedded single quote should be escaped");
	});

	it("(D) string with dollar sign returns '$PATH' (literal dollar)", () => {
		assert.equal(
			shSingleQuote("$PATH"),
			"'$PATH'",
			"dollar sign should be preserved literally inside quotes",
		);
	});

	it("(D) string with space '/my path' returns '/my path'", () => {
		assert.equal(shSingleQuote("/my path"), "'/my path'", "spaces should be safely quoted");
	});

	it("(D) string with newline returns $'...' type handling — newline should not break quoting", () => {
		const result = shSingleQuote("line1\nline2");
		assert.ok(result.startsWith("'"), "should start with single quote");
		assert.ok(result.endsWith("'"), "should end with single quote");
		// Newline inside single quotes is literal in bash
		assert.ok(result.includes("line1"), "should include first line");
		assert.ok(result.includes("line2"), "should include second line");
	});

	it("(D) string with backslash returns literal backslash", () => {
		const result = shSingleQuote("C:\\path\\to\\file");
		assert.equal(
			result,
			"'C:\\path\\to\\file'",
			"backslash should be literal inside single quotes",
		);
	});
});

describe("runSearchScript — executor", () => {
	it("(D) writes script file and config file, then calls exec with bash -c", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({
			code: 0,
			stdout: "SEARCH_OK\n{}\nSEARCH_DONE",
			stderr: "",
		}));

		const result = await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test query", max_results: 5 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		const calls = exec.mock.calls;
		assert.ok(calls.length > 0, "exec should be called");
		const bashArgs = calls[0].arguments;
		assert.equal(bashArgs[0], "bash", "should run via bash");
		const fullCmd = bashArgs[1].join(" ");
		assert.ok(fullCmd.includes("search.py"), "command should reference search.py");
		assert.ok(fullCmd.includes("config.json"), "command should reference config.json");
		assert.ok(fullCmd.includes("/usr/bin/python3"), "command should reference python path");
	});

	it("(D) config is valid JSON with query, max_results keys", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({
			code: 0,
			stdout: "SEARCH_OK\n{}\nSEARCH_DONE",
			stderr: "",
		}));

		await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "typescript best practices", max_results: 7 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		// Verify config was written as valid JSON
		// We can read the config file path from the command
		const calls = exec.mock.calls;
		const bashCmd = calls[0].arguments[1].join(" ");
		// The config path should end with config.json
		const configMatch = bashCmd.match(/'([^']*config\.json)'/);
		if (configMatch) {
			const configPath = configMatch[1].replace(/\\'/g, "'");
			const configContent = fs.readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(configContent);
			assert.equal(parsed.query, "typescript best practices");
			assert.equal(parsed.max_results, 7);
		}
	});

	it("(D) includes optional proxy and timeout in config when provided", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({
			code: 0,
			stdout: "SEARCH_OK\n{}\nSEARCH_DONE",
			stderr: "",
		}));

		await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 3, proxy: "http://proxy:8080", timeout: 10 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		const calls = exec.mock.calls;
		const bashCmd = calls[0].arguments[1].join(" ");
		const configMatch = bashCmd.match(/'([^']*config\.json)'/);
		if (configMatch) {
			const configPath = configMatch[1].replace(/\\'/g, "'");
			const configContent = fs.readFileSync(configPath, "utf-8");
			const parsed = JSON.parse(configContent);
			assert.equal(parsed.proxy, "http://proxy:8080");
			assert.equal(parsed.timeout, 10);
		}
	});

	it("(D) returns exec error when exec function fails", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({
			code: 1,
			stdout: "",
			stderr: "python3: not found",
		}));

		const result = await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 5 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("not found"));
	});

	it("(D) returns error when no exec function provided", async () => {
		const result = await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 5 },
			30_000,
		);

		assert.equal(result.code, 1);
		assert.ok(result.stderr.includes("no exec function provided"));
	});

	it("(D) no base64 dependency in command", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));

		await runSearchScript(
			"/usr/bin/python3",
			SEARCH_SCRIPT,
			{ query: "test", max_results: 5 },
			30_000,
			undefined,
			exec as unknown as ExecHandler,
		);

		const calls = exec.mock.calls;
		const fullCmd = calls[0].arguments.join(" ");
		assert.ok(!fullCmd.includes("base64"), "command should not use base64");
		assert.ok(!fullCmd.includes("Buffer"), "command should not use Buffer");
	});
});

describe("parseSearchOutput — delimiter parsing", () => {
	it("(D) extracts JSON between delimiters", () => {
		const stdout = 'SEARCH_OK\n{"ok":true,"results":[]}\nSEARCH_DONE';
		const json = parseSearchOutput(stdout);
		assert.equal(json, '{"ok":true,"results":[]}', "should extract JSON between delimiters");
	});

	it("(D) extracts JSON with trailing garbage after SEARCH_DONE", () => {
		const stdout = 'SEARCH_OK\n{"ok":true}\nSEARCH_DONE\nsome trailing garbage that got truncated';
		const json = parseSearchOutput(stdout);
		assert.equal(json, '{"ok":true}', "should extract JSON even with trailing garbage");
	});

	it("(D) extracts JSON with logger noise before delimiters", () => {
		const stdout = '{bad log line}\nSEARCH_OK\n{"ok":true}\nSEARCH_DONE';
		const json = parseSearchOutput(stdout);
		assert.equal(json, '{"ok":true}', "should extract JSON despite log lines with braces");
	});

	it("(D) empty delimiter region returns null", () => {
		const stdout = "SEARCH_OK\nSEARCH_DONE";
		const json = parseSearchOutput(stdout);
		assert.equal(json, null, "should return null when no JSON between delimiters");
	});

	it("(D) no delimiters at all returns null", () => {
		const stdout = "some random output";
		const json = parseSearchOutput(stdout);
		assert.equal(json, null, "should return null when no delimiters");
	});

	it("(D) multi-line JSON between delimiters", () => {
		const stdout = 'SEARCH_OK\n{\n  "ok": true,\n  "results": []\n}\nSEARCH_DONE';
		const json = parseSearchOutput(stdout);
		assert.ok(json !== null, "should extract multi-line JSON");
		assert.ok(json.includes('"ok"'), "extracted text should contain JSON content");
	});

	it("(D) returns null when SEARCH_OK appears after SEARCH_DONE", () => {
		const stdout = 'SEARCH_DONE\n{"ok":true}\nSEARCH_OK';
		const json = parseSearchOutput(stdout);
		assert.equal(json, null, "should return null when delimiters are reversed");
	});
});

describe("parseSearchResults — result parsing", () => {
	it("(D) parses successful results correctly", () => {
		const stdout =
			'SEARCH_OK\n{"ok":true,"results":[{"title":"Test","url":"https://example.com","snippet":"A test result"}]}\nSEARCH_DONE';
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0].title, "Test");
			assert.equal(result.results[0].url, "https://example.com");
			assert.equal(result.results[0].snippet, "A test result");
		}
	});

	it("(D) handles error response from script", () => {
		const stdout = 'SEARCH_OK\n{"ok":false,"error":"ddgs not installed"}\nSEARCH_DONE';
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("ddgs not installed"));
		}
	});

	it("(D) handles no delimited output", () => {
		const stdout = "some random output";
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("No delimited output found"));
		}
	});

	it("(D) handles malformed JSON", () => {
		const stdout = "SEARCH_OK\n{broken json\nSEARCH_DONE";
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === false);
		if (!result.ok) {
			assert.ok(result.error.includes("Failed to parse"));
		}
	});

	it("(D) handles empty results array", () => {
		const stdout = 'SEARCH_OK\n{"ok":true,"results":[]}\nSEARCH_DONE';
		const result = parseSearchResults(stdout);
		assert.ok(result.ok === true);
		if (result.ok) {
			assert.equal(result.results.length, 0);
		}
	});
});
