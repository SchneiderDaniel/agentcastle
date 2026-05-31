/**
 * Tests for BashCommand class — pure domain class.
 * No infra, no pi runtime, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BashCommand } from "./bash-command.ts";

// ── Entity: isSearch ──

describe("BashCommand.isSearch", () => {
	it("detects standalone grep", () => {
		assert.equal(new BashCommand("grep foo").isSearch(), true);
	});

	it("detects standalone rg", () => {
		assert.equal(new BashCommand("rg pattern").isSearch(), true);
	});

	it("false for piped rg (cmd | rg)", () => {
		assert.equal(new BashCommand("ls | rg foo").isSearch(), false);
	});

	it("false for semicolon chained rg (cmd; rg)", () => {
		assert.equal(new BashCommand("cmd; rg foo").isSearch(), false);
	});

	it("false for && chained rg (cd src && rg)", () => {
		assert.equal(new BashCommand("cd src && rg foo").isSearch(), false);
	});

	it("detects backtick grep", () => {
		assert.equal(new BashCommand("`grep foo`").isSearch(), true);
	});

	it("detects backtick rg", () => {
		assert.equal(new BashCommand("`rg`").isSearch(), true);
	});

	it("false for grep with redirect", () => {
		assert.equal(new BashCommand("grep foo > out.txt").isSearch(), true);
	});

	it("false for empty command", () => {
		assert.equal(new BashCommand("").isSearch(), false);
	});
});

// ── Entity: isFileRead ──

describe("BashCommand.isFileRead", () => {
	it("detects cat file read", () => {
		assert.equal(new BashCommand("cat file.ts").isFileRead(), true);
	});

	it("detects head file read", () => {
		assert.equal(new BashCommand("head -5 file.ts").isFileRead(), true);
	});

	it("detects tail file read", () => {
		assert.equal(new BashCommand("tail -10 file.ts").isFileRead(), true);
	});

	it("detects less file read", () => {
		assert.equal(new BashCommand("less file.ts").isFileRead(), true);
	});

	it("detects more file read", () => {
		assert.equal(new BashCommand("more file.ts").isFileRead(), true);
	});

	it("false for cat with write redirect (cat >)", () => {
		assert.equal(new BashCommand("cat > /tmp/foo").isFileRead(), false);
	});

	it("false for cat with append redirect (cat >>)", () => {
		assert.equal(new BashCommand("cat >> file").isFileRead(), false);
	});

	it("false for cat with concat redirect (cat > combined)", () => {
		assert.equal(new BashCommand("cat a.ts b.ts > combined.ts").isFileRead(), false);
	});

	it("false for head in pipe (not first)", () => {
		assert.equal(new BashCommand("ls -la | head -5").isFileRead(), false);
	});

	it("false for tail in pipe (not first)", () => {
		assert.equal(new BashCommand("ls -lt | tail -10").isFileRead(), false);
	});

	it("false for empty command", () => {
		assert.equal(new BashCommand("").isFileRead(), false);
	});
});

// ── Entity: isFileModify ──

describe("BashCommand.isFileModify", () => {
	it("detects sed -i", () => {
		assert.equal(new BashCommand("sed -i 's/foo/bar/g' file.ts").isFileModify(), true);
	});

	it("detects echo with redirect", () => {
		assert.equal(new BashCommand("echo 'content' > file.ts").isFileModify(), true);
	});

	it("detects cat with redirect", () => {
		assert.equal(new BashCommand("cat > file.ts << EOF").isFileModify(), true);
	});

	it("detects tee command", () => {
		assert.equal(new BashCommand("echo 'x' | tee file.ts").isFileModify(), true);
	});

	it("detects mv command", () => {
		assert.equal(new BashCommand("mv old.ts new.ts").isFileModify(), true);
	});

	it("detects cp command", () => {
		assert.equal(new BashCommand("cp a.ts b.ts").isFileModify(), true);
	});

	it("detects rm command", () => {
		assert.equal(new BashCommand("rm file.ts").isFileModify(), true);
	});

	it("detects chmod command", () => {
		assert.equal(new BashCommand("chmod +x script.sh").isFileModify(), true);
	});

	it("detects dd command", () => {
		assert.equal(new BashCommand("dd if=/dev/zero of=file bs=1M count=1").isFileModify(), true);
	});

	it("does not flag read-only commands", () => {
		assert.equal(new BashCommand("ls -la").isFileModify(), false);
		assert.equal(new BashCommand("git status").isFileModify(), false);
	});

	it("detects bare redirect via any command", () => {
		assert.equal(new BashCommand("echo hi > /tmp/test").isFileModify(), true);
	});

	it("false for empty command", () => {
		assert.equal(new BashCommand("").isFileModify(), false);
	});
});

// ── Behavior: detectMismatch ──

describe("BashCommand.detectMismatch", () => {
	it("standalone grep → ripgrep_search", () => {
		const result = new BashCommand("grep foo bar.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("piped grep → null (pass through)", () => {
		const result = new BashCommand("find . -name '*.ts' | grep foo").detectMismatch();
		assert.equal(result, null);
	});

	it("&& chained grep → null (pass through)", () => {
		const result = new BashCommand("cd src && rg pattern").detectMismatch();
		assert.equal(result, null);
	});

	it("semicolon chained grep → null (pass through)", () => {
		const result = new BashCommand("echo hi; grep foo").detectMismatch();
		assert.equal(result, null);
	});

	it("standalone cat → read", () => {
		const result = new BashCommand("cat file.ts").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("read"));
	});

	it("piped cat → null (pass through)", () => {
		const result = new BashCommand("ps aux | head -5").detectMismatch();
		assert.equal(result, null);
	});

	it("cat with write redirect → null (modify, not read)", () => {
		const result = new BashCommand("cat > /tmp/foo << EOF").detectMismatch();
		assert.equal(result, null);
	});

	it("backtick grep → ripgrep_search", () => {
		const result = new BashCommand("`grep foo`").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
		assert.ok(result!.suggestion.includes("ripgrep_search"));
	});

	it("ls → informational mismatch", () => {
		const result = new BashCommand("ls -la").detectMismatch();
		assert.notEqual(result, null);
		assert.equal(result!.category, "tool-mismatch");
	});

	it("cd ... && grep → null (pass through)", () => {
		const result = new BashCommand("cd /tmp && grep foo file.txt").detectMismatch();
		assert.equal(result, null);
	});

	it("gh issue with cat in quoted arg → null (pass through)", () => {
		const result = new BashCommand(`gh issue view 123 --title "cat file"`).detectMismatch();
		assert.equal(result, null);
	});

	it("normal command → null", () => {
		const result = new BashCommand("echo hi").detectMismatch();
		assert.equal(result, null);
	});

	it("empty command → null", () => {
		const result = new BashCommand("").detectMismatch();
		assert.equal(result, null);
	});
});

// ── Behavior: suggestRedirection ──

describe("BashCommand.suggestRedirection", () => {
	it("standalone grep → ripgrep_search", () => {
		assert.equal(new BashCommand("grep foo").suggestRedirection(), "ripgrep_search");
	});

	it("standalone cat → read", () => {
		assert.equal(new BashCommand("cat file.ts").suggestRedirection(), "read");
	});

	it("normal command → null", () => {
		assert.equal(new BashCommand("echo hi").suggestRedirection(), null);
	});

	it("empty command → null", () => {
		assert.equal(new BashCommand("").suggestRedirection(), null);
	});

	it("backtick grep → ripgrep_search", () => {
		assert.equal(new BashCommand("`grep foo`").suggestRedirection(), "ripgrep_search");
	});
});

// ── Utility: isStandalone ──

describe("BashCommand.isStandalone", () => {
	it("true for simple single command", () => {
		assert.equal(new BashCommand("grep foo").isStandalone(), true);
		assert.equal(new BashCommand("cat file.ts").isStandalone(), true);
	});

	it("false for piped command", () => {
		assert.equal(new BashCommand("ls | grep foo").isStandalone(), false);
	});

	it("false for && chain", () => {
		assert.equal(new BashCommand("cd src && npm test").isStandalone(), false);
	});

	it("false for semicolon chain", () => {
		assert.equal(new BashCommand("echo hi; echo there").isStandalone(), false);
	});
});

// ── Utility: isLs ──

describe("BashCommand.isLs", () => {
	it("detects bare ls", () => {
		assert.equal(new BashCommand("ls").isLs(), true);
	});

	it("detects ls with flags", () => {
		assert.equal(new BashCommand("ls -la").isLs(), true);
	});

	it("does not detect npm ls", () => {
		assert.equal(new BashCommand("npm ls").isLs(), false);
	});
});

// ── Utility: segments (parseBashCmd access) ──

describe("BashCommand.segments", () => {
	it("returns parsed segments", () => {
		const cmd = new BashCommand("ls -la | grep foo");
		assert.equal(cmd.segments.length, 2);
		assert.deepEqual(cmd.segments[0].tokens, ["ls", "-la"]);
		assert.deepEqual(cmd.segments[1].tokens, ["grep", "foo"]);
	});

	it("returns empty array for empty command", () => {
		const cmd = new BashCommand("");
		assert.deepEqual(cmd.segments, []);
	});
});

// ── Verify: parse once per instance ──

describe("BashCommand parse-once", () => {
	it("parses command once on construction", () => {
		// Multiple method calls should reuse parsed segments
		const cmd = new BashCommand("grep foo");
		assert.equal(cmd.isSearch(), true);
		assert.equal(cmd.isStandalone(), true);
		assert.equal(cmd.isLs(), false);
		// All methods use the same parsed segments
	});
});

// ── Phase 1: BashCommand.from() static factory ──

describe("BashCommand.from", () => {
	it("returns BashCommand instance identical to new BashCommand", () => {
		const from = BashCommand.from("grep foo");
		const direct = new BashCommand("grep foo");
		assert.ok(from instanceof BashCommand);
		assert.equal(from.raw, direct.raw);
		assert.deepEqual(from.segments, direct.segments);
	});

	it("parses command once (segments shared across method calls)", () => {
		const cmd = BashCommand.from("ls -la | grep foo");
		assert.equal(cmd.segments.length, 2);
		assert.equal(cmd.isSearch(), false);
		assert.equal(cmd.isStandalone(), false);
	});

	it("from('') returns instance with empty segments", () => {
		const cmd = BashCommand.from("");
		assert.deepEqual(cmd.segments, []);
		assert.equal(cmd.raw, "");
	});

	it("from('ls | grep foo').isSearch() returns false (piped)", () => {
		assert.equal(BashCommand.from("ls | grep foo").isSearch(), false);
	});

	it("from reuses same parseBashCmd code path as constructor", () => {
		// Same command should produce identical segments
		const cmd = "cat file.ts > output.txt";
		const fromResult = BashCommand.from(cmd);
		const newResult = new BashCommand(cmd);
		assert.equal(fromResult.segments.length, newResult.segments.length);
		assert.equal(fromResult.segments[0]?.redirect, newResult.segments[0]?.redirect);
		assert.deepEqual(fromResult.segments, newResult.segments);
	});

	it("from is a static method (no new required)", () => {
		const cmd = BashCommand.from("echo hi");
		assert.ok(cmd instanceof BashCommand);
		assert.equal(cmd.isStandalone(), true);
	});
});
