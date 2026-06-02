// ─── Tests: pipeline/worktree.ts — worktree lifecycle ───────────
// Tests with mock pi.exec. No git operations.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorktree, installWorktreeDeps, cleanupWorktree } from "../../pipeline/worktree.ts";

// ─── Helpers ──────────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(
	results: Array<{ code: number; stdout: string; stderr: string }>,
	calls?: ExecCall[],
): ExtensionAPI {
	const callLog = calls || [];
	let idx = 0;
	return {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			callLog.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
}

// ─── Tests: createWorktree() ─────────────────────────────────────

describe("createWorktree()", () => {
	it("creates worktree with -b flag on first attempt", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		const wt = await createWorktree(pi, "/repo", "../worktrees", "feature-branch", "main");
		assert.ok(wt.includes("feature-branch"));
		assert.deepEqual(calls[0].args, ["worktree", "add", "-b", "feature-branch", wt, "main"]);
	});

	it("falls back to add without -b when first attempt fails", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 1, stdout: "", stderr: "already exists" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		await createWorktree(pi, "/repo", "../worktrees", "feature-branch", "main");
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[1].args, ["worktree", "add", calls[1].args[2], "feature-branch"]);
	});

	it("succeeds (idempotent) even when both attempts fail", async () => {
		const pi = createMockPi([
			{ code: 1, stdout: "", stderr: "error" },
			{ code: 1, stdout: "", stderr: "already exists" },
		]);
		const wt = await createWorktree(pi, "/repo", "../worktrees", "branch", "main");
		assert.ok(wt.includes("branch"));
	});
});

// ─── Tests: installWorktreeDeps() ─────────────────────────────────

describe("installWorktreeDeps()", () => {
	it("runs npm ci in worktree path", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi([{ code: 0, stdout: "", stderr: "" }], calls);
		await installWorktreeDeps(pi, "/worktree");
		assert.deepEqual(calls[0], {
			cmd: "npm",
			args: ["ci"],
			opts: { cwd: "/worktree", timeout: 120_000 },
		});
	});

	it("does not throw on npm ci failure", async () => {
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "error" }]);
		await installWorktreeDeps(pi, "/worktree");
	});
});

// ─── Tests: cleanupWorktree() ────────────────────────────────────

describe("cleanupWorktree()", () => {
	it("removes worktree and deletes branch", async () => {
		const calls: ExecCall[] = [];
		const pi = createMockPi(
			[
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
				{ code: 0, stdout: "", stderr: "" },
			],
			calls,
		);
		await cleanupWorktree(pi, "/repo", "/worktree", "branch");
		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0].args, ["worktree", "remove", "--force", "/worktree"]);
		assert.deepEqual(calls[1].args, ["worktree", "prune"]);
		assert.deepEqual(calls[2].args, ["branch", "-D", "branch"]);
	});

	it("does not throw on cleanup failure", async () => {
		const pi = createMockPi([{ code: 1, stdout: "", stderr: "error" }]);
		await cleanupWorktree(pi, "/repo", "/worktree", "branch");
	});
});
