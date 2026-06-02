/**
 * Tests for types.ts — dead code verification
 *
 * Validates that unused exported interfaces are removed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const typesPath = resolve(__dirname, "types.ts");

describe("types.ts exports — dead code audit", () => {
	it("should NOT export CrawlResult (dead code removed)", () => {
		const source = readFileSync(typesPath, "utf-8");
		// CrawlResult was dead code — exported but never imported or referenced
		assert.ok(
			!source.includes("CrawlResult"),
			"CrawlResult interface should have been removed (unused export)",
		);
	});
});
