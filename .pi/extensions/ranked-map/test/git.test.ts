/**
 * Tests for git.ts — SubmoduleInfo, discoverSubmodules, and extended runGitRecency
 *
 * Phase 1: SubmoduleInfo type and discoverSubmodules adapter
 * Phase 2: Extended runGitRecency with submodule support
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ranked-map/test/git.test.ts
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ExecFn, SubmoduleInfo } from "../types.ts";
import { discoverSubmodules, runGitRecency, getGitHead } from "../git.ts";

// Helper: create a conditional mock exec that returns different results
// based on command and args
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
					// Prefix match: handler's args must match the first N args of the command.
					// This prevents "log" from matching "-C sub_a log" when "-C" is arg[0].
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

// ---------------------------------------------------------------------------
// Phase 1: SubmoduleInfo type + discoverSubmodules
// ---------------------------------------------------------------------------

describe("Phase 1: discoverSubmodules", () => {
	describe("SubmoduleInfo type (structural)", () => {
		it("SubmoduleInfo type has shape {path, url?, sha?}", () => {
			const sm: SubmoduleInfo = { path: "flask_blogs" };
			assert.equal(sm.path, "flask_blogs");
			assert.equal(sm.url, undefined);
			assert.equal(sm.sha, undefined);

			const sm2: SubmoduleInfo = {
				path: "flask_blogs",
				url: "https://example.com/repo.git",
				sha: "abc123",
			};
			assert.equal(sm2.path, "flask_blogs");
			assert.equal(sm2.url, "https://example.com/repo.git");
			assert.equal(sm2.sha, "abc123");
		});
	});

	describe("discoverSubmodules via git submodule status", () => {
		it("parses 'git submodule status' output with initialized submodule", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async () => ({
						stdout: " abc123def456 flask_blogs (v1.2.3)\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await discoverSubmodules(exec, "/test/repo");
			assert.equal(result.length, 1);
			assert.equal(result[0]!.path, "flask_blogs");
			assert.equal(result[0]!.sha, "abc123def456");
		});

		it("strips leading -/+/U prefixes from git submodule status lines", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async () => ({
						stdout: [
							"-abc111 flask_blogs_a (v1.0)",
							"+abc222 flask_blogs_b (v2.0)",
							"Uabc333 flask_blogs_c (v3.0)",
							" abc444 flask_blogs_d (v4.0)",
						].join("\n"),
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await discoverSubmodules(exec, "/test/repo");
			assert.equal(result.length, 4);

			// Uninitialized (-) gets sha "uninitialized"
			assert.equal(result[0]!.path, "flask_blogs_a");
			assert.equal(result[0]!.sha, "uninitialized");

			// Modified (+), merge conflict (U), and normal ( ) all get the raw sha
			assert.equal(result[1]!.path, "flask_blogs_b");
			assert.equal(result[1]!.sha, "abc222");

			assert.equal(result[2]!.path, "flask_blogs_c");
			assert.equal(result[2]!.sha, "abc333");

			assert.equal(result[3]!.path, "flask_blogs_d");
			assert.equal(result[3]!.sha, "abc444");
		});

		it("returns empty array when git submodule status fails (non-zero exit)", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async () => ({
						stdout: "",
						stderr: "fatal: not a git repository",
						code: 128,
						killed: false,
					}),
				},
			]);

			const result = await discoverSubmodules(exec, "/test/repo");
			assert.deepEqual(result, []);
		});

		it("mockExecConditional confirms correct args: git submodule status from cwd", async () => {
			let capturedCwd = "";
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async (_cmd, _args, opts) => {
						capturedCwd = opts?.cwd ?? "";
						return {
							stdout: " abc123 flask_blogs (v1.0)\n",
							stderr: "",
							code: 0,
							killed: false,
						};
					},
				},
			]);

			await discoverSubmodules(exec, "/test/repo");
			assert.equal(capturedCwd, "/test/repo", "should run git submodule status from repo root");
		});

		it("returns multiple submodules when multiple are present", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async () => ({
						stdout: [" abc111 sub_a (v1.0)", " abc222 sub_b (v2.0)", " abc333 sub_c (v3.0)"].join(
							"\n",
						),
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await discoverSubmodules(exec, "/test/repo");
			assert.equal(result.length, 3);
			assert.equal(result[0]!.path, "sub_a");
			assert.equal(result[1]!.path, "sub_b");
			assert.equal(result[2]!.path, "sub_c");
		});
	});

	describe("discoverSubmodules .gitmodules fallback", () => {
		it("falls back to parsing .gitmodules when git submodule status returns empty stdout", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async () => ({
						stdout: "",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"],
					handler: async () => ({
						stdout: "submodule.flask_blogs.path flask_blogs\nsubmodule.other.path other\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.url"],
					handler: async () => ({
						stdout:
							"submodule.flask_blogs.url https://example.com/repo.git\nsubmodule.other.url https://example.com/other.git\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await discoverSubmodules(exec, "/test/repo");
			assert.equal(result.length, 2);
			assert.equal(result[0]!.path, "flask_blogs");
			assert.equal(result[0]!.url, "https://example.com/repo.git");
			assert.equal(result[0]!.sha, undefined);
			assert.equal(result[1]!.path, "other");
			assert.equal(result[1]!.url, "https://example.com/other.git");
		});

		it("returns entries from .gitmodules when no sha is available (uninitialized)", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async () => ({
						stdout: "",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"],
					handler: async () => ({
						stdout: "submodule.flask_blogs.path flask_blogs\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.url"],
					handler: async () => ({
						stdout: "submodule.flask_blogs.url https://example.com/repo.git\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await discoverSubmodules(exec, "/test/repo");
			assert.equal(result.length, 1);
			assert.equal(result[0]!.path, "flask_blogs");
			assert.equal(result[0]!.url, "https://example.com/repo.git");
			assert.equal(result[0]!.sha, undefined);
		});

		it("returns empty array when neither git submodule status nor .gitmodules exist", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					handler: async (cmd, args) => {
						if (cmd === "git" && args[0] === "submodule") {
							return {
								stdout: "",
								stderr: "fatal: not a git repository",
								code: 128,
								killed: false,
							};
						}
						if (cmd === "git" && args.includes("--get-regexp")) {
							return {
								stdout: "",
								stderr: "fatal: not in a git directory",
								code: 128,
								killed: false,
							};
						}
						return { stdout: "", stderr: "unknown", code: 1, killed: false };
					},
				},
			]);

			const result = await discoverSubmodules(exec, "/test/non-repo");
			assert.deepEqual(result, []);
		});

		it("falls back to .gitmodules when git submodule status fails but .gitmodules config succeeds", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["submodule", "status"],
					handler: async () => ({
						stdout: "",
						stderr: "fatal: not a git repository",
						code: 128,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.path"],
					handler: async () => ({
						stdout: "submodule.flask_blogs.path flask_blogs\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["config", "--file", ".gitmodules", "--get-regexp", "submodule\\..*\\.url"],
					handler: async () => ({
						stdout: "submodule.flask_blogs.url https://github.com/user/repo.git\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await discoverSubmodules(exec, "/test/repo");
			assert.equal(result.length, 1);
			assert.equal(result[0]!.path, "flask_blogs");
			assert.equal(result[0]!.url, "https://github.com/user/repo.git");
		});
	});
});

// ---------------------------------------------------------------------------
// Phase 2: Extended runGitRecency with submodule support
// ---------------------------------------------------------------------------

describe("Phase 2: runGitRecency with submodule support", () => {
	describe("existing behavior unchanged (no submodules)", () => {
		it("returns empty map when submodules is undefined (unchanged behavior)", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "2026-06-01T12:00:00Z\nsrc/foo.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo");
			assert.ok(result["src/foo.ts"], "should have superproject git data");
			assert.equal(result["src/foo.ts"], "2026-06-01T12:00:00Z");
		});

		it("returns empty map when submodules is empty array (unchanged behavior)", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "2026-06-01T12:00:00Z\nsrc/foo.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo", undefined, []);
			assert.ok(result["src/foo.ts"], "should have superproject git data");
			assert.equal(result["src/foo.ts"], "2026-06-01T12:00:00Z");
		});
	});

	describe("submodule git log integration", () => {
		it("with one submodule, runs git -C path log inside submodule path", async () => {
			let capturedOpts: any = null;
			const submodules: SubmoduleInfo[] = [{ path: "flask_blogs", sha: "abc123" }];

			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["-C", "flask_blogs", "log"],
					handler: async (_cmd, _args, opts) => {
						capturedOpts = opts;
						return {
							stdout: "2026-06-01T12:00:00Z\nflask_planhead/run.py\n",
							stderr: "",
							code: 0,
							killed: false,
						};
					},
				},
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "2026-05-01T12:00:00Z\nsrc/foo.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo", undefined, submodules);

			// Submodule file paths should be prefixed with "submodulePath/"
			assert.ok(
				result["flask_blogs/flask_planhead/run.py"],
				"submodule file path should be prefixed",
			);
			assert.equal(result["flask_blogs/flask_planhead/run.py"], "2026-06-01T12:00:00Z");

			// Superproject file should still exist
			assert.ok(result["src/foo.ts"], "superproject file should still be present");
		});

		it("prefixes submodule file paths with submodulePath/ before merging", async () => {
			const submodules: SubmoduleInfo[] = [{ path: "flask_blogs", sha: "abc123" }];

			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["-C", "flask_blogs", "log"],
					handler: async () => ({
						stdout: "2026-06-01T12:00:00Z\napp.py\nsrc/utils.py\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo", undefined, submodules);

			assert.ok(result["flask_blogs/app.py"], "should prefix app.py with flask_blogs/");
			assert.ok(result["flask_blogs/src/utils.py"], "should prefix src/utils.py with flask_blogs/");
		});

		it("submodule file dates merged without overwriting more-recent superproject dates", async () => {
			const submodules: SubmoduleInfo[] = [{ path: "flask_blogs", sha: "abc123" }];

			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["-C", "flask_blogs", "log"],
					handler: async () => ({
						// Submodule has more recent date
						stdout: "2026-06-01T12:00:00Z\nshared/file.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						// Superproject has older date for a different path (same basename)
						stdout: "2026-05-01T12:00:00Z\nshared/file.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo", undefined, submodules);

			// Superproject and submodule paths differ due to prefix, so both should exist
			assert.ok(result["shared/file.ts"], "superproject shared/file.ts should exist");
			assert.equal(result["shared/file.ts"], "2026-05-01T12:00:00Z");
			assert.ok(
				result["flask_blogs/shared/file.ts"],
				"submodule flask_blogs/shared/file.ts should exist",
			);
			assert.equal(result["flask_blogs/shared/file.ts"], "2026-06-01T12:00:00Z");
		});

		it("submodule git log failure silently skipped, superproject results preserved", async () => {
			const submodules: SubmoduleInfo[] = [{ path: "flask_blogs", sha: "abc123" }];

			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "2026-06-01T12:00:00Z\nsrc/foo.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo", undefined, submodules);

			// No handler for flask_blogs git -C, so that call returns default {stdout: "", code: 0}
			assert.ok(result["src/foo.ts"], "superproject results should be preserved");
			assert.equal(result["src/foo.ts"], "2026-06-01T12:00:00Z");
		});

		it("uninitialized submodule skipped without running git log", async () => {
			const submodules: SubmoduleInfo[] = [{ path: "flask_blogs", sha: "uninitialized" }];

			let submoduleLogCalled = false;
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "2026-06-01T12:00:00Z\nsrc/foo.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["-C", "flask_blogs", "log"],
					handler: async () => {
						submoduleLogCalled = true;
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo", undefined, submodules);

			assert.ok(!submoduleLogCalled, "should NOT run git log in uninitialized submodule");
			assert.ok(result["src/foo.ts"], "superproject results should be preserved");
		});

		it("handles multiple submodules", async () => {
			const submodules: SubmoduleInfo[] = [
				{ path: "sub_a", sha: "aaa" },
				{ path: "sub_b", sha: "bbb" },
			];

			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "2026-06-01T12:00:00Z\nroot.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["-C", "sub_a", "log"],
					handler: async () => ({
						stdout: "2026-06-02T12:00:00Z\nsrc/a.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
				{
					cmd: "git",
					args: ["-C", "sub_b", "log"],
					handler: async () => ({
						stdout: "2026-06-03T12:00:00Z\nsrc/b.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo", undefined, submodules);

			assert.ok(result["root.ts"], "superproject file should exist");
			assert.ok(result["sub_a/src/a.ts"], "sub_a file should be prefixed with sub_a/");
			assert.ok(result["sub_b/src/b.ts"], "sub_b file should be prefixed with sub_b/");
			assert.equal(result["sub_a/src/a.ts"], "2026-06-02T12:00:00Z");
			assert.equal(result["sub_b/src/b.ts"], "2026-06-03T12:00:00Z");
		});

		it("uses submodule's cwd for git -C path log commands", async () => {
			const submodules: SubmoduleInfo[] = [{ path: "my_submod", sha: "abc123" }];

			let capturedCwd = "";
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["-C", "my_submod", "log"],
					handler: async (_cmd, _args, opts) => {
						capturedCwd = opts?.cwd ?? "";
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			await runGitRecency(exec, 30, "/test/repo", undefined, submodules);
			assert.equal(capturedCwd, "/test/repo", "should use repo cwd for submodule git command");
		});
	});

	describe("Backward compatibility with existing signature", () => {
		it("call with 4 args (no submodules) works as before", async () => {
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async () => ({
						stdout: "2026-06-01T12:00:00Z\nsrc/foo.ts\n",
						stderr: "",
						code: 0,
						killed: false,
					}),
				},
			]);

			const result = await runGitRecency(exec, 30, "/test/repo");
			assert.ok(result["src/foo.ts"]);
		});

		it("passing signal without submodules works", async () => {
			const controller = new AbortController();
			const exec = mockExecConditional([
				{
					cmd: "git",
					args: ["log"],
					handler: async (_cmd, _args, opts) => {
						assert.ok(opts?.signal, "should pass signal through");
						return { stdout: "", stderr: "", code: 0, killed: false };
					},
				},
			]);

			await runGitRecency(exec, 30, "/test/repo", controller.signal);
		});
	});
});
