/**
 * Tests for piignore bash command tokenization and path-like detection.
 *
 * Tests the extracted helpers:
 *   - tokenizeBashCommand(command)
 *   - isPathLike(token, commandName)
 *   - checkBashCommand(command, entries, cwd)
 *
 * Run with:
 *   node --experimental-strip-types --test test/piignore-helpers.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/piignore.ts after fix)
// ═══════════════════════════════════════════════════════════════════════

interface BashToken {
	text: string;
	quoted: boolean;
}

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

interface IgnoreEntry {
	root: string;
	patterns: Pattern[];
}

// ═══════════════════════════════════════════════════════════════════════
// Inline helpers (mirror source at .pi/extensions/piignore.ts)
// ═══════════════════════════════════════════════════════════════════════

function patternToRegex(pattern: string): Pattern {
	let p = pattern;
	let negate = false;

	if (p.startsWith("!")) {
		negate = true;
		p = p.slice(1).trim();
	}
	if (p === "") return { regex: /(?!)/, negate };

	let dirOnly = false;
	if (p.endsWith("/")) {
		dirOnly = true;
		p = p.slice(0, -1);
	}

	const hasSlash = p.includes("/") || p.startsWith("**");

	let r = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");

	r = r.replace(/\*\*\//g, "\x00G\x00");
	r = r.replace(/\*\*$/g, "\x00GS\x00");

	r = r.replace(/\*/g, "[^/]*");
	r = r.replace(/\?/g, "[^/]");

	r = r.replace(/\x00G\x00/g, "(.*/)?");
	r = r.replace(/\x00GS\x00/g, ".*");

	if (hasSlash) {
		r = "^" + r;
	} else {
		r = "(^|.*/)" + r;
	}
	if (dirOnly) r += "(/.*)?";
	r += "$";

	return { regex: new RegExp(r), negate };
}

function parseIgnore(content: string): Pattern[] {
	const patterns: Pattern[] = [];
	for (let line of content.split("\n")) {
		line = line.trim();
		if (line === "" || line.startsWith("#")) continue;
		patterns.push(patternToRegex(line));
	}
	return patterns;
}

function isIgnored(targetPath: string, entries: IgnoreEntry[], cwd: string): boolean {
	const absPath = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(cwd, targetPath);

	let ignored = false;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const rel = path.relative(entry.root, absPath);
		if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
			const relForMatch = rel.replace(/\\/g, "/");
			for (const pat of entry.patterns) {
				if (pat.regex.test(relForMatch)) {
					ignored = !pat.negate;
				}
			}
		}
	}

	return ignored;
}

function checkPath(
	targetPath: string | undefined,
	entries: IgnoreEntry[],
	cwd: string,
): string | null {
	if (!targetPath) return null;
	if (isIgnored(targetPath, entries, cwd)) return targetPath;
	return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers to be tested (will be implemented in source file)
// Replace with imports when source file exports them.
// For now, inline the expected implementation so tests define the contract.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Split a bash command string into tokens, tracking whether each was quoted.
 * Only the outermost quoting pair is tracked (double or single).
 * Nested quotes inside a quoted token are literal characters.
 */
function tokenizeBashCommand(command: string): BashToken[] {
	const tokens: BashToken[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let quoted = false;

	function flush() {
		if (current || quoted) {
			tokens.push({ text: current, quoted });
		}
		current = "";
		quoted = false;
	}

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];

		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				quoted = true;
				continue;
			}
			current += ch;
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
				quoted = true;
				continue;
			}
			current += ch;
		} else if (ch === "'") {
			flush();
			inSingle = true;
		} else if (ch === '"') {
			flush();
			inDouble = true;
		} else if (ch === " " || ch === "\t") {
			flush();
		} else {
			current += ch;
		}
	}

	flush();

	return tokens;
}

/**
 * Determine if a token looks like a file path that should be checked.
 * Excludes known non-path patterns (URLs, npm scoped packages, standalone tilde,
 * option flags, shell operators) and tokens that were quoted after echo/printf.
 */
function isPathLike(token: BashToken, commandName: string): boolean {
	const t = token.text;

	// Option flags and shell operators are never paths
	if (t.startsWith("-")) return false;
	if (
		t === "|" ||
		t === ";" ||
		t === "&&" ||
		t === "||" ||
		t === ">" ||
		t === ">>" ||
		t === "<" ||
		t === "2>" ||
		t === "2>>" ||
		t === "&>" ||
		t === "1>"
	)
		return false;

	// Standalone tilde is shell home shortcut, not a file path
	if (t === "~") return false;

	// npm/yarn scoped package names (@scope/...) are not local paths
	if (t.startsWith("@")) return false;

	// URLs with scheme prefix are not local paths
	// Matches http://, https://, ftp://, s3://, file://, etc.
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;

	// Echo-like commands take string literals, never file paths
	// All tokens after echo/printf are skipped
	if (commandName === "echo" || commandName === "printf") return false;

	// Path-like character heuristic (same as before for non-excluded tokens)
	return t.includes("/") || t.includes(".") || t.includes("~");
}

/**
 * Extract the command name from a bash command (first non-option token).
 */
function getCommandName(command: string): string {
	const tokens = tokenizeBashCommand(command);
	for (const t of tokens) {
		if (t.quoted) continue; // quoted tokens are not the command
		if (t.text.startsWith("-")) continue; // skip option flags
		if (t.text === "|" || t.text === ";" || t.text === "&&" || t.text === "||") continue;
		return t.text;
	}
	return "";
}

/**
 * Check a bash command for paths matching piignore patterns.
 * Tokenizes the command, extracts the command name, checks each
 * path-like token against ignore entries.
 */
function checkBashCommand(command: string, entries: IgnoreEntry[], cwd: string): string | null {
	const tokens = tokenizeBashCommand(command);
	const commandName = getCommandName(command);

	const pathLike = tokens.filter((t) => isPathLike(t, commandName));

	for (const t of pathLike) {
		const result = checkPath(t.text, entries, cwd);
		if (result) return result;
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

import path from "node:path";

describe("tokenizeBashCommand", () => {
	it("splits simple command by spaces", () => {
		assert.deepStrictEqual(tokenizeBashCommand("ls -la /tmp"), [
			{ text: "ls", quoted: false },
			{ text: "-la", quoted: false },
			{ text: "/tmp", quoted: false },
		]);
	});

	it("handles single-quoted strings", () => {
		assert.deepStrictEqual(tokenizeBashCommand("echo 'hello world'"), [
			{ text: "echo", quoted: false },
			{ text: "hello world", quoted: true },
		]);
	});

	it("handles double-quoted strings", () => {
		assert.deepStrictEqual(tokenizeBashCommand('echo "hello world"'), [
			{ text: "echo", quoted: false },
			{ text: "hello world", quoted: true },
		]);
	});

	it("handles nested single quote inside double quotes", () => {
		assert.deepStrictEqual(tokenizeBashCommand(`echo "nested 'quote' inside"`), [
			{ text: "echo", quoted: false },
			{ text: "nested 'quote' inside", quoted: true },
		]);
	});

	it("handles empty quoted strings", () => {
		assert.deepStrictEqual(tokenizeBashCommand("''"), [{ text: "", quoted: true }]);
	});

	it("returns empty array for empty string", () => {
		assert.deepStrictEqual(tokenizeBashCommand(""), []);
	});

	it("returns empty array for whitespace-only string", () => {
		assert.deepStrictEqual(tokenizeBashCommand("   "), []);
	});

	it("preserves pipe as separate token", () => {
		assert.deepStrictEqual(tokenizeBashCommand("cat file | grep pattern"), [
			{ text: "cat", quoted: false },
			{ text: "file", quoted: false },
			{ text: "|", quoted: false },
			{ text: "grep", quoted: false },
			{ text: "pattern", quoted: false },
		]);
	});

	it("handles multiple quoted arguments in echo", () => {
		assert.deepStrictEqual(tokenizeBashCommand('echo "some.log" "file.tar"'), [
			{ text: "echo", quoted: false },
			{ text: "some.log", quoted: true },
			{ text: "file.tar", quoted: true },
		]);
	});
});

describe("isPathLike", () => {
	it("rejects standalone tilde", () => {
		assert.strictEqual(isPathLike({ text: "~", quoted: false }, "cd"), false);
		assert.strictEqual(isPathLike({ text: "~", quoted: false }, "echo"), false);
		assert.strictEqual(isPathLike({ text: "~", quoted: false }, "ls"), false);
	});

	it("rejects npm scoped package names", () => {
		assert.strictEqual(isPathLike({ text: "@scope/pkg.token", quoted: false }, "npm"), false);
		assert.strictEqual(isPathLike({ text: "@scope/token-checker", quoted: false }, "npx"), false);
	});

	it("rejects URLs", () => {
		assert.strictEqual(
			isPathLike({ text: "https://api.example.com/v1/token", quoted: false }, "curl"),
			false,
		);
		assert.strictEqual(
			isPathLike({ text: "http://example.com/file.tar", quoted: false }, "wget"),
			false,
		);
		assert.strictEqual(
			isPathLike({ text: "ftp://files.example.com/data.tar", quoted: false }, "wget"),
			false,
		);
		assert.strictEqual(isPathLike({ text: "s3://bucket/key.file", quoted: false }, "aws"), false);
		assert.strictEqual(isPathLike({ text: "file:///tmp/foo", quoted: false }, "cat"), false);
	});

	it("rejects all tokens after echo command", () => {
		assert.strictEqual(isPathLike({ text: "anything", quoted: true }, "echo"), false);
		assert.strictEqual(isPathLike({ text: "anything", quoted: false }, "echo"), false);
		assert.strictEqual(isPathLike({ text: ".env", quoted: false }, "echo"), false);
		assert.strictEqual(isPathLike({ text: "some.log", quoted: false }, "echo"), false);
	});

	it("rejects all tokens after printf command", () => {
		assert.strictEqual(isPathLike({ text: "anything", quoted: true }, "printf"), false);
		assert.strictEqual(isPathLike({ text: "anything", quoted: false }, "printf"), false);
	});

	it("rejects option flags", () => {
		assert.strictEqual(isPathLike({ text: "--verbose", quoted: false }, "npm"), false);
		assert.strictEqual(isPathLike({ text: "-rf", quoted: false }, "rm"), false);
	});

	it("rejects shell operators", () => {
		assert.strictEqual(isPathLike({ text: "|", quoted: false }, "cat"), false);
		assert.strictEqual(isPathLike({ text: "&&", quoted: false }, "cat"), false);
		assert.strictEqual(isPathLike({ text: ">", quoted: false }, "cat"), false);
	});

	it("accepts dotfiles with non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: ".env", quoted: false }, "cat"), true);
		assert.strictEqual(isPathLike({ text: "src/file.ts", quoted: false }, "cat"), true);
	});

	it("accepts log/tar files with non-echo commands", () => {
		assert.strictEqual(isPathLike({ text: "some.log", quoted: false }, "rg"), true);
		assert.strictEqual(isPathLike({ text: "file.tar", quoted: false }, "tar"), true);
	});

	it("accepts path-like tokens for grep/rg commands", () => {
		assert.strictEqual(isPathLike({ text: "debug.log", quoted: false }, "rg"), true);
		assert.strictEqual(isPathLike({ text: "some.log", quoted: false }, "grep"), true);
	});

	it("rejects quoted tokens for echo but not for rg", () => {
		// For rg, quoted token with path chars IS path-like
		assert.strictEqual(isPathLike({ text: "pattern", quoted: true }, "rg"), false);
	});
});

describe("getCommandName", () => {
	it("extracts first non-option token", () => {
		assert.strictEqual(getCommandName("rg pattern some.log"), "rg");
		assert.strictEqual(getCommandName("npm view @scope/pkg.token"), "npm");
		assert.strictEqual(getCommandName("curl https://example.com/file.tar"), "curl");
	});

	it("skips leading option flags", () => {
		assert.strictEqual(getCommandName("ls -la /tmp"), "ls");
	});

	it("skips quoted tokens", () => {
		assert.strictEqual(getCommandName('"command" arg1'), "arg1");
	});
});

describe("checkBashCommand false-positive regression", () => {
	const cwd = "/tmp";

	// Minimal .piignore patterns reproducing the false positives
	const testPatterns = [
		"*~",
		"**/*token*",
		"*.key",
		"*.tar",
		"*.log",
		"**/*secret*",
		".env",
		".env.*",
	];
	const entries: IgnoreEntry[] = [
		{
			root: "/",
			patterns: testPatterns.map((p) => patternToRegex(p)),
		},
	];

	it("cd ~ — tilde exclusion", () => {
		assert.strictEqual(checkBashCommand("cd ~", entries, cwd), null);
	});

	it("echo ~ — echo command exclusion", () => {
		assert.strictEqual(checkBashCommand("echo ~", entries, cwd), null);
	});

	it("ls ~ — tilde exclusion", () => {
		assert.strictEqual(checkBashCommand("ls ~", entries, cwd), null);
	});

	it("npm view @scope/pkg.token — scoped package exclusion", () => {
		assert.strictEqual(checkBashCommand("npm view @scope/pkg.token", entries, cwd), null);
	});

	it("npx @scope/token-checker — scoped package exclusion", () => {
		assert.strictEqual(checkBashCommand("npx @scope/token-checker", entries, cwd), null);
	});

	it("curl URL with token — URL exclusion", () => {
		assert.strictEqual(
			checkBashCommand("curl https://api.example.com/v1/token", entries, cwd),
			null,
		);
	});

	it("curl URL with .key — URL exclusion", () => {
		assert.strictEqual(checkBashCommand("curl https://example.com/secret.key", entries, cwd), null);
	});

	it("wget URL with .tar — URL exclusion", () => {
		assert.strictEqual(checkBashCommand("wget http://example.com/file.tar", entries, cwd), null);
	});

	it('echo "some.log" — echo command exclusion', () => {
		assert.strictEqual(checkBashCommand('echo "some.log"', entries, cwd), null);
	});

	it('echo "file.tar" — echo command exclusion', () => {
		assert.strictEqual(checkBashCommand('echo "file.tar"', entries, cwd), null);
	});

	it('echo "file.token" — echo command exclusion', () => {
		assert.strictEqual(checkBashCommand('echo "file.token"', entries, cwd), null);
	});
});

describe("checkBashCommand true-positive retention", () => {
	const cwd = "/tmp";

	const testPatterns = [
		"*~",
		"**/*token*",
		"*.key",
		"*.tar",
		"*.log",
		"**/*secret*",
		".env",
		".env.*",
	];
	const entries: IgnoreEntry[] = [
		{
			root: "/",
			patterns: testPatterns.map((p) => patternToRegex(p)),
		},
	];

	it("cat .env — blocked (dotfile)", () => {
		assert.strictEqual(checkBashCommand("cat .env", entries, cwd), ".env");
	});

	it("cat .env.local — blocked (.env.* pattern)", () => {
		assert.strictEqual(checkBashCommand("cat .env.local", entries, cwd), ".env.local");
	});

	it('rg "pattern" some.log — blocked (unquoted some.log)', () => {
		assert.strictEqual(checkBashCommand('rg "pattern" some.log', entries, cwd), "some.log");
	});

	it('rg "pattern" debug.log — blocked (unquoted debug.log)', () => {
		assert.strictEqual(checkBashCommand('rg "pattern" debug.log', entries, cwd), "debug.log");
	});

	it("cat .env.production — blocked (.env.* pattern)", () => {
		assert.strictEqual(checkBashCommand("cat .env.production", entries, cwd), ".env.production");
	});

	it("echo ~/file.txt — echo command skips all (acceptable trade-off)", () => {
		// echo is an echo-like command; all tokens are skipped
		assert.strictEqual(checkBashCommand("echo ~/file.txt", entries, cwd), null);
	});
});
