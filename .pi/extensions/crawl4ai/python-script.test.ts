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
