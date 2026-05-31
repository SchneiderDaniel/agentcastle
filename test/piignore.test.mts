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
// Fixed getEntries (cwd-aware caching — matches the fix)
// ═══════════════════════════════════════════════════════════════════════

function createGetEntries_fixed(): {
	getEntries: (cwd: string) => IgnoreEntry[];
	getCallCount: () => number;
} {
	let _cachedCwd: string | null = null;
	let _entries: IgnoreEntry[] | null = null;
	let _loadCount = 0;

	return {
		getEntries(cwd: string): IgnoreEntry[] {
			if (!_entries || _cachedCwd !== cwd) {
				_entries = loadPiIgnore(cwd);
				_cachedCwd = cwd;
				_loadCount++;
			}
			return _entries;
		},
		getCallCount: () => _loadCount,
	};
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

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: getEntries caching behavior (cwd-aware cache with reload)
// ═══════════════════════════════════════════════════════════════════════

describe("getEntries caching (Phase 1)", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-phase1-"));
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("first call with cwd=/a loads from /a and caches result", () => {
		const dirA = path.join(tmpRoot, "a");
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "secret.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();
		const entries = getEntries(dirA);

		assert.strictEqual(getCallCount(), 1, "should load on first call");
		assert.strictEqual(entries.length >= 1, true, "should find .piignore entries");
		assert.strictEqual(isIgnored("secret.txt", entries, dirA), true);
	});

	it("second call with same cwd=/a returns cached (no re-read from disk)", () => {
		const dirA = path.join(tmpRoot, "a");
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "secret.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();

		getEntries(dirA); // first call — loads
		assert.strictEqual(getCallCount(), 1, "should load once");

		getEntries(dirA); // second call — cached
		assert.strictEqual(getCallCount(), 1, "should NOT re-read from disk");
	});

	it("call with cwd=/b after /a detects cwd change and reloads fresh entries", () => {
		const dirA = path.join(tmpRoot, "a");
		const dirB = path.join(tmpRoot, "b");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "only-a.txt\n");
		fs.writeFileSync(path.join(dirB, ".piignore"), "only-b.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();

		getEntries(dirA); // load /a entries
		assert.strictEqual(getCallCount(), 1, "first load");

		const entriesB = getEntries(dirB); // should reload for /b
		// With fixed version: cache detects cwd change, reloads from /b
		// So only-b.txt IS matched (entries are from dirB)
		assert.strictEqual(
			isIgnored("only-b.txt", entriesB, dirB),
			true,
			"only-b.txt should be blocked by dirB's .piignore",
		);
	});

	it("call with cwd=/a again after /b reloads fresh from /a (not stale cache)", () => {
		const dirA = path.join(tmpRoot, "a");
		const dirB = path.join(tmpRoot, "b");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "only-a.txt\n");
		fs.writeFileSync(path.join(dirB, ".piignore"), "only-b.txt\n");

		const { getEntries } = createGetEntries_fixed();

		getEntries(dirA); // load /a — caches from A

		// Delete dirA/.piignore to detect stale cache
		fs.rmSync(path.join(dirA, ".piignore"));

		getEntries(dirB); // triggers reload for /b

		const entriesA = getEntries(dirA);
		// With fixed version: detects cwd change back to /a, reloads fresh
		// So only-a.txt is NOT blocked because .piignore was deleted
		assert.strictEqual(
			isIgnored("only-a.txt", entriesA, dirA),
			false,
			"only-a.txt should NOT be blocked after .piignore deleted in dirA",
		);
	});

	it("call with cwd=/b (no .piignore) returns empty; switch to /c (with .piignore) returns /c entries", () => {
		const dirB = path.join(tmpRoot, "b");
		const dirC = path.join(tmpRoot, "c");
		fs.mkdirSync(dirB, { recursive: true });
		fs.mkdirSync(dirC, { recursive: true });
		// dirB has NO .piignore
		fs.writeFileSync(path.join(dirC, ".piignore"), "secret.txt\n");

		const { getEntries, getCallCount } = createGetEntries_fixed();

		const entriesB = getEntries(dirB); // no .piignore in dirB → empty
		assert.strictEqual(entriesB.length, 0, "dirB should have no entries");
		assert.strictEqual(getCallCount(), 1, "loaded once for dirB");

		const entriesC = getEntries(dirC); // should reload for dirC
		// With fixed version: detects cwd change, reloads from dirC
		// entriesC contains dirC's .piignore patterns
		assert.strictEqual(
			entriesC.length >= 1,
			true,
			"dirC should have .piignore entries (stale cache returns empty)",
		);
		assert.strictEqual(isIgnored("secret.txt", entriesC, dirC), true);
	});

	it("no .piignore tree at all returns empty array for any cwd", () => {
		const dirEmpty = path.join(tmpRoot, "empty");
		fs.mkdirSync(dirEmpty, { recursive: true });

		const { getEntries, getCallCount } = createGetEntries_fixed();

		const entries1 = getEntries(dirEmpty);
		assert.strictEqual(entries1.length, 0, "first cwd: no .piignore");
		assert.strictEqual(getCallCount(), 1, "loaded once");

		const dirEmpty2 = path.join(tmpRoot, "empty2");
		fs.mkdirSync(dirEmpty2, { recursive: true });

		const entries2 = getEntries(dirEmpty2);
		assert.strictEqual(entries2.length, 0, "second cwd: still no .piignore");
	});

	it("getEntries with cwd=/a returns only /a patterns when /a has its own .piignore", () => {
		// Create parent dir with .piignore
		fs.writeFileSync(path.join(tmpRoot, ".piignore"), "parent.txt\n");
		const dirA = path.join(tmpRoot, "a");
		fs.mkdirSync(dirA, { recursive: true });
		fs.writeFileSync(path.join(dirA, ".piignore"), "child.txt\n");

		const { getEntries } = createGetEntries_fixed();

		const entries = getEntries(dirA);
		// Should have both parent and child entries (walks up from cwd)
		const roots = entries.map((e) => e.root);
		assert.ok(roots.includes(dirA), "should include child dirA");
		assert.ok(roots.includes(tmpRoot), "should include parent tmpRoot");

		// Verify child's own patterns work
		assert.strictEqual(isIgnored("child.txt", entries, dirA), true);
		// Verify parent's patterns also work
		assert.strictEqual(isIgnored("parent.txt", entries, dirA), true);
	});
});
