/**
 * Tests for .piignore integration — reading, parsing, and converting
 * .piignore patterns to ctags --exclude arguments.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ranked-map/test/piignore.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	parsePiignoreLine,
	buildPiignoreExcludes,
	parseIgnoreLine,
	buildIgnoreExcludes,
	discoverIgnoreFiles,
} from "../piignore.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: parsePiignoreLine
// ═══════════════════════════════════════════════════════════════════════

describe("parsePiignoreLine", () => {
	it("returns pattern for simple directory pattern", () => {
		assert.equal(parsePiignoreLine("dist/"), "dist");
	});

	it("returns pattern for glob pattern", () => {
		assert.equal(parsePiignoreLine("*.log"), "*.log");
	});

	it("extracts basename for path pattern without trailing slash", () => {
		assert.equal(parsePiignoreLine(".pi/cache"), "cache");
	});

	it("extracts basename for path pattern with trailing slash", () => {
		assert.equal(parsePiignoreLine(".pi/cache/"), "cache");
	});

	it("strips trailing /**", () => {
		assert.equal(parsePiignoreLine("dist/**"), "dist");
	});

	it("extracts basename for nested path with trailing /**", () => {
		assert.equal(parsePiignoreLine("build/output/**"), "output");
	});

	it("returns null for empty line", () => {
		assert.equal(parsePiignoreLine(""), null);
	});

	it("returns null for whitespace-only line", () => {
		assert.equal(parsePiignoreLine("   "), null);
	});

	it("returns null for comment line", () => {
		assert.equal(parsePiignoreLine("# This is a comment"), null);
	});

	it("returns null for negation pattern", () => {
		assert.equal(parsePiignoreLine("!important.ts"), null);
	});

	it("returns null for pattern with leading slash", () => {
		assert.equal(parsePiignoreLine("/absolute/path"), null);
	});

	it("returns null for pattern with double-star in middle", () => {
		assert.equal(parsePiignoreLine("a/**/b"), null);
	});

	it("returns pattern for simple file name", () => {
		assert.equal(parsePiignoreLine(".env"), ".env");
	});

	it("returns pattern for wildcard extension", () => {
		assert.equal(parsePiignoreLine("*.pem"), "*.pem");
	});

	it("strips **/ prefix from glob pattern", () => {
		assert.equal(parsePiignoreLine("**/credentials.*"), "credentials.*");
	});

	it("returns pattern for directory glob", () => {
		assert.equal(parsePiignoreLine("old/"), "old");
	});

	it("returns null for section header comment", () => {
		assert.equal(parsePiignoreLine("# --- Secrets ---"), null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: buildPiignoreExcludes (backward compat alias)
// ═══════════════════════════════════════════════════════════════════════

describe("buildPiignoreExcludes (backward compat alias)", () => {
	function setupDir(): string {
		return mkdtempSync(join(tmpdir(), "piignore-test-"));
	}

	function cleanupDir(dir: string) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	it("returns empty array when file does not exist", () => {
		const dir = setupDir();
		try {
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, []);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses file and returns exclude patterns", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".piignore"),
				["# PiIgnore test", "", "dist/", "*.log", ".env", "build/", ""].join("\n"),
			);
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, ["dist", "*.log", ".env", "build"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("skips comments, empty lines, and negations", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".piignore"),
				["# comment", "", "  ", "src/", "!important.ts", "dist/"].join("\n"),
			);
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, ["src", "dist"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns empty array for unreadable file", () => {
		const result = buildPiignoreExcludes("/nonexistent/dir/.piignore");
		assert.deepEqual(result, []);
	});

	it("handles file with mixed content (sections, comments, patterns)", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".piignore"),
				[
					"# Dependencies",
					"node_modules/",
					"",
					"# Build output",
					"dist/",
					"*.tmp",
					"",
					"# Secrets",
					".env",
					"*.pem",
				].join("\n"),
			);
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, ["node_modules", "dist", "*.tmp", ".env", "*.pem"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("handles file with trailing /** patterns", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".piignore"), ["build/**", "cache/**"].join("\n"));
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, ["build", "cache"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("handles file with only comments and empty lines", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".piignore"),
				["# only comments", "", "# another comment"].join("\n"),
			);
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, []);
		} finally {
			cleanupDir(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: parseIgnoreLine (renamed — same contract as parsePiignoreLine)
// ═══════════════════════════════════════════════════════════════════════

describe("parseIgnoreLine", () => {
	it("returns pattern for simple directory pattern", () => {
		assert.equal(parseIgnoreLine("dist/"), "dist");
	});

	it("returns pattern for glob pattern", () => {
		assert.equal(parseIgnoreLine("*.log"), "*.log");
	});

	it("extracts basename for path pattern without trailing slash", () => {
		assert.equal(parseIgnoreLine(".pi/cache"), "cache");
	});

	it("extracts basename for path pattern with trailing slash", () => {
		assert.equal(parseIgnoreLine(".pi/cache/"), "cache");
	});

	it("strips trailing /**", () => {
		assert.equal(parseIgnoreLine("dist/**"), "dist");
	});

	it("extracts basename for nested path with trailing /**", () => {
		assert.equal(parseIgnoreLine("build/output/**"), "output");
	});

	// ── Path-prefixed patterns (real-world .piignore use) ──

	it("extracts basename for .pi/npm (no trailing slash)", () => {
		assert.equal(parseIgnoreLine(".pi/npm"), "npm");
	});

	it("extracts basename for .pi/npm/ (with trailing slash)", () => {
		assert.equal(parseIgnoreLine(".pi/npm/"), "npm");
	});

	it("extracts basename for .pi/chromium-deps/", () => {
		assert.equal(parseIgnoreLine(".pi/chromium-deps/"), "chromium-deps");
	});

	it("extracts basename for .pi/crawl4ai-venv/", () => {
		assert.equal(parseIgnoreLine(".pi/crawl4ai-venv/"), "crawl4ai-venv");
	});

	it("extracts basename for deeply nested path a/b/c/d/", () => {
		assert.equal(parseIgnoreLine("a/b/c/d/"), "d");
	});

	it("extracts filename for some/path/file.ts", () => {
		assert.equal(parseIgnoreLine("some/path/file.ts"), "file.ts");
	});

	it("returns null for empty line", () => {
		assert.equal(parseIgnoreLine(""), null);
	});

	it("returns null for whitespace-only line", () => {
		assert.equal(parseIgnoreLine("   "), null);
	});

	it("returns null for comment line", () => {
		assert.equal(parseIgnoreLine("# This is a comment"), null);
	});

	it("returns null for negation pattern", () => {
		assert.equal(parseIgnoreLine("!important.ts"), null);
	});

	it("returns null for pattern with leading slash", () => {
		assert.equal(parseIgnoreLine("/absolute/path"), null);
	});

	it("returns null for pattern with double-star in middle", () => {
		assert.equal(parseIgnoreLine("a/**/b"), null);
	});

	it("returns pattern for simple file name", () => {
		assert.equal(parseIgnoreLine(".env"), ".env");
	});

	it("returns pattern for wildcard extension", () => {
		assert.equal(parseIgnoreLine("*.pem"), "*.pem");
	});

	it("strips **/ prefix from credentials.*", () => {
		assert.equal(parseIgnoreLine("**/credentials.*"), "credentials.*");
	});

	it("returns pattern for directory glob", () => {
		assert.equal(parseIgnoreLine("old/"), "old");
	});

	it("returns null for section header comment", () => {
		assert.equal(parseIgnoreLine("# --- Secrets ---"), null);
	});

	// Gitignore-specific patterns
	it("parses __pycache__/ directory pattern (gitignore common)", () => {
		assert.equal(parseIgnoreLine("__pycache__/"), "__pycache__");
	});

	it("parses *.pyc glob pattern (gitignore common)", () => {
		assert.equal(parseIgnoreLine("*.pyc"), "*.pyc");
	});

	it("parses *.zip glob pattern (gitignore common)", () => {
		assert.equal(parseIgnoreLine("*.zip"), "*.zip");
	});

	it("strips **/ prefix from directory pattern", () => {
		assert.equal(parseIgnoreLine("**/venv/"), "venv");
	});

	it("strips **/ before trailing /**", () => {
		assert.equal(parseIgnoreLine("**/node_modules/**"), "node_modules");
	});

	it("strips repeated **/ prefixes", () => {
		assert.equal(parseIgnoreLine("**/**/dir/"), "dir");
	});

	it("strips **/ from glob pattern", () => {
		assert.equal(parseIgnoreLine("**/*.pyc"), "*.pyc");
	});

	it("still rejects ** in middle of pattern", () => {
		assert.equal(parseIgnoreLine("a/**/b"), null);
	});

	it("still rejects bare ** pattern", () => {
		assert.equal(parseIgnoreLine("**"), null);
	});

	it("parses .venv/ directory pattern (python venv)", () => {
		assert.equal(parseIgnoreLine(".venv/"), ".venv");
	});

	it("parses venv/ directory pattern (python venv)", () => {
		assert.equal(parseIgnoreLine("venv/"), "venv");
	});

	it("parses *.so shared object pattern", () => {
		assert.equal(parseIgnoreLine("*.so"), "*.so");
	});

	it("parses dist/ directory pattern", () => {
		assert.equal(parseIgnoreLine("dist/"), "dist");
	});

	it("parses build/ directory pattern", () => {
		assert.equal(parseIgnoreLine("build/"), "build");
	});

	it("parses .eggs/ directory pattern", () => {
		assert.equal(parseIgnoreLine(".eggs/"), ".eggs");
	});

	it("parses *.egg-info glob pattern", () => {
		assert.equal(parseIgnoreLine("*.egg-info"), "*.egg-info");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: buildIgnoreExcludes (renamed — same contract, works with any ignore file)
// ═══════════════════════════════════════════════════════════════════════

describe("buildIgnoreExcludes", () => {
	function setupDir(): string {
		return mkdtempSync(join(tmpdir(), "ignore-test-"));
	}

	function cleanupDir(dir: string) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	it("returns empty array when file does not exist", () => {
		const dir = setupDir();
		try {
			const result = buildIgnoreExcludes(join(dir, ".gitignore"));
			assert.deepEqual(result, []);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses .gitignore with mixed content and returns exclude patterns", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".gitignore"),
				["# Dependencies", "", "__pycache__/", "*.pyc", ".venv/", "venv/"].join("\n"),
			);
			const result = buildIgnoreExcludes(join(dir, ".gitignore"));
			assert.deepEqual(result, ["__pycache__", "*.pyc", ".venv", "venv"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("skips comments, empty lines, and negations", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".gitignore"),
				["# comment", "", "  ", "__pycache__/", "!important.py", "*.pyc"].join("\n"),
			);
			const result = buildIgnoreExcludes(join(dir, ".gitignore"));
			assert.deepEqual(result, ["__pycache__", "*.pyc"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns empty array for unreadable file", () => {
		const result = buildIgnoreExcludes("/nonexistent/dir/.gitignore");
		assert.deepEqual(result, []);
	});

	it("handles flask_blogs gitignore patterns", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".gitignore"),
				[
					"# Byte-compiled",
					"__pycache__/",
					"*.pyc",
					"*.pyo",
					"*.pyd",
					"",
					"# Virtual environments",
					".venv",
					"venv/",
					"",
					"# Build artifacts",
					"dist/",
					"build/",
					".eggs/",
					"*.egg-info",
					"*.so",
				].join("\n"),
			);
			const result = buildIgnoreExcludes(join(dir, ".gitignore"));
			assert.deepEqual(result, [
				"__pycache__",
				"*.pyc",
				"*.pyo",
				"*.pyd",
				".venv",
				"venv",
				"dist",
				"build",
				".eggs",
				"*.egg-info",
				"*.so",
			]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("handles .gitignore with only comments and empty lines", () => {
		const dir = setupDir();
		try {
			writeFileSync(
				join(dir, ".gitignore"),
				["# only comments", "", "# another comment"].join("\n"),
			);
			const result = buildIgnoreExcludes(join(dir, ".gitignore"));
			assert.deepEqual(result, []);
		} finally {
			cleanupDir(dir);
		}
	});

	it("scopePrefix prefixes patterns with submodule path", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), ["__pycache__/", "*.pyc"].join("\n"));
			const result = buildIgnoreExcludes(join(dir, ".gitignore"), "flask_blogs");
			assert.deepEqual(result, ["flask_blogs/__pycache__", "flask_blogs/*.pyc"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("scopePrefix with deeper submodule path", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), ["venv/", "*.log", "build/"].join("\n"));
			const result = buildIgnoreExcludes(join(dir, ".gitignore"), "sub/deep");
			assert.deepEqual(result, ["sub/deep/venv", "sub/deep/*.log", "sub/deep/build"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("scopePrefix with no scope (empty) behaves like normal", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), ["__pycache__/", "*.pyc"].join("\n"));
			const result = buildIgnoreExcludes(join(dir, ".gitignore"), "");
			assert.deepEqual(result, ["__pycache__", "*.pyc"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("scopePrefix with null (no arg) behaves like normal", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), ["__pycache__/", "*.pyc"].join("\n"));
			const result = buildIgnoreExcludes(join(dir, ".gitignore"));
			assert.deepEqual(result, ["__pycache__", "*.pyc"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("scopePrefix with empty .gitignore produces empty result", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "");
			const result = buildIgnoreExcludes(join(dir, ".gitignore"), "submod");
			assert.deepEqual(result, []);
		} finally {
			cleanupDir(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: discoverIgnoreFiles — recursive .gitignore discovery
// ═══════════════════════════════════════════════════════════════════════

describe("discoverIgnoreFiles", () => {
	function setupDir(): string {
		return mkdtempSync(join(tmpdir(), "disc-ignore-"));
	}

	function cleanupDir(dir: string) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	it("returns empty array for directory with no .gitignore files", () => {
		const dir = setupDir();
		try {
			const result = discoverIgnoreFiles(dir);
			assert.deepEqual(result, []);
		} finally {
			cleanupDir(dir);
		}
	});

	it("discovers top-level .gitignore file", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
			const result = discoverIgnoreFiles(dir);
			assert.deepEqual(result, [join(dir, ".gitignore")]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("discovers nested .gitignore files in subdirectories", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
			mkdirSync(join(dir, "submodule"), { recursive: true });
			writeFileSync(join(dir, "submodule", ".gitignore"), "__pycache__/\n");
			const result = discoverIgnoreFiles(dir);
			assert.equal(result.length, 2);
			assert.ok(result.includes(join(dir, ".gitignore")));
			assert.ok(result.includes(join(dir, "submodule", ".gitignore")));
		} finally {
			cleanupDir(dir);
		}
	});

	it("excludes .git/ directory contents from discovery", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
			mkdirSync(join(dir, ".git"), { recursive: true });
			// .gitignore inside .git/ should be ignored
			writeFileSync(join(dir, ".git", ".gitignore"), "secret\n");
			const result = discoverIgnoreFiles(dir);
			assert.deepEqual(result, [join(dir, ".gitignore")]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("returns empty array for non-existent root directory", () => {
		const result = discoverIgnoreFiles("/nonexistent/path");
		assert.deepEqual(result, []);
	});

	it("discovers multiple nested .gitignore files at various depths", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "root\n");
			mkdirSync(join(dir, "a"), { recursive: true });
			writeFileSync(join(dir, "a", ".gitignore"), "a_ignored\n");
			mkdirSync(join(dir, "a", "b"), { recursive: true });
			writeFileSync(join(dir, "a", "b", ".gitignore"), "b_ignored\n");

			const result = discoverIgnoreFiles(dir);
			assert.equal(result.length, 3);
			assert.ok(result.includes(join(dir, ".gitignore")));
			assert.ok(result.includes(join(dir, "a", ".gitignore")));
			assert.ok(result.includes(join(dir, "a", "b", ".gitignore")));
		} finally {
			cleanupDir(dir);
		}
	});

	it("skipDirs skips matching directories during traversal", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "root\n");
			mkdirSync(join(dir, "node_modules"), { recursive: true });
			// .gitignore inside node_modules should NOT be discovered
			writeFileSync(join(dir, "node_modules", ".gitignore"), "ignored\n");
			mkdirSync(join(dir, "src"), { recursive: true });
			writeFileSync(join(dir, "src", ".gitignore"), "src_ignored\n");

			const result = discoverIgnoreFiles(dir, ["node_modules", "dist"]);
			assert.equal(result.length, 2, "should skip node_modules");
			assert.ok(result.includes(join(dir, ".gitignore")));
			assert.ok(result.includes(join(dir, "src", ".gitignore")));
		} finally {
			cleanupDir(dir);
		}
	});

	it("skipDirs empty array skips nothing (same as no arg)", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "root\n");
			mkdirSync(join(dir, "sub"), { recursive: true });
			writeFileSync(join(dir, "sub", ".gitignore"), "sub\n");

			const result = discoverIgnoreFiles(dir, []);
			assert.equal(result.length, 2);
		} finally {
			cleanupDir(dir);
		}
	});

	it("skipDirs passes through to recursive calls", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".gitignore"), "root\n");
			mkdirSync(join(dir, "a"), { recursive: true });
			writeFileSync(join(dir, "a", ".gitignore"), "a\n");
			mkdirSync(join(dir, "a", "node_modules"), { recursive: true });
			// This .gitignore inside a/node_modules should be skipped
			writeFileSync(join(dir, "a", "node_modules", ".gitignore"), "should_be_skipped\n");
			mkdirSync(join(dir, "a", "b"), { recursive: true });
			writeFileSync(join(dir, "a", "b", ".gitignore"), "b\n");

			const result = discoverIgnoreFiles(dir, ["node_modules"]);
			assert.equal(result.length, 3);
			assert.ok(result.includes(join(dir, ".gitignore")));
			assert.ok(result.includes(join(dir, "a", ".gitignore")));
			assert.ok(result.includes(join(dir, "a", "b", ".gitignore")));
		} finally {
			cleanupDir(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Backward compatibility — old names still work
// ═══════════════════════════════════════════════════════════════════════

describe("backward compatibility — old names are aliases", () => {
	it("parsePiignoreLine still works and matches parseIgnoreLine behavior", () => {
		assert.equal(parsePiignoreLine("dist/"), parseIgnoreLine("dist/"));
		assert.equal(parsePiignoreLine("*.log"), parseIgnoreLine("*.log"));
		assert.equal(parsePiignoreLine(""), parseIgnoreLine(""));
		assert.equal(parsePiignoreLine("# comment"), parseIgnoreLine("# comment"));
		assert.equal(parsePiignoreLine("!negate"), parseIgnoreLine("!negate"));
	});

	it("buildPiignoreExcludes still works and matches buildIgnoreExcludes behavior", () => {
		const dir = mkdtempSync(join(tmpdir(), "piignore-bc-"));
		try {
			writeFileSync(join(dir, ".piignore"), ["dist/", "*.log"].join("\n"));
			const oldResult = buildPiignoreExcludes(join(dir, ".piignore"));
			const newResult = buildIgnoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(oldResult, newResult);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
