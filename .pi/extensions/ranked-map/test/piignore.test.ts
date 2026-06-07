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

	it("returns pattern for path pattern without trailing slash", () => {
		assert.equal(parsePiignoreLine(".pi/cache"), ".pi/cache");
	});

	it("returns pattern for path pattern with trailing slash", () => {
		assert.equal(parsePiignoreLine(".pi/cache/"), ".pi/cache");
	});

	it("strips trailing /**", () => {
		assert.equal(parsePiignoreLine("dist/**"), "dist");
	});

	it("strips trailing /** with nested path", () => {
		assert.equal(parsePiignoreLine("build/output/**"), "build/output");
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

	it("returns pattern for nested glob", () => {
		assert.equal(parsePiignoreLine("**/credentials.*"), null); // contains **
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

	it("returns pattern for path pattern without trailing slash", () => {
		assert.equal(parseIgnoreLine(".pi/cache"), ".pi/cache");
	});

	it("returns pattern for path pattern with trailing slash", () => {
		assert.equal(parseIgnoreLine(".pi/cache/"), ".pi/cache");
	});

	it("strips trailing /**", () => {
		assert.equal(parseIgnoreLine("dist/**"), "dist");
	});

	it("strips trailing /** with nested path", () => {
		assert.equal(parseIgnoreLine("build/output/**"), "build/output");
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

	it("returns null for double-star prefix glob", () => {
		assert.equal(parseIgnoreLine("**/credentials.*"), null);
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

	it("returns null for **/venv/ double-star prefix", () => {
		assert.equal(parseIgnoreLine("**/venv/"), null);
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

