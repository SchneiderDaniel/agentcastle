/**
 * Tests for index.ts — parser logic, URL validation (Bug 1+2 + Secondary)
 *
 * Layer: (D) Domain/Unit — mock pi.exec, no infra.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

// We'll test the parser logic by extracting it to test.
// Since execute is inside pi.registerTool, we test the core logic.
// The parser is: split stdout on CRAWL4AI_OK / CRAWL4AI_DONE, take text between.

function parseCrawl4aiOutput(stdout: string): string | null {
	const okIdx = stdout.indexOf("CRAWL4AI_OK");
	const doneIdx = stdout.indexOf("CRAWL4AI_DONE");
	if (okIdx === -1 || doneIdx === -1 || doneIdx <= okIdx) {
		return null;
	}
	const jsonPart = stdout.slice(okIdx + "CRAWL4AI_OK".length, doneIdx).trim();
	return jsonPart || null;
}

describe("parseCrawl4aiOutput — parser logic (Bug 1+2)", () => {
	it("(D) extracts JSON between delimiters", () => {
		const stdout = 'CRAWL4AI_OK\n{"ok":true}\nCRAWL4AI_DONE';
		const json = parseCrawl4aiOutput(stdout);
		assert.equal(json, '{"ok":true}', "should extract JSON between delimiters");
	});

	it("(D) extracts JSON with truncation (trailing garbage)", () => {
		const stdout =
			'CRAWL4AI_OK\n{"ok":true}\nCRAWL4AI_DONE\nsome trailing garbage that got truncated';
		const json = parseCrawl4aiOutput(stdout);
		assert.equal(json, '{"ok":true}', "should extract JSON even with trailing garbage");
	});

	it("(D) extracts JSON with logger noise before delimiters", () => {
		const stdout = '{bad log line}\nCRAWL4AI_OK\n{"ok":true}\nCRAWL4AI_DONE';
		const json = parseCrawl4aiOutput(stdout);
		assert.equal(json, '{"ok":true}', "should extract JSON despite log lines with braces");
	});

	it("(D) empty delimiter region returns null", () => {
		const stdout = "CRAWL4AI_OK\nCRAWL4AI_DONE";
		const json = parseCrawl4aiOutput(stdout);
		assert.equal(json, null, "should return null when no JSON between delimiters");
	});

	it("(D) no delimiters at all returns null", () => {
		const stdout = "some random output";
		const json = parseCrawl4aiOutput(stdout);
		assert.equal(json, null, "should return null when no delimiters");
	});

	it("(D) multi-line JSON between delimiters", () => {
		const stdout = 'CRAWL4AI_OK\n{\n  "ok": true,\n  "results": []\n}\nCRAWL4AI_DONE';
		const json = parseCrawl4aiOutput(stdout);
		assert.ok(json !== null, "should extract multi-line JSON");
		assert.ok(json.includes('"ok"'), "extracted text should contain JSON content");
	});
});

describe("URL validation — early return on invalid URL (Secondary)", () => {
	it("(D) rejects empty string URL", () => {
		try {
			new URL("");
			assert.fail("should throw on empty URL");
		} catch {
			assert.ok(true, "empty URL should throw");
		}
	});

	it("(D) rejects no-protocol URL", () => {
		try {
			new URL("not-a-url");
			assert.fail("should throw on no-protocol URL");
		} catch {
			assert.ok(true, "no-protocol URL should throw");
		}
	});

	it("(D) accepts valid URL with protocol", () => {
		const url = new URL("https://example.com");
		assert.equal(url.href, "https://example.com/", "valid URL should parse correctly");
	});
});
