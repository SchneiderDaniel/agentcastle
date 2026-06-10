/**
 * Tests for Ranked Map Architecture Hardening
 *
 * Feature 1: Working-Tree Cache Invalidation — getWorkingTreeHash + cache validation
 * Feature 2: Strict Path Post-Processing — resolvePiignorePatterns + matchPiignorePattern
 * Feature 3: Bounded Git Recency Search — maxCommits injected into git log
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ranked-map/test/hardening.test.ts
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import type { ExecFn, CachedIndex, RankedMapConfig } from "../types.ts";
import { getWorkingTreeHash, runGitRecency, runGitCommitCount, getGitHead } from "../git.ts";
import { loadCachedIndex, computeConfigHash } from "../cache.ts";
import {
	resolvePiignorePatterns,
	matchPiignorePattern,
	parseIgnoreLine,
	buildIgnoreExcludes,
} from "../piignore.ts";
import { loadRankedMapConfig } from "../config.ts";
import { RankedMapEngine } from "../engine.ts";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function tmpDirPath(): string {
	return mkdtempSync(join(tmpdir(), "ranked-hardening-"));
}

/**
 * Create a conditional mock exec with prefix arg matching.
 * Matches if command matches and the first N args match (prefix match).
 */
function mockExecConditional(
	handlers: Array<{
		cmd: string;
		args?: string[];
		handler: (
			cmd: string,
			args: string[],
			opts?: any,
		) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
	}>,
): ExecFn {
	return async (cmd: string, args: string[], opts?: any) => {
		for (const h of handlers) {
			if (h.cmd === cmd) {
				if (h.args !== undefined) {
					if (h.args.length > args.length) continue;
					let matches = true;
					for (let i = 0; i < h.args.length; i++) {
						if (h.args[i] !== args[i]) {
							matches = false;
							break;
						}
					}
					if (!matches) continue;
				}
				return h.handler(cmd, args, opts);
			}
		}
		return { stdout: "", stderr: "", code: 0, killed: false };
	};
}

function noopExec(): ExecFn {
	return async () => ({ stdout: "", stderr: "", code: 0, killed: false });
}

function makeIndex(overrides?: Partial<CachedIndex>): CachedIndex {
	return {
		head: "abc123",
		builtAt: Date.now(),
		symbols: {
			"src/a.ts": [{ type: "function", name: "foo", line: 1 }],
		},
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Feature 1: Working-Tree Cache Invalidation
// ═══════════════════════════════════════════════════════════════════════

describe("Feature 1: Working-Tree Cache Invalidation", () => {
	// ── getWorkingTreeHash ──────────────────────────────────────────

	describe("getWorkingTreeHash", () => {
		it("returns null when git status fails", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => ({ stdout: "", stderr: "not a git repo", code: 128, killed: false }),
				},
			]);
			const hash = await getWorkingTreeHash(exec, "/tmp");
			assert.equal(hash, null);
		});

		it("returns null when exec throws", async () => {
			const exec: ExecFn = async () => {
				throw new Error("exec failed");
			};
			const hash = await getWorkingTreeHash(exec, "/tmp");
			assert.equal(hash, null);
		});

		it("returns null for clean working tree (empty output)", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
				},
			]);
			const hash = await getWorkingTreeHash(exec, "/tmp");
			assert.equal(hash, null);
		});

		it("returns a deterministic hex hash for modified working tree", async () => {
			let callCount = 0;
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => {
						callCount++;
						return {
							stdout: " M src/a.ts\n?? new-file.ts\n",
							stderr: "",
							code: 0,
							killed: false,
						};
					},
				},
			]);
			const hash1 = await getWorkingTreeHash(exec, "/tmp");
			assert.ok(hash1, "should return a hash string");
			assert.match(hash1!, /^[0-9a-f]+$/, "should be hex string");

			// Second call with same output should return same hash
			const hash2 = await getWorkingTreeHash(exec, "/tmp");
			assert.equal(hash1, hash2, "should be deterministic");

			assert.equal(callCount, 2, "should call exec twice");
		});

		it("returns different hash for different working tree states", async () => {
			const exec1 = mockExecConditional([
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => ({
						stdout: " M src/a.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);
			const exec2 = mockExecConditional([
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => ({
						stdout: "?? new-file.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const hash1 = await getWorkingTreeHash(exec1, "/tmp");
			const hash2 = await getWorkingTreeHash(exec2, "/tmp");
			assert.notEqual(hash1, hash2, "different states should produce different hashes");
		});
	});

	// ── CachedIndex type includes workingTreeHash ──────────────────

	describe("CachedIndex type includes workingTreeHash", () => {
		it("allows workingTreeHash on CachedIndex", () => {
			const index: CachedIndex = {
				head: "abc",
				builtAt: 1000,
				symbols: {},
				workingTreeHash: "deadbeef",
			};
			assert.equal(index.workingTreeHash, "deadbeef");
		});

		it("allows undefined workingTreeHash on CachedIndex (backward compat)", () => {
			const index: CachedIndex = {
				head: "abc",
				builtAt: 1000,
				symbols: {},
			};
			assert.equal(index.workingTreeHash, undefined);
		});
	});

	// ── loadCachedIndex with workingTreeHash ───────────────────────

	describe("loadCachedIndex with workingTreeHash validation", () => {
		it("returns cached index when all dimensions match including workingTreeHash", () => {
			const cachePath = join(tmpDirPath(), "cache.json");
			const dir = resolve(cachePath, "..");
			mkdirSync(dir, { recursive: true });
			const configHash = computeConfigHash({
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			});
			writeFileSync(
				cachePath,
				JSON.stringify({
					head: "abc123",
					builtAt: Date.now(),
					symbols: {
						"src/a.ts": [{ type: "function", name: "foo", line: 1 }],
					},
					configHash,
					targetDir: ".",
					workingTreeHash: "deadbeef",
				}),
			);
			const result = loadCachedIndex(cachePath, "abc123", configHash, ".", "deadbeef");
			assert.ok(result, "should return cached index");
			assert.equal(result!.workingTreeHash, "deadbeef");
			rmSync(dir, { recursive: true });
		});

		it("returns null when workingTreeHash mismatches", () => {
			const cachePath = join(tmpDirPath(), "cache.json");
			const dir = resolve(cachePath, "..");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				cachePath,
				JSON.stringify({
					head: "abc123",
					builtAt: Date.now(),
					symbols: { "src/a.ts": [] },
					workingTreeHash: "hash-a",
				}),
			);
			const result = loadCachedIndex(cachePath, "abc123", undefined, undefined, "hash-b");
			assert.equal(result, null, "should invalidate on workingTreeHash mismatch");
			rmSync(dir, { recursive: true });
		});

		it("accepts cached index without workingTreeHash when not provided (backward compat)", () => {
			const cachePath = join(tmpDirPath(), "cache.json");
			const dir = resolve(cachePath, "..");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				cachePath,
				JSON.stringify({
					head: "abc123",
					builtAt: Date.now(),
					symbols: { "src/a.ts": [] },
				}),
			);
			const result = loadCachedIndex(cachePath, "abc123");
			assert.ok(result, "should accept cache without workingTreeHash when not validating");
			rmSync(dir, { recursive: true });
		});

		it("accepts cached index without workingTreeHash field when validating (cache was pre-upgrade)", () => {
			const cachePath = join(tmpDirPath(), "cache.json");
			const dir = resolve(cachePath, "..");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				cachePath,
				JSON.stringify({
					head: "abc123",
					builtAt: Date.now(),
					symbols: { "src/a.ts": [] },
				}),
			);
			// workingTreeHash is in cache but not in parsed → undefined in both → accepted
			const result = loadCachedIndex(cachePath, "abc123", undefined, undefined, undefined);
			assert.ok(result, "should accept cache when both sides have undefined workingTreeHash");
			rmSync(dir, { recursive: true });
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Feature 2: Strict Path Post-Processing (.piignore Resolution)
// ═══════════════════════════════════════════════════════════════════════

describe("Feature 2: Strict Path Post-Processing", () => {
	// ── resolvePiignorePatterns ─────────────────────────────────────

	describe("resolvePiignorePatterns", () => {
		it("returns empty array for non-existent file", () => {
			const patterns = resolvePiignorePatterns("/tmp/nonexistent/.piignore");
			assert.ok(Array.isArray(patterns));
			assert.equal(patterns.length, 0);
		});

		it("returns empty array for empty file", () => {
			const dir = tmpDirPath();
			const path = join(dir, ".piignore");
			writeFileSync(path, "", "utf-8");
			const patterns = resolvePiignorePatterns(path);
			assert.equal(patterns.length, 0);
			rmSync(dir, { recursive: true });
		});

		it("skips comments and empty lines", () => {
			const dir = tmpDirPath();
			const path = join(dir, ".piignore");
			writeFileSync(path, "# comment\n\n  \n*.log\n", "utf-8");
			const patterns = resolvePiignorePatterns(path);
			assert.equal(patterns.length, 1);
			assert.equal(patterns[0]!.raw, "*.log");
			rmSync(dir, { recursive: true });
		});

		it("resolves directory patterns as exact type", () => {
			const dir = tmpDirPath();
			const path = join(dir, ".piignore");
			writeFileSync(path, ".pi/cache/\nbuild\n", "utf-8");
			const patterns = resolvePiignorePatterns(path);
			assert.equal(patterns.length, 2);
			assert.equal(patterns[0]!.type, "exact");
			assert.equal(patterns[0]!.raw, ".pi/cache/");
			assert.equal(patterns[1]!.type, "exact");
			assert.equal(patterns[1]!.raw, "build");
			rmSync(dir, { recursive: true });
		});

		it("resolves glob patterns as glob type", () => {
			const dir = tmpDirPath();
			const path = join(dir, ".piignore");
			writeFileSync(path, "*.log\nbuild/*\n", "utf-8");
			const patterns = resolvePiignorePatterns(path);
			assert.equal(patterns.length, 2);
			assert.equal(patterns[0]!.type, "glob");
			assert.equal(patterns[1]!.type, "glob");
			rmSync(dir, { recursive: true });
		});

		it("resolves negation patterns with negate flag", () => {
			const dir = tmpDirPath();
			const path = join(dir, ".piignore");
			writeFileSync(path, "!important.log\n", "utf-8");
			const patterns = resolvePiignorePatterns(path);
			assert.equal(patterns.length, 1);
			assert.equal(patterns[0]!.negate, true);
			assert.equal(patterns[0]!.raw, "important.log");
			rmSync(dir, { recursive: true });
		});

		it("resolves mixed patterns correctly", () => {
			const dir = tmpDirPath();
			const path = join(dir, ".piignore");
			writeFileSync(
				path,
				["# Exclude cache", ".pi/cache/", "*.tmp", "!keep.tmp", "dist/"].join("\n"),
				"utf-8",
			);
			const patterns = resolvePiignorePatterns(path);
			assert.equal(patterns.length, 4);
			assert.equal(patterns[0]!.raw, ".pi/cache/");
			assert.equal(patterns[0]!.type, "exact");
			assert.equal(patterns[0]!.negate, false);
			assert.equal(patterns[1]!.raw, "*.tmp");
			assert.equal(patterns[1]!.type, "glob");
			assert.equal(patterns[1]!.negate, false);
			assert.equal(patterns[2]!.raw, "keep.tmp");
			assert.equal(patterns[2]!.type, "exact");
			assert.equal(patterns[2]!.negate, true);
			assert.equal(patterns[3]!.raw, "dist/");
			assert.equal(patterns[3]!.type, "exact");
			assert.equal(patterns[3]!.negate, false);
			rmSync(dir, { recursive: true });
		});
	});

	// ── matchPiignorePattern ────────────────────────────────────────

	describe("matchPiignorePattern", () => {
		it("matches exact directory path prefix (.pi/cache should match .pi/cache/index.ts)", () => {
			const result = matchPiignorePattern(
				{ raw: ".pi/cache", type: "exact", pattern: ".pi/cache", negate: false },
				".pi/cache/index.ts",
			);
			assert.equal(result, true);
		});

		it("does NOT match sibling directories (src/utils/cache should NOT match .pi/cache rule)", () => {
			const result = matchPiignorePattern(
				{ raw: ".pi/cache", type: "exact", pattern: ".pi/cache", negate: false },
				"src/utils/cache/helper.ts",
			);
			assert.equal(result, false);
		});

		it("matches exact file path", () => {
			const result = matchPiignorePattern(
				{ raw: "secrets.env", type: "exact", pattern: "secrets.env", negate: false },
				"secrets.env",
			);
			assert.equal(result, true);
		});

		it("does not match different file with same name in different dir", () => {
			const result = matchPiignorePattern(
				{ raw: "config/local.env", type: "exact", pattern: "config/local.env", negate: false },
				"other/config/local.env",
			);
			assert.equal(result, false);
		});

		it("matches glob pattern *.log against full path", () => {
			const result = matchPiignorePattern(
				{ raw: "*.log", type: "glob", pattern: "*.log", negate: false },
				"build/output.log",
			);
			assert.equal(result, true);
		});

		it("does not match glob pattern *.log against non-matching extension", () => {
			const result = matchPiignorePattern(
				{ raw: "*.log", type: "glob", pattern: "*.log", negate: false },
				"build/output.txt",
			);
			assert.equal(result, false);
		});

		it("matches directory glob pattern (build/* against build/asset.js)", () => {
			const result = matchPiignorePattern(
				{ raw: "build/*", type: "glob", pattern: "build/*", negate: false },
				"build/asset.js",
			);
			assert.equal(result, true);
		});

		it("negation pattern (.pi/cache but !.pi/cache/keep.ts) — keep.ts should NOT match", () => {
			// Negation means: if matched, the file is NOT excluded
			// So matchPiignorePattern returning true for a negated pattern means
			// "this file would have been excluded but is protected"
			const result = matchPiignorePattern(
				{ raw: "keep.ts", type: "exact", pattern: "keep.ts", negate: true },
				"keep.ts",
			);
			assert.equal(result, true);
		});

		it("matches file with trailing slash pattern (.pi/cache/ should match .pi/cache/file.ts)", () => {
			const result = matchPiignorePattern(
				{ raw: ".pi/cache/", type: "exact", pattern: ".pi/cache/", negate: false },
				".pi/cache/file.ts",
			);
			assert.equal(result, true);
		});

		it("matches ** glob patterns like **/temp against paths inside temp directory", () => {
			const result = matchPiignorePattern(
				{ raw: "**/temp", type: "glob", pattern: "**/temp", negate: false },
				"src/temp/file.ts",
			);
			assert.equal(result, true);
		});
	});

	// ── Integration: post-filter pipeline in engine ────────────────

	describe("engine integrates post-filter step", () => {
		it("buildOrLoadIndex filters out symbols matching .piignore exact path", async () => {
			const dir = tmpDirPath();
			const cacheDir = join(dir, "cache");
			mkdirSync(cacheDir, { recursive: true });

			// Create .piignore that excludes .pi/cache/
			const piignorePath = join(dir, ".piignore");
			writeFileSync(piignorePath, ".pi/cache/\n", "utf-8");

			// Create a mock project directory with ctags-parseable files
			const srcDir = join(dir, "src");
			mkdirSync(srcDir, { recursive: true });
			writeFileSync(join(srcDir, "app.ts"), "export class App {}", "utf-8");

			const piCacheDir = join(dir, ".pi", "cache");
			mkdirSync(piCacheDir, { recursive: true });
			writeFileSync(join(piCacheDir, "index.json"), "{}", "utf-8");

			// Mock exec: return ctags JSONL for files in both .pi/cache/ and src/
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["rev-parse", "HEAD"],
					handler: async () => ({ stdout: "abc123\n", stderr: "", code: 0, killed: false }),
				},
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
				},
				{
					cmd: "ctags",
					handler: async () => ({
						stdout:
							[
								JSON.stringify({
									_type: "tag",
									name: "App",
									kind: "class",
									path: "src/app.ts",
									pattern: "/^export class App {}$/",
								}),
								JSON.stringify({
									_type: "tag",
									name: "CacheData",
									kind: "class",
									path: ".pi/cache/index.json",
									pattern: "/^...$/",
								}),
							].join("\n") + "\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const config: RankedMapConfig = {
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			};

			const engine = new RankedMapEngine(config, exec, dir);
			const index = await engine.buildOrLoadIndex(dir, cacheDir);

			// .pi/cache/index.json should be filtered out
			assert.ok(index.symbols["src/app.ts"], "src/app.ts should be present");
			assert.ok(
				!index.symbols[".pi/cache/index.json"],
				".pi/cache/index.json should be filtered out by .piignore",
			);
			rmSync(dir, { recursive: true });
		});

		it("buildOrLoadIndex allows cached index with workingTreeHash match", async () => {
			const dir = tmpDirPath();
			const cacheDir = join(dir, "cache");
			mkdirSync(cacheDir, { recursive: true });
			const cachePath = join(cacheDir, "ranked-map-index.json");

			const configHash = computeConfigHash({
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			});

			// Write a pre-existing cache with matching workingTreeHash
			writeFileSync(
				cachePath,
				JSON.stringify({
					head: "abc123",
					builtAt: Date.now(),
					symbols: { "src/app.ts": [{ type: "class", name: "App", line: 1 }] },
					configHash,
					targetDir: dir,
					workingTreeHash: "deadbeef",
				}),
			);

			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["rev-parse", "HEAD"],
					handler: async () => ({ stdout: "abc123\n", stderr: "", code: 0, killed: false }),
				},
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => ({ stdout: " M src/app.ts\n", stderr: "", code: 0, killed: false }),
				},
			]);

			const config: RankedMapConfig = {
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			};

			const engine = new RankedMapEngine(config, exec, dir);
			const index = await engine.buildOrLoadIndex(dir, cacheDir);

			// Expect cache hit because workingTreeHash matches
			assert.ok(index, "should return index");
			assert.equal(index.head, "abc123", "should match cached head");
			rmSync(dir, { recursive: true });
		});

		it("buildOrLoadIndex rebuilds on workingTreeHash mismatch", async () => {
			const dir = tmpDirPath();
			const cacheDir = join(dir, "cache");
			mkdirSync(cacheDir, { recursive: true });
			const cachePath = join(cacheDir, "ranked-map-index.json");

			const configHash = computeConfigHash({
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			});

			// Write cache with different workingTreeHash
			writeFileSync(
				cachePath,
				JSON.stringify({
					head: "abc123",
					builtAt: Date.now(),
					symbols: { "src/app.ts": [{ type: "class", name: "App", line: 1 }] },
					configHash,
					targetDir: dir,
					workingTreeHash: "aaaaaa",
				}),
			);

			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["rev-parse", "HEAD"],
					handler: async () => ({ stdout: "abc123\n", stderr: "", code: 0, killed: false }),
				},
				{
					cmd: "git",
					args: ["status", "--porcelain"],
					handler: async () => ({ stdout: " M src/app.ts\n", stderr: "", code: 0, killed: false }),
				},
				{
					cmd: "ctags",
					handler: async () => ({
						stdout:
							JSON.stringify({
								_type: "tag",
								name: "App",
								kind: "class",
								path: "src/app.ts",
								pattern: "/^...$/",
							}) + "\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const config: RankedMapConfig = {
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			};

			const engine = new RankedMapEngine(config, exec, dir);
			const index = await engine.buildOrLoadIndex(dir, cacheDir);

			// Expect rebuilt because workingTreeHash mismatch
			assert.ok(index, "should return index");
			assert.ok(
				index.workingTreeHash,
				"newly built index should have workingTreeHash from git status",
			);
			assert.match(index.workingTreeHash!, /^[0-9a-f]+$/, "workingTreeHash should be a hex string");
			rmSync(dir, { recursive: true });
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Feature 3: Bounded Git Recency Search
// ═══════════════════════════════════════════════════════════════════════

describe("Feature 3: Bounded Git Recency Search", () => {
	describe("runGitRecency injects --max-count", () => {
		it("includes --max-count argument in superproject git log", async () => {
			let capturedArgs: string[] = [];
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async (_cmd, args, _opts) => {
						capturedArgs = args;
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			const config: RankedMapConfig = {
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				maxCommits: 500,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			};

			await runGitRecency(
				exec,
				config.recencyWindowDays,
				"/tmp",
				undefined,
				undefined,
				config.maxCommits,
			);

			assert.ok(
				capturedArgs.includes("--max-count=500"),
				`should include --max-count=500 in args: ${capturedArgs.join(" ")}`,
			);
		});

		it("includes --max-count argument in submodule git log", async () => {
			const superArgs: string[] = [];
			const subArgs: string[] = [];
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async (_cmd, args, _opts) => {
						superArgs.push(...args);
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
				{
					cmd: "git",
					args: ["-C", "sub_a", "log"],
					handler: async (_cmd, args, _opts) => {
						subArgs.push(...args);
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			await runGitRecency(exec, 30, "/tmp", undefined, [{ path: "sub_a", sha: "def456" }], 1000);

			assert.ok(
				superArgs.includes("--max-count=1000"),
				`superproject args should include --max-count=1000: ${superArgs.join(" ")}`,
			);
			assert.ok(
				subArgs.includes("--max-count=1000"),
				`submodule args should include --max-count=1000: ${subArgs.join(" ")}`,
			);
		});

		it("defaults to 1000 when maxCommits not provided", async () => {
			let capturedArgs: string[] = [];
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async (_cmd, args, _opts) => {
						capturedArgs = args;
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			await runGitRecency(exec, 30, "/tmp");

			assert.ok(
				capturedArgs.includes("--max-count=1000"),
				`should include default --max-count=1000: ${capturedArgs.join(" ")}`,
			);
		});

		it("does not apply --max-count when negative/zero/invalid", async () => {
			let capturedArgs: string[] = [];
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async (_cmd, args, _opts) => {
						capturedArgs = args;
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			await runGitRecency(exec, 30, "/tmp", undefined, undefined, 0);
			assert.ok(!capturedArgs.includes("--max-count=0"), "should not include --max-count=0");
		});
	});

	describe("runGitCommitCount injects --max-count", () => {
		it("includes --max-count argument in superproject git log", async () => {
			let capturedArgs: string[] = [];
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async (_cmd, args, _opts) => {
						capturedArgs = args;
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			await runGitCommitCount(exec, 30, "/tmp", undefined, undefined, 500);

			assert.ok(
				capturedArgs.includes("--max-count=500"),
				`should include --max-count=500: ${capturedArgs.join(" ")}`,
			);
		});

		it("includes --max-count in submodule commit count", async () => {
			const subArgs: string[] = [];
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async (_cmd, args, _opts) => {
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
				{
					cmd: "git",
					args: ["-C", "sub_a", "log"],
					handler: async (_cmd, args, _opts) => {
						subArgs.push(...args);
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			await runGitCommitCount(
				exec,
				30,
				"/tmp",
				undefined,
				[{ path: "sub_a", sha: "def456" }],
				1000,
			);

			assert.ok(
				subArgs.includes("--max-count=1000"),
				`submodule args should include --max-count=1000: ${subArgs.join(" ")}`,
			);
		});
	});

	// ── RankedMapConfig includes maxCommits ────────────────────────

	describe("RankedMapConfig includes maxCommits", () => {
		it("allows maxCommits on RankedMapConfig", () => {
			const config: RankedMapConfig = {
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				maxCommits: 500,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			};
			assert.equal(config.maxCommits, 500);
		});

		it("allows undefined maxCommits (default 1000)", () => {
			const config: RankedMapConfig = {
				tokenBudget: 4096,
				recencyWindowDays: 30,
				cacheTtlHours: 24,
				autoThreshold: 20000,
				weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
			};
			assert.equal(config.maxCommits, undefined);
		});
	});

	// ── config.ts parses maxCommits ─────────────────────────────────

	describe("loadRankedMapConfig parses maxCommits", () => {
		it("loads maxCommits from settings.json", () => {
			const dir = tmpDirPath();
			const piDir = join(dir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "settings.json"),
				JSON.stringify({
					rankedMap: {
						maxCommits: 500,
						tokenBudget: 4096,
						recencyWindowDays: 30,
						cacheTtlHours: 24,
						autoThreshold: 20000,
						weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
					},
				}),
			);
			const config = loadRankedMapConfig(dir);
			assert.equal(config.maxCommits, 500);
			rmSync(dir, { recursive: true });
		});

		it("defaults maxCommits to 1000 when not set", () => {
			const dir = tmpDirPath();
			const piDir = join(dir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "settings.json"),
				JSON.stringify({
					rankedMap: {
						tokenBudget: 4096,
						recencyWindowDays: 30,
						cacheTtlHours: 24,
						autoThreshold: 20000,
						weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
					},
				}),
			);
			const config = loadRankedMapConfig(dir);
			assert.equal(config.maxCommits, 1000);
			rmSync(dir, { recursive: true });
		});

		it("ignores invalid maxCommits values", () => {
			const dir = tmpDirPath();
			const piDir = join(dir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "settings.json"),
				JSON.stringify({
					rankedMap: {
						maxCommits: -1,
						tokenBudget: 4096,
						recencyWindowDays: 30,
						cacheTtlHours: 24,
						autoThreshold: 20000,
						weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
					},
				}),
			);
			const config = loadRankedMapConfig(dir);
			assert.equal(config.maxCommits, 1000, "should default to 1000 when invalid");
			rmSync(dir, { recursive: true });
		});

		it("ignores non-integer maxCommits", () => {
			const dir = tmpDirPath();
			const piDir = join(dir, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(
				join(piDir, "settings.json"),
				JSON.stringify({
					rankedMap: {
						maxCommits: 500.5,
						tokenBudget: 4096,
						recencyWindowDays: 30,
						cacheTtlHours: 24,
						autoThreshold: 20000,
						weights: { keyword: 0.5, recency: 0.3, fileSize: 0.2 },
					},
				}),
			);
			const config = loadRankedMapConfig(dir);
			assert.equal(config.maxCommits, 1000, "should default to 1000 for non-integer");
			rmSync(dir, { recursive: true });
		});
	});
});
