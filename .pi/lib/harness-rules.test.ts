/**
 * Tests for harness-rules.ts — Bug 7: web_crawl cascade threshold
 *
 * Layer: (D) Domain — pure functions, no infra, no side effects.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOOL_META, getToolMeta } from "./harness-rules.ts";

describe("TOOL_META — web_crawl cascade threshold (Bug 7)", () => {
	it("(D) TOOL_META has web_crawl entry with cascadeThreshold", () => {
		assert.ok(TOOL_META.web_crawl, "TOOL_META should have web_crawl entry");
		assert.equal(
			TOOL_META.web_crawl.cascadeThreshold,
			20,
			"web_crawl cascadeThreshold should be 20",
		);
	});

	it("(D) getToolMeta('web_crawl') returns threshold 20", () => {
		const meta = getToolMeta("web_crawl");
		assert.equal(meta.cascadeThreshold, 20, "getToolMeta('web_crawl').cascadeThreshold === 20");
	});

	it("(D) web_crawl threshold > default cascade threshold (8)", () => {
		const webMeta = getToolMeta("web_crawl");
		const bashMeta = getToolMeta("bash");
		assert.ok(
			(webMeta.cascadeThreshold ?? 8) > (bashMeta.cascadeThreshold ?? 8),
			"web_crawl threshold should be higher than default",
		);
	});

	it("(D) Existing passThrough tools unchanged", () => {
		assert.deepEqual(getToolMeta("ask_user"), { passThrough: true });
		assert.deepEqual(getToolMeta("structural_search"), { passThrough: true });
		assert.deepEqual(getToolMeta("ripgrep_search"), { passThrough: true });
		assert.deepEqual(getToolMeta("ranked_map"), { passThrough: true });
	});

	it("(D) bash still has default cascadeThreshold", () => {
		const bashMeta = getToolMeta("bash");
		assert.equal(bashMeta.passThrough, undefined);
		assert.equal(bashMeta.cascadeThreshold, 8);
	});

	it("(Regression) unlisted tools get default meta", () => {
		const meta = getToolMeta("unknown_tool");
		assert.deepEqual(meta, { passThrough: false, cascadeThreshold: 8 });
	});
});
