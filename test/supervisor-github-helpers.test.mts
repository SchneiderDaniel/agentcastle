/**
 * Tests for git/GitHub deterministic helpers (Phase 1).
 *
 * Phase 1: pushBranch, commitChanges, commitAndPush, createPullRequest
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-github-helpers.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	pushBranch,
	commitChanges,
	commitAndPush,
} from "../.pi/extensions/supervisor/github/git.ts";
import { createPullRequest } from "../.pi/extensions/supervisor/github/pr.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExecCall {
	cmd: string;
	args: string[];
	opts?: Record<string, unknown>;
}

function makeMockPi(results: Array<{ code: number; stdout?: string; stderr?: string }> = []) {
	let callIndex = 0;
	const calls: ExecCall[] = [];
	const pi = {
		exec: (_cmd: string, _args: string[], _opts?: Record<string, unknown>) => {
			const idx = callIndex++;
			calls.push({ cmd: _cmd, args: _args, opts: _opts });
			const result = idx < results.length ? results[idx] : { code: 0, stdout: "", stderr: "" };
			return Promise.resolve(result);
		},
		registerCommand: () => {},
		registerTool: () => {},
		sendMessage: () => {},
	};
	return { pi, calls };
}

// ---------------------------------------------------------------------------
// Tests — commitChanges
// ---------------------------------------------------------------------------

describe("commitChanges", () => {
	it("calls pi.exec(git, [commit, -m, msg], {cwd}) and returns on code 0", async () => {
		const { pi, calls } = makeMockPi([{ code: 0, stdout: "1 file changed" }]);
		await commitChanges(pi as any, "/some/cwd", "feat(#42): add feature");
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].cmd, "git");
		assert.deepStrictEqual(calls[0].args, ["commit", "-m", "feat(#42): add feature"]);
		assert.deepStrictEqual(calls[0].opts, { cwd: "/some/cwd" });
	});

	it("throws error when pi.exec returns non-zero", async () => {
		const { pi } = makeMockPi([{ code: 1, stderr: "nothing to commit" }]);
		await assert.rejects(() => commitChanges(pi as any, "/cwd", "msg"), /git commit failed/i);
	});

	it("throws error when pi.exec throws", async () => {
		const pi = {
			exec: () => Promise.reject(new Error("git not found")),
			registerCommand: () => {},
			registerTool: () => {},
			sendMessage: () => {},
		};
		await assert.rejects(() => commitChanges(pi as any, "/cwd", "msg"), /git not found/i);
	});
});

// ---------------------------------------------------------------------------
// Tests — pushBranch
// ---------------------------------------------------------------------------

describe("pushBranch", () => {
	it("calls pi.exec(git, [push, remote, branch], {cwd})", async () => {
		const { pi, calls } = makeMockPi([{ code: 0, stdout: "Everything up-to-date" }]);
		await pushBranch(pi as any, "/cwd", "origin", "my-branch");
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].cmd, "git");
		assert.deepStrictEqual(calls[0].args, ["push", "origin", "my-branch"]);
		assert.deepStrictEqual(calls[0].opts, { cwd: "/cwd" });
	});

	it("throws on push failure (auth fail, rejected, no remote)", async () => {
		const { pi } = makeMockPi([{ code: 128, stderr: "fatal: Authentication failed" }]);
		await assert.rejects(
			() => pushBranch(pi as any, "/cwd", "origin", "branch"),
			/git push failed/i,
		);
	});
});

// ---------------------------------------------------------------------------
// Tests — commitAndPush
// ---------------------------------------------------------------------------

describe("commitAndPush", () => {
	it("calls git add, commit, then push in sequence", async () => {
		const { pi, calls } = makeMockPi([
			{ code: 0, stdout: "" },
			{ code: 0, stdout: "1 file changed" },
			{ code: 0, stdout: "Everything up-to-date" },
		]);
		await commitAndPush(pi as any, "/cwd", "origin", "branch", "feat(#42): msg");
		assert.strictEqual(calls.length, 3);
		assert.strictEqual(calls[0].cmd, "git");
		assert.deepStrictEqual(calls[0].args, ["add", "-A"]);
		assert.strictEqual(calls[1].cmd, "git");
		assert.deepStrictEqual(calls[1].args, ["commit", "-m", "feat(#42): msg"]);
		assert.strictEqual(calls[2].cmd, "git");
		assert.deepStrictEqual(calls[2].args, ["push", "origin", "branch"]);
	});

	it("does not push if add fails (short-circuit)", async () => {
		const { pi, calls } = makeMockPi([{ code: 1, stderr: "permission denied" }]);
		await assert.rejects(
			() => commitAndPush(pi as any, "/cwd", "origin", "branch", "msg"),
			/git add failed/i,
		);
		assert.strictEqual(calls.length, 1); // only add, not commit/push
	});

	it("throws when 'nothing to commit' (no changes — prevents pipeline progression)", async () => {
		const { pi, calls } = makeMockPi([
			{ code: 0, stdout: "" },
			{ code: 1, stderr: "nothing to commit" },
		]);
		await assert.rejects(
			() => commitAndPush(pi as any, "/cwd", "origin", "branch", "msg"),
			/No changes to commit/,
		);
		assert.strictEqual(calls.length, 2); // add + commit, no push
	});
});

// ---------------------------------------------------------------------------
// Tests — createPullRequest
// ---------------------------------------------------------------------------

describe("createPullRequest", () => {
	it("calls gh pr create with correct args", async () => {
		const { pi, calls } = makeMockPi([
			{ code: 0, stdout: "https://github.com/owner/repo/pull/123" },
		]);
		const result = await createPullRequest(
			pi as any,
			"owner/repo",
			"main",
			"branch",
			"feat(#42): title",
		);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].cmd, "gh");
		assert.deepStrictEqual(calls[0].args, [
			"pr",
			"create",
			"--repo",
			"owner/repo",
			"--base",
			"main",
			"--head",
			"branch",
			"--title",
			"feat(#42): title",
		]);
		assert.deepStrictEqual(result, { number: 123 });
	});

	it("includes --body-file flag when bodyFile provided", async () => {
		const { pi, calls } = makeMockPi([
			{ code: 0, stdout: "https://github.com/owner/repo/pull/456" },
		]);
		await createPullRequest(pi as any, "owner/repo", "main", "branch", "title", "/tmp/body.md");
		assert.strictEqual(calls.length, 1);
		const args = calls[0].args;
		assert.ok(args.includes("--body-file"), "Expected --body-file in args");
		const bfIdx = args.indexOf("--body-file");
		assert.strictEqual(args[bfIdx + 1], "/tmp/body.md");
	});

	it("parses PR number from URL output", async () => {
		const { pi } = makeMockPi([{ code: 0, stdout: "https://github.com/owner/repo/pull/789" }]);
		const result = await createPullRequest(pi as any, "owner/repo", "main", "branch", "title");
		assert.deepStrictEqual(result, { number: 789 });
	});

	it("parses PR number when gh outputs plain number", async () => {
		const { pi } = makeMockPi([{ code: 0, stdout: "123" }]);
		const result = await createPullRequest(pi as any, "owner/repo", "main", "branch", "title");
		assert.deepStrictEqual(result, { number: 123 });
	});

	it("throws when gh returns non-zero", async () => {
		const { pi } = makeMockPi([{ code: 1, stderr: "gh: Not authenticated" }]);
		await assert.rejects(
			() => createPullRequest(pi as any, "owner/repo", "main", "branch", "title"),
			/gh pr failed/i,
		);
	});

	it("throws when gh output does not contain a number", async () => {
		const { pi } = makeMockPi([{ code: 0, stdout: "" }]);
		await assert.rejects(
			() => createPullRequest(pi as any, "owner/repo", "main", "branch", "title"),
			/failed to parse PR number/i,
		);
	});
});
