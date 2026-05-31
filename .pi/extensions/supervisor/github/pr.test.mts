// ─── Tests: github/pr.ts — PR conflict detection + creation ──────
// Tests for checkPrConflicts and createPullRequest.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkPrConflicts, createPullRequest } from "./pr.ts";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockPi(execResult: { code: number; stdout: string; stderr: string }): ExtensionAPI {
	return {
		exec: async () => execResult,
	} as unknown as ExtensionAPI;
}

// ─── Tests: checkPrConflicts() ────────────────────────────────────

describe("checkPrConflicts()", () => {
	it("returns PR info when PR exists and has no conflicts", async () => {
		const ghOutput = JSON.stringify([
			{
				number: 42,
				mergeable: "MERGEABLE",
				mergeStateStatus: "CLEAN",
				headRefName: "feature-branch",
				baseRefName: "main",
			},
		]);
		const pi = createMockPi({ code: 0, stdout: ghOutput, stderr: "" });
		const result = await checkPrConflicts(pi, "feature-branch", "owner/repo");
		assert.ok(result !== null);
		assert.equal(result.number, 42);
		assert.equal(result.hasConflict, false);
		assert.equal(result.mergeable, "MERGEABLE");
	});

	it("reports conflict when mergeable is CONFLICTING", async () => {
		const ghOutput = JSON.stringify([
			{
				number: 42,
				mergeable: "CONFLICTING",
				mergeStateStatus: "DIRTY",
				headRefName: "feature",
				baseRefName: "main",
			},
		]);
		const pi = createMockPi({ code: 0, stdout: ghOutput, stderr: "" });
		const result = await checkPrConflicts(pi, "feature", "owner/repo");
		assert.ok(result !== null);
		assert.equal(result.hasConflict, true);
	});

	it("returns null when no PR exists for branch", async () => {
		const pi = createMockPi({ code: 0, stdout: "[]", stderr: "" });
		const result = await checkPrConflicts(pi, "nonexistent-branch", "owner/repo");
		assert.equal(result, null);
	});

	it("throws on gh error (auth/network failure)", async () => {
		const pi = createMockPi({ code: 1, stdout: "", stderr: "network error" });
		await assert.rejects(
			() => checkPrConflicts(pi, "feature", "owner/repo"),
			/gh pr failed: network error/,
		);
	});
});

// ─── Tests: createPullRequest() ───────────────────────────────────

describe("createPullRequest()", () => {
	it("parses PR number from URL output", async () => {
		const pi = createMockPi({
			code: 0,
			stdout: "https://github.com/owner/repo/pull/123",
			stderr: "",
		});
		const result = await createPullRequest(pi, "owner/repo", "main", "feature", "PR title");
		assert.equal(result.number, 123);
	});

	it("parses PR number from numeric output", async () => {
		const pi = createMockPi({ code: 0, stdout: "42", stderr: "" });
		const result = await createPullRequest(pi, "owner/repo", "main", "feature", "PR title");
		assert.equal(result.number, 42);
	});

	it("throws when PR number cannot be parsed", async () => {
		const pi = createMockPi({ code: 0, stdout: "unexpected output", stderr: "" });
		await assert.rejects(
			() => createPullRequest(pi, "owner/repo", "main", "feature", "PR title"),
			/gh pr create failed to parse PR number/,
		);
	});

	it("uses body-file when provided", async () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		const pi = {
			exec: ((cmd: string, args: string[]) => {
				calls.push({ cmd, args });
				return Promise.resolve({ code: 0, stdout: "https://github.com/o/r/pull/1", stderr: "" });
			}) as ExtensionAPI["exec"],
		} as unknown as ExtensionAPI;
		await createPullRequest(pi, "owner/repo", "main", "feature", "PR title", "/tmp/body.md");
		const callArgs = calls[0].args;
		assert.ok(callArgs.includes("--body-file"));
		assert.ok(callArgs.includes("/tmp/body.md"));
	});
});
