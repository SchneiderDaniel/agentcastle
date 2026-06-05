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
import { parsePiignoreLine, buildPiignoreExcludes } from "../piignore.ts";

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
// Phase 2: buildPiignoreExcludes
// ═══════════════════════════════════════════════════════════════════════

describe("buildPiignoreExcludes", () => {
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

	it("returns empty array when .piignore does not exist", () => {
		const dir = setupDir();
		try {
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, []);
		} finally {
			cleanupDir(dir);
		}
	});

	it("parses .piignore and returns exclude patterns", () => {
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

	it("handles .piignore with mixed content (sections, comments, patterns)", () => {
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

	it("handles .piignore with trailing /** patterns", () => {
		const dir = setupDir();
		try {
			writeFileSync(join(dir, ".piignore"), ["build/**", "cache/**"].join("\n"));
			const result = buildPiignoreExcludes(join(dir, ".piignore"));
			assert.deepEqual(result, ["build", "cache"]);
		} finally {
			cleanupDir(dir);
		}
	});

	it("handles .piignore with only comments and empty lines", () => {
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
