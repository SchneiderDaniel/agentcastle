/**

 * Tests for harness-rules.ts — pure domain rules.
 * No infra, no pi runtime, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isSearchInBash,
	isCatHeadTailInBash,
	isLsInBash,
	isStandaloneToolCall,
	isFileModifyingBash,
	buildRedirectMessage,
	parseBashCmd,
	detectMismatchAndSuggest,
	suggestRedirection,
	MULTI_VERB_TOOLS,
	shouldBlockRetry,
	isRedundantRead,
	TOOL_META,
	getToolMeta,
} from "./harness-rules.ts";

// ── isStandaloneToolCall ──

describe("isStandaloneToolCall", () => {
	it("returns true for simple single command", () => {
		assert.equal(isStandaloneToolCall("grep foo"), true);
		assert.equal(isStandaloneToolCall("cat file.ts"), true);
		assert.equal(isStandaloneToolCall("echo hi"), true);
	});

	it("returns false for piped command", () => {
		assert.equal(isStandaloneToolCall("ls | grep foo"), false);
		assert.equal(isStandaloneToolCall("find . -name '*.ts' | xargs grep TODO"), false);
	});

	it("returns false for && chain", () => {
		assert.equal(isStandaloneToolCall("cd src && npm test"), false);
	});

	it("returns false for semicolon chain", () => {
		assert.equal(isStandaloneToolCall("echo hi; echo there"), false);
	});

	it("returns false for empty string", () => {
		assert.equal(isStandaloneToolCall(""), false);
	});
});

// ── isSearchInBash ──

describe("isSearchInBash", () => {
	it("blocks standalone grep command", () => {
		assert.equal(isSearchInBash("grep foo"), true);
	});

	it("blocks standalone rg command", () => {
		assert.equal(isSearchInBash("rg pattern"), true);
	});

	it("passes through piped grep (cmd | grep)", () => {
		assert.equal(isSearchInBash("ls | grep foo"), false);
	});

	it("passes through piped rg (cmd | rg)", () => {
		assert.equal(isSearchInBash("find . -name '*.ts' | rg pattern"), false);
	});

	it("passes through xargs grep pipeline", () => {
		assert.equal(isSearchInBash("find . -name '*.ts' | xargs grep TODO"), false);
	});

	it("passes through && chained command", () => {
		assert.equal(isSearchInBash("cd src && rg pattern"), false);
	});

	it("blocks backtick grep", () => {
		assert.equal(isSearchInBash("`grep foo`"), true);
	});

	it("blocks backtick rg", () => {
		assert.equal(isSearchInBash("`rg pattern`"), true);
	});

	it("passes through empty string", () => {
		assert.equal(isSearchInBash(""), false);
	});

	it("blocks grep with flags", () => {
		assert.equal(isSearchInBash("grep -r pattern ."), true);
	});

	it("passes through grep in quoted args (non-pipe)", () => {
		// grep not as first segment token — this would be cat file | grep
		// But without pipe, the whole command is one segment
		// If first token is "rg" it still blocks
		assert.equal(isSearchInBash("echo 'grep this'"), false);
	});
});

// ── isCatHeadTailInBash ──

describe("isCatHeadTailInBash", () => {
	it("blocks cat file read", () => {
		assert.equal(isCatHeadTailInBash("cat README.md"), true);
	});

	it("blocks head file read", () => {
		assert.equal(isCatHeadTailInBash("head -5 file"), true);
	});

	it("blocks tail file read", () => {
		assert.equal(isCatHeadTailInBash("tail -10 file"), true);
	});

	it("passes through cat with write redirect", () => {
		assert.equal(isCatHeadTailInBash("cat > /tmp/foo << EOF"), false);
	});

	it("passes through cat with append redirect", () => {
		assert.equal(isCatHeadTailInBash("cat >> file << EOF"), false);
	});

	it("passes through cat with concat redirect", () => {
		assert.equal(isCatHeadTailInBash("cat file1.ts file2.ts > combined.ts"), false);
	});

	it("passes through head in pipe (not first cmd)", () => {
		assert.equal(isCatHeadTailInBash("ls -la | head -5"), false);
	});

	it("passes through tail in pipe (not first cmd)", () => {
		assert.equal(isCatHeadTailInBash("ls -lt | tail -10"), false);
	});
});

// ── isLsInBash ──

describe("isLsInBash", () => {
	it("detects bare ls", () => {
		assert.equal(isLsInBash("ls"), true);
	});

	it("detects ls with flags", () => {
		assert.equal(isLsInBash("ls -la"), true);
	});

	it("does not detect npm ls", () => {
		assert.equal(isLsInBash("npm ls"), false);
	});

	it("does not detect empty string", () => {
		assert.equal(isLsInBash(""), false);
	});
});

// ── isFileModifyingBash ──

describe("isFileModifyingBash", () => {
	it("detects sed -i", () => {
		assert.equal(isFileModifyingBash("sed -i 's/foo/bar/g' file.ts"), true);
	});

	it("detects echo with redirect", () => {
		assert.equal(isFileModifyingBash("echo 'content' > file.ts"), true);
	});

	it("detects cat with redirect", () => {
		assert.equal(isFileModifyingBash("cat > file.ts << EOF"), true);
	});

	it("detects tee command", () => {
		assert.equal(isFileModifyingBash("echo 'x' | tee file.ts"), true);
	});

	it("detects mv command", () => {
		assert.equal(isFileModifyingBash("mv old.ts new.ts"), true);
	});

	it("detects cp command", () => {
		assert.equal(isFileModifyingBash("cp a.ts b.ts"), true);
	});

	it("detects rm command", () => {
		assert.equal(isFileModifyingBash("rm file.ts"), true);
	});

	it("detects chmod command", () => {
		assert.equal(isFileModifyingBash("chmod +x script.sh"), true);
	});

	it("detects dd command", () => {
		assert.equal(isFileModifyingBash("dd if=/dev/zero of=file bs=1M count=1"), true);
	});

	it("does not detect read-only commands", () => {
		assert.equal(isFileModifyingBash("ls -la"), false);
		assert.equal(isFileModifyingBash("git status"), false);
		assert.equal(isFileModifyingBash("npm test"), false);
	});

	it("detects bare redirect (>)", () => {
		assert.equal(isFileModifyingBash("echo hi > /tmp/test"), true);
	});

	it("returns false for empty string", () => {
		assert.equal(isFileModifyingBash(""), false);
	});
});

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

// ── detectMismatchAndSuggest ──

describe("detectMismatchAndSuggest", () => {
	it("detects standalone grep", () => {
		const result = detectMismatchAndSuggest("grep foo bar.ts");
		assert.equal(result?.category, "tool-mismatch");
		assert.ok(result?.suggestion.includes("ripgrep_search"));
	});

	it("detects cat file read", () => {
		const result = detectMismatchAndSuggest("cat file.ts");
		assert.equal(result?.category, "tool-mismatch");
		assert.ok(result?.suggestion.includes("read"));
	});

	it("returns null for normal command", () => {
		assert.equal(detectMismatchAndSuggest("echo hi"), null);
	});

	it("returns null for empty string", () => {
		assert.equal(detectMismatchAndSuggest(""), null);
	});
});

// ── suggestRedirection ──

describe("suggestRedirection", () => {
	it("suggests ripgrep_search for grep", () => {
		assert.equal(suggestRedirection("grep foo"), "ripgrep_search");
	});

	it("suggests read for cat", () => {
		assert.equal(suggestRedirection("cat file.ts"), "read");
	});

	it("returns null for normal command", () => {
		assert.equal(suggestRedirection("echo hi"), null);
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
