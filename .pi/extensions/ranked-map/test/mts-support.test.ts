/**
 * Tests for .mts file support in ranked-map ctags integration.
 *
 * Phase: .mts TypeScript file extension mapping for ctags.
 *   buildCtagsArgs includes --map-TypeScript=+.mts so that .mts files
 *   are parsed with the TypeScript language parser.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ranked-map/test/mts-support.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { buildCtagsArgs, buildSymbolIndex, parseCtagsOutput } from "../ctags.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: buildCtagsArgs includes .mts TypeScript mapping
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 1: .mts TypeScript mapping in buildCtagsArgs", () => {
	it("includes --map-TypeScript=+.mts for any target directory", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--map-TypeScript=+.mts"));
	});

	it("--map-TypeScript=+.mts appears before target directory arg (flags before positional)", () => {
		const result = buildCtagsArgs("/some/dir", 0);
		const mtsIdx = result.args.indexOf("--map-TypeScript=+.mts");
		const targetIdx = result.args.indexOf("/some/dir");
		assert.ok(mtsIdx >= 0, "--map-TypeScript=+.mts should be present");
		assert.ok(mtsIdx < targetIdx, "--map-TypeScript=+.mts should appear before targetDir");
	});

	it("--map-TypeScript=+.mts still present when extra excludes passed", () => {
		const result = buildCtagsArgs(".", 0, ["extra_dir", "*.extra"]);
		assert.ok(result.args.includes("--map-TypeScript=+.mts"));
	});

	it("--map-TypeScript=+.mts appears correctly with absolute targetDir", () => {
		const result = buildCtagsArgs("/home/user/project", 0);
		assert.ok(result.args.includes("--map-TypeScript=+.mts"));
	});

	it("--map-TypeScript=+.mts appears correctly with maxDepth > 0", () => {
		const result = buildCtagsArgs(".", 3);
		assert.ok(result.args.includes("--map-TypeScript=+.mts"));
	});

	it("--map-TypeScript=+.mts flag coexists with --tag-relative=always, both present in same call", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--map-TypeScript=+.mts"));
		assert.ok(result.args.includes("--tag-relative=always"));
	});

	it("uses --map-TypeScript=+.mts not --langmap (preferred ctags syntax for N:1 mappings)", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--map-TypeScript=+.mts"));
		// Ensure we're NOT using --langmap syntax
		assert.ok(!result.args.some((a) => a.startsWith("--langmap=")));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Regression — existing args unchanged
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 2: Regression — existing args unchanged", () => {
	it("--output-format=json still present after .mts flag added", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--output-format=json"));
	});

	it("--tag-relative=always still present", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--tag-relative=always"));
	});

	it("all standard excludes still present", () => {
		const result = buildCtagsArgs(".", 0);
		const standardExcludes = [
			"node_modules",
			".git",
			"*.json",
			"*.jsonl",
			"*.md",
			"context",
			"sessions",
			"npm",
			"chromium-deps",
			"crawl4ai-venv",
			"benchmarks",
		];
		for (const ex of standardExcludes) {
			const count = result.args.filter((a) => a === `--exclude=${ex}`).length;
			assert.equal(count, 1, `--exclude=${ex} should appear exactly once`);
		}
	});

	it("--exclude=*.min.js still present", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=*.min.js"));
	});

	it("--exclude=*.css still present", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=*.css"));
	});

	it("--exclude=static still present", () => {
		const result = buildCtagsArgs(".", 0);
		assert.ok(result.args.includes("--exclude=static"));
	});

	it("target directory is still last arg", () => {
		const result = buildCtagsArgs("/some/dir", 0);
		assert.equal(result.args[result.args.length - 1], "/some/dir");
	});

	it("--maxdepth=N still works when N > 0, omitted when N = 0", () => {
		const resultWithDepth = buildCtagsArgs(".", 3);
		assert.ok(resultWithDepth.args.includes("--maxdepth=3"));

		const resultWithoutDepth = buildCtagsArgs(".", 0);
		assert.ok(!resultWithoutDepth.args.some((a) => a.startsWith("--maxdepth")));
	});

	it("deduplication of extra excludes still works", () => {
		const result = buildCtagsArgs(".", 0, ["node_modules", "*.md"]);
		const nodeModulesCount = result.args.filter((a) => a === "--exclude=node_modules").length;
		const mdCount = result.args.filter((a) => a === "--exclude=*.md").length;
		assert.equal(nodeModulesCount, 1, "node_modules should not be duplicated");
		assert.equal(mdCount, 1, "*.md should not be duplicated");
	});

	it("back-to-back calls produce same args (deterministic)", () => {
		const result1 = buildCtagsArgs(".", 0);
		const result2 = buildCtagsArgs(".", 0);
		assert.deepEqual(result1.args, result2.args);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Integration — real ctags parses .mts files
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 3: Integration — real ctags with .mts files", () => {
	function tmpDir(): string {
		return mkdtempSync(join(tmpdir(), "ranked-mts-"));
	}

	function cleanup(dir: string) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}

	it("parses .mts file with --map-TypeScript=+.mts (positive test)", () => {
		const dir = tmpDir();
		try {
			writeFileSync(
				join(dir, "test.mts"),
				[
					"export interface User {",
					"  name: string;",
					"  age: number;",
					"}",
					"",
					"export function greet(user: User): string {",
					"  return `Hello ${user.name}`;",
					"}",
					"",
					"export class Greeter {",
					"  private name: string;",
					"  constructor(name: string) {",
					"    this.name = name;",
					"  }",
					"  sayHello(): string {",
					"    return `Hello ${this.name}`;",
					"  }",
					"}",
					"",
					"export const VERSION = '1.0.0';",
				].join("\n"),
			);

			const stdout = execSync("ctags -R --output-format=json --map-TypeScript=+.mts .", {
				cwd: dir,
				encoding: "utf-8",
			});

			const tags = parseCtagsOutput(stdout);
			const tagNames = tags.map((t) => t.name);
			// Should find: User (interface), greet (function), Greeter (class),
			// constructor (method), sayHello (method), VERSION (constant)
			assert.ok(tagNames.includes("User"), "should find User interface");
			assert.ok(tagNames.includes("greet"), "should find greet function");
			assert.ok(tagNames.includes("Greeter"), "should find Greeter class");
			assert.ok(tagNames.includes("VERSION"), "should find VERSION constant");

			// All tags should have the .mts path
			const mtsTags = tags.filter((t) => t.path.endsWith(".mts"));
			assert.equal(mtsTags.length, tags.length, "all tags should be from .mts file");
		} finally {
			cleanup(dir);
		}
	});

	it("same .mts file without --map-TypeScript=+.mts produces zero or fewer symbols (negative test)", () => {
		const dir = tmpDir();
		try {
			writeFileSync(
				join(dir, "test.mts"),
				["export function hello(): string {", '  return "hello";', "}"].join("\n"),
			);

			const stdout = execSync("ctags -R --output-format=json .", {
				cwd: dir,
				encoding: "utf-8",
			});

			const tags = parseCtagsOutput(stdout);
			// Without --map-TypeScript=+.mts, .mts files are not parsed as TypeScript.
			// ctags may still produce tags if it falls back to some other parser
			// (e.g., generic), but there should be at most one tag (often just the file).
			// The key test: there should be NO TypeScript-specific symbols (function, class, etc.)
			const hasTsSymbols = tags.some(
				(t) =>
					t.path.endsWith(".mts") &&
					["function", "class", "interface", "constant"].includes(t.kind),
			);
			assert.equal(
				hasTsSymbols,
				false,
				"without --map-TypeScript, .mts should not produce TypeScript-kind tags",
			);
		} finally {
			cleanup(dir);
		}
	});

	it("temp .mts file alongside .ts files, both produce symbols in same ctags run (no interference)", () => {
		const dir = tmpDir();
		try {
			// Write .mts file
			writeFileSync(
				join(dir, "module.mts"),
				["export function mtsFn(): string {", '  return "from mts";', "}"].join("\n"),
			);

			// Write .ts file
			writeFileSync(
				join(dir, "module.ts"),
				["export function tsFn(): string {", '  return "from ts";', "}"].join("\n"),
			);

			const stdout = execSync("ctags -R --output-format=json --map-TypeScript=+.mts .", {
				cwd: dir,
				encoding: "utf-8",
			});

			const tags = parseCtagsOutput(stdout);
			const tagNames = tags.map((t) => t.name);

			// Both files should be parsed
			assert.ok(tagNames.includes("mtsFn"), "should find mtsFn from .mts file");
			assert.ok(tagNames.includes("tsFn"), "should find tsFn from .ts file");

			// Verify paths
			const mtsTags = tags.filter((t) => t.path.endsWith(".mts"));
			const tsTags = tags.filter((t) => t.path.endsWith(".ts"));
			assert.ok(mtsTags.length > 0, "should have at least one .mts tag");
			assert.ok(tsTags.length > 0, "should have at least one .ts tag");
		} finally {
			cleanup(dir);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Integration — buildSymbolIndex with .mts output
// ═══════════════════════════════════════════════════════════════════════

describe("Phase 4: buildSymbolIndex handles .mts ctags output", () => {
	it("buildSymbolIndex correctly indexes .mts file symbols", () => {
		const jsonl = [
			JSON.stringify({
				_type: "tag",
				name: "User",
				kind: "interface",
				path: "src/types.mts",
				pattern: "/^export interface User {$/",
				line: 1,
			}),
			JSON.stringify({
				_type: "tag",
				name: "greet",
				kind: "function",
				path: "src/utils.mts",
				pattern: "/^export function greet() {$/",
				line: 5,
			}),
		].join("\n");

		const index = buildSymbolIndex(jsonl, "head123");
		assert.ok(index.symbols["src/types.mts"], "should have types.mts entry");
		assert.ok(index.symbols["src/utils.mts"], "should have utils.mts entry");
		assert.equal(index.symbols["src/types.mts"]![0]!.name, "User");
		assert.equal(index.symbols["src/utils.mts"]![0]!.name, "greet");
	});
});
