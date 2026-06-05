/**

 * Tests for harness-rules.ts — pure domain rules.
 * No infra, no pi runtime, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildRedirectMessage,
	parseBashCmd,
	MULTI_VERB_TOOLS,
	shouldBlockRetry,
	isRedundantRead,
	TOOL_META,
	getToolMeta,
} from "./harness-rules.ts";

// ── buildRedirectMessage ──

describe("buildRedirectMessage", () => {
	it("returns system override format for ripgrep_search", () => {
		const msg = buildRedirectMessage("ripgrep_search");
		assert.ok(msg.includes("[SYSTEM OVERRIDE]"));
		assert.ok(msg.includes("grep"));
		assert.ok(msg.includes("ripgrep_search"));
		assert.ok(msg.includes("JSON Schema"));
	});

	it("returns system override format for read", () => {
		const msg = buildRedirectMessage("read");
		assert.ok(msg.includes("[SYSTEM OVERRIDE]"));
		assert.ok(msg.includes("cat"));
		assert.ok(msg.includes("read"));
		assert.ok(msg.includes("JSON Schema"));
	});

	it("returns empty string for unknown tool", () => {
		assert.equal(buildRedirectMessage("unknown_tool"), "");
	});
});

// ── MULTI_VERB_TOOLS ──

describe("MULTI_VERB_TOOLS", () => {
	it("contains git, npm, docker, gh", () => {
		assert.ok(MULTI_VERB_TOOLS.has("git"));
		assert.ok(MULTI_VERB_TOOLS.has("npm"));
		assert.ok(MULTI_VERB_TOOLS.has("docker"));
		assert.ok(MULTI_VERB_TOOLS.has("gh"));
	});

	it("does not contain cat, echo, ls", () => {
		assert.equal(MULTI_VERB_TOOLS.has("cat"), false);
		assert.equal(MULTI_VERB_TOOLS.has("echo"), false);
		assert.equal(MULTI_VERB_TOOLS.has("ls"), false);
	});
});

// ── parseBashCmd ──

describe("parseBashCmd", () => {
	it("parses simple command", () => {
		const segs = parseBashCmd("cat file.ts");
		assert.equal(segs.length, 1);
		assert.deepEqual(segs[0].tokens, ["cat", "file.ts"]);
	});

	it("parses piped command", () => {
		const segs = parseBashCmd("ls -la | grep foo");
		assert.equal(segs.length, 2);
		assert.deepEqual(segs[0].tokens, ["ls", "-la"]);
		assert.deepEqual(segs[1].tokens, ["grep", "foo"]);
	});

	it("parses command with redirect", () => {
		const segs = parseBashCmd("echo hi > file");
		assert.equal(segs.length, 1);
		assert.ok(segs[0].redirect === "write");
	});

	it("handles empty string", () => {
		assert.deepEqual(parseBashCmd(""), []);
	});
});

// ── shouldBlockRetry ──

describe("shouldBlockRetry", () => {
	it("blocks at 2 errors", () => {
		assert.equal(shouldBlockRetry(2), true);
	});

	it("does not block at 0 errors", () => {
		assert.equal(shouldBlockRetry(0), false);
	});

	it("does not block at 1 error", () => {
		assert.equal(shouldBlockRetry(1), false);
	});
});

// ── isRedundantRead ──

describe("isRedundantRead", () => {
	it("detects same path as redundant", () => {
		assert.equal(isRedundantRead("/a.ts", "/a.ts", 1), true);
	});

	it("different paths not redundant", () => {
		assert.equal(isRedundantRead("/a.ts", "/b.ts", 1), false);
	});

	it("empty paths not redundant", () => {
		assert.equal(isRedundantRead("", "/a.ts", 1), false);
	});
});

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
