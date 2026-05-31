/**
 * Tests for .pi/extensions/piignore.ts — resources_discover handler cwd fix
 *
 * Verifies loadPiIgnore respects the provided cwd, not process.cwd().
 * This mirrors the fix: resources_discover handler must pass ctx.cwd
 * instead of process.cwd() to loadPiIgnore.
 *
 * Inline logic follows the pattern of other tests in this directory.
 *
 * Run with:
 *   node --experimental-strip-types --test test/piignore.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/piignore.ts)
// ═══════════════════════════════════════════════════════════════════════

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

interface IgnoreEntry {
	root: string;
	patterns: Pattern[];
}

// ═══════════════════════════════════════════════════════════════════════
// Inline functions (match source at .pi/extensions/piignore.ts exactly)
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

	// Step 1a: Extract and preserve bracket expressions
	const bracketExprs: string[] = [];
	let r = p.replace(/\[([^\]]*)\]/g, (match) => {
		bracketExprs.push(match);
		return `\x00B${bracketExprs.length - 1}\x00`;
	});

	// Step 1b: Escape regex meta-characters except *, ?, [, ]
	r = r.replace(/[.+^${}()|\\]/g, "\\$&");

	// Step 1c: Escape unclosed [ (bracket without matching ]) as literal
	r = r.replace(/\[/g, "\\[");

	r = r.replace(/\*\*\//g, "\x00G\x00");
	r = r.replace(/\*\*$/g, "\x00GS\x00");

	r = r.replace(/\*/g, "[^/]*");
	r = r.replace(/\?/g, "[^/]");

	r = r.replace(/\x00G\x00/g, "(.*/)?");
	r = r.replace(/\x00GS\x00/g, ".*");

	// Step 4b: Restore bracket expressions
	for (let i = 0; i < bracketExprs.length; i++) {
		let expr = bracketExprs[i];
		if (expr.startsWith("[!")) {
			expr = "[^" + expr.slice(2);
		}
		if (expr === "[]") {
			expr = "\\[\\]";
		}
		r = r.split(`\x00B${i}\x00`).join(expr);
	}

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

/** Walk up from cwd to filesystem root, collecting .piignore files. */
function loadPiIgnore(cwd: string): IgnoreEntry[] {
	const entries: IgnoreEntry[] = [];
	let dir = cwd;
	while (true) {
		const ignorePath = path.join(dir, ".piignore");
		if (fs.existsSync(ignorePath)) {
			entries.push({
				root: dir,
				patterns: parseIgnore(fs.readFileSync(ignorePath, "utf-8")),
			});
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return entries;
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

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("piignore extension", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-test-"));
	const nonCwdDir = path.join(tmpRoot, "other-project");

	beforeEach(() => {
		fs.mkdirSync(nonCwdDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	describe("loadPiIgnore uses provided cwd (not process.cwd())", () => {
		it("should find .piignore in a non-process-cwd directory when given that directory", () => {
			// Write .piignore only in nonCwdDir (not in process.cwd())
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "secret.txt\n", "utf-8");

			// Load using nonCwdDir as context cwd — this is what the
			// resources_discover handler should do with ctx.cwd
			const entries = loadPiIgnore(nonCwdDir);

			// Must find the .piignore in nonCwdDir
			assert.strictEqual(entries.length, 1, "should find .piignore in nonCwdDir");
			assert.strictEqual(entries[0].root, nonCwdDir);

			// Verify ignoring works relative to nonCwdDir
			assert.strictEqual(
				isIgnored("secret.txt", entries, nonCwdDir),
				true,
				"secret.txt should be ignored in nonCwdDir context",
			);
			assert.strictEqual(
				isIgnored("public.txt", entries, nonCwdDir),
				false,
				"public.txt should not be ignored",
			);
		});

		it("should NOT find .piignore in nonCwdDir when using process.cwd() (demonstrates the bug)", () => {
			// This test demonstrates why resources_discover handler must use
			// ctx.cwd instead of process.cwd(). If handler uses process.cwd(),
			// a .piignore in a different session directory is missed entirely.
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "secret.txt\n", "utf-8");

			// Load using process.cwd() — this is what the buggy handler does
			const entries = loadPiIgnore(process.cwd());

			// Should NOT find the .piignore in nonCwdDir
			const foundNonCwd = entries.some((e) => e.root === nonCwdDir);
			assert.strictEqual(
				foundNonCwd,
				false,
				"should NOT find .piignore in nonCwdDir when using process.cwd()",
			);
		});

		it("should walk up parent directories from provided cwd", () => {
			// Write .piignore in tmpRoot (parent of nonCwdDir)
			fs.writeFileSync(path.join(tmpRoot, ".piignore"), "global.txt\n", "utf-8");

			// Write a more specific .piignore in nonCwdDir
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "local.txt\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			// Should find both parent and child .piignore files
			assert.ok(entries.length >= 2, "should find .piignore in nonCwdDir and parent");

			assert.strictEqual(isIgnored("local.txt", entries, nonCwdDir), true);
			assert.strictEqual(isIgnored("global.txt", entries, nonCwdDir), true);
		});

		it("should let child .piignore negation override parent ignore patterns", () => {
			fs.writeFileSync(path.join(tmpRoot, ".piignore"), "*.env\n", "utf-8");
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "!important.env\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			assert.strictEqual(isIgnored("important.env", entries, nonCwdDir), false);
			assert.strictEqual(isIgnored("debug.env", entries, nonCwdDir), true);
		});
	});

	describe("isIgnored behavior", () => {
		it("should respect negation patterns", () => {
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "*.log\n!important.log\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			assert.strictEqual(isIgnored("debug.log", entries, nonCwdDir), true);
			assert.strictEqual(isIgnored("important.log", entries, nonCwdDir), false);
		});

		it("should handle directory patterns", () => {
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "build/\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			assert.strictEqual(isIgnored("build", entries, nonCwdDir), true);
			assert.strictEqual(isIgnored("src/index.ts", entries, nonCwdDir), false);
		});

		it("should handle absolute paths correctly", () => {
			fs.writeFileSync(path.join(nonCwdDir, ".piignore"), "secret.txt\n", "utf-8");

			const entries = loadPiIgnore(nonCwdDir);

			const absPath = path.join(nonCwdDir, "secret.txt");
			assert.strictEqual(isIgnored(absPath, entries, nonCwdDir), true);
		});
	});
});
