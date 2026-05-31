/**
 * Tests for python-script.ts — delimiter markers + SIGTERM handler
 *
 * Layer: (D) Domain — string constants, no infra dependencies.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRAWL4AI_SCRIPT } from "./python-script.ts";

describe("CRAWL4AI_SCRIPT — delimiter markers (Bug 1)", () => {
	it("(D) contains CRAWL4AI_OK delimiter before json.dumps output", () => {
		assert.ok(
			CRAWL4AI_SCRIPT.includes('print("CRAWL4AI_OK")'),
			"script should print CRAWL4AI_OK before JSON output",
		);
	});

	it("(D) contains CRAWL4AI_DONE delimiter after json.dumps output", () => {
		assert.ok(
			CRAWL4AI_SCRIPT.includes('print("CRAWL4AI_DONE")'),
			"script should print CRAWL4AI_DONE after JSON output",
		);
	});

	it("(D) CRAWL4AI_OK appears before CRAWL4AI_DONE in script", () => {
		const okIdx = CRAWL4AI_SCRIPT.indexOf('print("CRAWL4AI_OK")');
		const doneIdx = CRAWL4AI_SCRIPT.indexOf('print("CRAWL4AI_DONE")');
		assert.ok(okIdx >= 0, "CRAWL4AI_OK must exist");
		assert.ok(doneIdx >= 0, "CRAWL4AI_DONE must exist");
		assert.ok(okIdx < doneIdx, "CRAWL4AI_OK must appear before CRAWL4AI_DONE");
	});

	it("(D) CRAWL4AI_OK is printed before json.dumps call", () => {
		const okIdx = CRAWL4AI_SCRIPT.indexOf('print("CRAWL4AI_OK")');
		const dumpsIdx = CRAWL4AI_SCRIPT.indexOf("json.dumps");
		assert.ok(okIdx >= 0, "CRAWL4AI_OK must exist");
		assert.ok(dumpsIdx >= 0, "json.dumps must exist");
		assert.ok(okIdx < dumpsIdx, "CRAWL4AI_OK must be printed before json.dumps");
	});
});

describe("CRAWL4AI_SCRIPT — SIGTERM handler (Bug 6)", () => {
	it("(D) script imports signal module", () => {
		assert.ok(CRAWL4AI_SCRIPT.includes("import signal"), "script should import the signal module");
	});

	it("(D) script registers SIGTERM handler calling sys.exit(130)", () => {
		assert.ok(
			CRAWL4AI_SCRIPT.includes("signal.signal(signal.SIGTERM") &&
				CRAWL4AI_SCRIPT.includes("sys.exit(130)"),
			"script should register SIGTERM handler that exits with code 130",
		);
	});
});

describe("CRAWL4AI_SCRIPT — config file read instead of argv JSON parse (Bug Fix)", () => {
	it("(D) does NOT contain json.loads(sys.argv[1]) — old broken pattern absent", () => {
		assert.ok(
			!CRAWL4AI_SCRIPT.includes("json.loads(sys.argv[1])"),
			"script should NOT parse sys.argv[1] as JSON string; should read from file instead",
		);
	});

	it("(D) contains open(sys.argv[1]) — file path opened for reading", () => {
		assert.ok(
			CRAWL4AI_SCRIPT.includes("open(sys.argv[1])"),
			"script should open the config file path passed as argv[1]",
		);
	});

	it("(D) contains json.load( — deserializes from file handle, not string", () => {
		const hasJsonLoad = CRAWL4AI_SCRIPT.includes("json.load(");
		const hasJsonLoads = CRAWL4AI_SCRIPT.includes("json.loads(");
		assert.ok(hasJsonLoad, "script should use json.load() to read from file handle");
		assert.ok(!hasJsonLoads, "script should NOT use json.loads() which parses a string");
	});

	it("(D) open(sys.argv[1]) appears before json.load( in script — file opened before parsing", () => {
		const openIdx = CRAWL4AI_SCRIPT.indexOf("open(sys.argv[1])");
		const loadIdx = CRAWL4AI_SCRIPT.indexOf("json.load(");
		assert.ok(openIdx >= 0, "open(sys.argv[1]) must exist");
		assert.ok(loadIdx >= 0, "json.load( must exist");
		assert.ok(openIdx < loadIdx, "open(sys.argv[1]) must appear before json.load(");
	});

	it("(D) has with statement around open(sys.argv[1]) — proper resource cleanup", () => {
		// Find the with statement that wraps open(sys.argv[1])
		// Pattern: with open(sys.argv[1]) as <var>:
		const withOpenPattern = /with\s+open\(sys\.argv\[1\]\)\s+as\s+\w+:/;
		assert.ok(
			withOpenPattern.test(CRAWL4AI_SCRIPT),
			"script should have 'with open(sys.argv[1]) as <var>:' for proper resource cleanup",
		);
	});

	it("(D) does NOT contain json.loads( anywhere — no remaining misuse of string-parser idiom", () => {
		assert.ok(
			!CRAWL4AI_SCRIPT.includes("json.loads("),
			"script should have NO json.loads() calls anywhere",
		);
	});
});
