// ─── Tests: github/git.ts — git operations ───────────────────────
// Tests for commitChanges, pushBranch, commitAndPush.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitChanges, pushBranch, commitAndPush } from "./git.ts";

// ─── Helpers ──────────────────────────────────────────────────────

interface ExecCall {
	cmd: string;
	args: string[];
	opts: Record<string, unknown>;
}

function createMockPi(results: Array<{ code: number; stdout: string; stderr: string }>): {
	pi: ExtensionAPI;
	calls: ExecCall[];
} {
	const calls: ExecCall[] = [];
	let idx = 0;
	const pi = {
		exec: ((cmd: string, args: string[], opts?: Record<string, unknown>) => {
			calls.push({ cmd, args: args || [], opts: opts || {} });
			return Promise.resolve(results[idx++] || { code: 0, stdout: "", stderr: "" });
		}) as ExtensionAPI["exec"],
	} as ExtensionAPI;
	return { pi, calls };
}

// ─── Tests: commitChanges() ───────────────────────────────────────

describe("commitChanges()", () => {
	it("calls git commit with correct args", async () => {
		const { pi, calls } = createMockPi([{ code: 0, stdout: "committed", stderr: "" }]);
		await commitChanges(pi, "/tmp/worktree", "feat(#123): add feature");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].cmd, "git");
		assert.deepEqual(calls[0].args, ["commit", "-m", "feat(#123): add feature"]);
		assert.equal(calls[0].opts.cwd, "/tmp/worktree");
	});

	it("throws on git commit failure", async () => {
		const { pi } = createMockPi([{ code: 1, stdout: "", stderr: "nothing to commit" }]);
		await assert.rejects(() => commitChanges(pi, "/tmp/worktree", "msg"), /git commit failed/);
	});
});

// ─── Tests: pushBranch() ──────────────────────────────────────────

describe("pushBranch()", () => {
	it("calls git push with correct args", async () => {
		const { pi, calls } = createMockPi([{ code: 0, stdout: "", stderr: "" }]);
		await pushBranch(pi, "/tmp/worktree", "origin", "feature-branch");
		assert.equal(calls[0].cmd, "git");
		assert.deepEqual(calls[0].args, ["push", "origin", "feature-branch"]);
	});

	it("throws on git push failure", async () => {
		const { pi } = createMockPi([{ code: 1, stdout: "", stderr: "rejected" }]);
		await assert.rejects(
			() => pushBranch(pi, "/tmp/worktree", "origin", "feature"),
			/git push failed/,
		);
	});
});

// ─── Tests: commitAndPush() ───────────────────────────────────────

describe("commitAndPush()", () => {
	it("stages all changes, commits, then pushes", async () => {
		const { pi, calls } = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 0, stdout: "committed", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		await commitAndPush(pi, "/tmp/worktree", "origin", "feature", "feat(#123): msg");
		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0].args, ["add", "-A"]);
		assert.deepEqual(calls[1].args, ["commit", "-m", "feat(#123): msg"]);
		assert.deepEqual(calls[2].args, ["push", "origin", "feature"]);
	});

	it("throws when git commit returns 'nothing to commit' (no changes)", async () => {
		const { pi } = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "", stderr: "nothing to commit" },
		]);
		await assert.rejects(
			() => commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg"),
			/No changes to commit/,
		);
	});

	it("throws when git add fails", async () => {
		const { pi } = createMockPi([{ code: 1, stdout: "", stderr: "fatal error" }]);
		await assert.rejects(
			() => commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg"),
			/git add failed/,
		);
	});

	it("throws when git commit fails with real error (not 'nothing to commit')", async () => {
		const { pi } = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "", stderr: "fatal: bad config" },
		]);
		await assert.rejects(
			() => commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg"),
			/git commit failed/,
		);
	});

	it("does not push when nothing to commit (short-circuits before push)", async () => {
		const { pi, calls } = createMockPi([
			{ code: 0, stdout: "", stderr: "" },
			{ code: 1, stdout: "", stderr: "nothing to commit" },
		]);
		await assert.rejects(
			() => commitAndPush(pi, "/tmp/worktree", "origin", "feature", "msg"),
			/No changes to commit/,
		);
		assert.equal(calls.length, 2); // add + commit, no push
	});
});
