/**
 * Tests for index.ts — tool registration, parameter validation, cache, result formatting
 *
 * Layer: (D) Domain/Unit — mock pi.exec, no network.
 * Tests the real webSearch implementation with mocked pi.exec.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn, ExecResult } from "../types.ts";
import webSearch, { formatResults } from "../index.ts";

// ── Mock exec helpers ──

/** Return the same ExecResult for every call */
function mockExecReturns(result: ExecResult): ExecFn {
	return async () => result;
}

/** Return ExecResults in sequence, repeating the last result for extra calls */
function mockExecSequence(results: ExecResult[]): ExecFn {
	let i = 0;
	return async () =>
		results[i++] ?? results[results.length - 1] ?? { code: 0, stdout: "", stderr: "" };
}

// ── Test helper: register the real webSearch tool with a mock pi.exec ──

interface MockPi {
	registerTool: (tool: any) => void;
	exec: ExecFn;
}

function registerWebSearch(mockExec: ExecFn): any {
	let tool: any;
	const mockPi: MockPi = {
		registerTool: (t: any) => {
			tool = t;
		},
		exec: mockExec,
	};
	webSearch(mockPi as any);
	return tool;
}

// ===========================================================================
// Module exports
// ===========================================================================

describe("webSearch module exports", () => {
	it("(D) exports webSearch as a function", () => {
		assert.equal(typeof webSearch, "function");
	});

	it("(D) exports formatResults as a function", () => {
		assert.equal(typeof formatResults, "function");
	});
});

// ===========================================================================
// Registration metadata
// ===========================================================================

describe("web-search extension entry point", () => {
	it("(D) registers web_search tool on pi.registerTool", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.equal(tool.name, "web_search");
	});

	it("(D) registered tool has execute function", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.equal(typeof tool.execute, "function");
	});

	it("(D) registered tool has query and optional maxResults parameters", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.ok(tool.parameters.properties?.query !== undefined);
		assert.ok(tool.parameters.properties?.maxResults !== undefined);
	});

	it("(D) registered tool has name, label, description fields", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.equal(tool.name, "web_search");
		assert.equal(tool.label, "Web Search");
		assert.ok(typeof tool.description === "string");
		assert.ok(tool.description.length > 20);
	});

	it("(D) registered tool has promptSnippet field", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.ok(typeof tool.promptSnippet === "string");
		assert.ok(tool.promptSnippet.toLowerCase().includes("search"));
	});

	it("(D) registered tool includes promptGuidelines array", () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		assert.ok(Array.isArray(tool.promptGuidelines));
		assert.ok(tool.promptGuidelines.length > 0);
		assert.ok(tool.promptGuidelines.every((g: any) => typeof g === "string"));
	});
});

// ===========================================================================
// execute — parameter validation (no exec calls needed, checks throw)
// ===========================================================================

describe("web_search.execute — parameter validation", () => {
	it("(D) execute validates query parameter — empty query throws error", async () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		await assert.rejects(
			tool.execute("call1", { query: "" }, undefined, undefined, { cwd: "/test-empty" }),
			{ message: "Search query is empty" },
		);
	});

	it("(D) execute validates query parameter — whitespace-only query throws error", async () => {
		const tool = registerWebSearch(mockExecReturns({ code: 0, stdout: "", stderr: "" }));
		await assert.rejects(
			tool.execute("call1", { query: "   " }, undefined, undefined, { cwd: "/test-ws" }),
			{ message: "Search query is empty" },
		);
	});
});

// ===========================================================================
// execute — error paths requiring exec mocking
// ===========================================================================

describe("web_search.execute — error paths with exec mocking", () => {
	it("(D) execute throws on venv setup failure", async () => {
		// All exec calls return code 1 → ensureWebSearchVenv returns null → throw
		const tool = registerWebSearch(mockExecReturns({ code: 1, stdout: "", stderr: "no python3" }));
		await assert.rejects(
			tool.execute("call1", { query: "venv-test" }, undefined, undefined, {
				cwd: "/test-venv-fail",
			}),
			{ message: /Python virtual environment/ },
		);
	});

	it("(D) execute throws on search script non-zero exit", async () => {
		// Calls: 1=python3 --version (ok), 2=venv ddgs check (ok), 3=bash script (fail)
		const tool = registerWebSearch(
			mockExecSequence([
				{ code: 0, stdout: "Python 3.11", stderr: "" },
				{ code: 0, stdout: "ok", stderr: "" },
				{ code: 1, stdout: "", stderr: "search error" },
			]),
		);
		await assert.rejects(
			tool.execute("call1", { query: "search-test" }, undefined, undefined, {
				cwd: "/test-search-fail",
			}),
			{ message: /Search failed: python3 error/ },
		);
	});

	it("(D) execute throws on parse failure", async () => {
		// Calls: 1=python3 --version (ok), 2=venv ddgs check (ok), 3=bash script (ok but unparseable stdout)
		const tool = registerWebSearch(
			mockExecSequence([
				{ code: 0, stdout: "Python 3.11", stderr: "" },
				{ code: 0, stdout: "ok", stderr: "" },
				{ code: 0, stdout: "no delimiters here", stderr: "" },
			]),
		);
		await assert.rejects(
			tool.execute("call1", { query: "parse-test" }, undefined, undefined, {
				cwd: "/test-parse-fail",
			}),
			{ message: /Search failed/ },
		);
	});
});

// ===========================================================================
// formatResults — result formatting
// ===========================================================================

describe("formatResults — result formatting", () => {
	it("(D) formats results with rank numbers, titles as links, snippets", () => {
		const results = [
			{ title: "Result 1", url: "https://example.com/1", snippet: "First result snippet" },
			{ title: "Result 2", url: "https://example.com/2", snippet: "Second result snippet" },
		];
		assert.ok(formatResults(results).includes("1. [Result 1](https://example.com/1)"));
		assert.ok(formatResults(results).includes("First result snippet"));
		assert.ok(formatResults(results).includes("2. [Result 2](https://example.com/2)"));
		assert.ok(formatResults(results).includes("Second result snippet"));
	});

	it("(D) returns 'No results found.' for empty array", () => {
		assert.equal(formatResults([]), "No results found.");
	});
});

// ===========================================================================
// Cache functionality
// ===========================================================================

describe("Cache functionality", () => {
	it("(D) cache stores results and returns cached on repeated call", async () => {
		let callCount = 0;
		const mockExec: ExecFn = async () => {
			callCount++;
			if (callCount === 1) return { code: 0, stdout: "Python 3.11", stderr: "" };
			if (callCount === 2) return { code: 0, stdout: "ok", stderr: "" };
			// Search script succeeds with valid output (matches python-script.ts format)
			const searchResults = [
				{ title: "Cached", url: "https://example.com", snippet: "Cached result" },
			];
			return {
				code: 0,
				stdout: `SEARCH_OK\n${JSON.stringify({ ok: true, results: searchResults })}\nSEARCH_DONE`,
				stderr: "",
			};
		};

		const tool = registerWebSearch(mockExec);

		// First call — should succeed and populate cache
		const result1 = await tool.execute("call1", { query: "cache-test" }, undefined, undefined, {
			cwd: "/test-cache",
		});
		assert.equal(
			result1.content[0].text,
			formatResults([{ title: "Cached", url: "https://example.com", snippet: "Cached result" }]),
		);

		// Second call with same query — should use cache, no additional exec calls
		const result2 = await tool.execute("call2", { query: "cache-test" }, undefined, undefined, {
			cwd: "/test-cache",
		});
		assert.equal(result2.content[0].text, result1.content[0].text);
		assert.equal(callCount, 3); // No extra exec calls on second invocation
	});
});
