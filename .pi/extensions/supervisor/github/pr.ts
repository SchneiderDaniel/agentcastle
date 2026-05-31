// ─── PR Operations ────────────────────────────────────────────────
// checkPrConflicts, createPullRequest.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrConflictInfo } from "../types.ts";
import { gh, ghJson } from "./gh-client.ts";

// ─── Check PR Conflicts ──────────────────────────────────────────

export async function checkPrConflicts(
	pi: ExtensionAPI,
	branch: string,
	repo: string,
): Promise<PrConflictInfo | null> {
	try {
		const result = await ghJson<
			Array<{
				number: number;
				mergeable: string;
				mergeStateStatus: string;
				headRefName: string;
				baseRefName: string;
			}>
		>(pi, [
			"pr",
			"list",
			"--repo",
			repo,
			"--head",
			branch,
			"--json",
			"number,mergeable,mergeStateStatus,headRefName,baseRefName",
		]);
		if (!result || !Array.isArray(result) || result.length === 0) {
			return null;
		}
		const pr = result[0];
		return {
			number: pr.number,
			hasConflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
			mergeable: pr.mergeable || "UNKNOWN",
			mergeStateStatus: pr.mergeStateStatus || "UNKNOWN",
			headRefName: pr.headRefName,
			baseRefName: pr.baseRefName,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[supervisor] checkPrConflicts failed: ${msg}`);
		throw err;
	}
}

// ─── Create Pull Request ──────────────────────────────────────────

export async function createPullRequest(
	pi: ExtensionAPI,
	repo: string,
	base: string,
	head: string,
	title: string,
	bodyFile?: string,
): Promise<{ number: number }> {
	const args: string[] = [
		"pr",
		"create",
		"--repo",
		repo,
		"--base",
		base,
		"--head",
		head,
		"--title",
		title,
	];
	if (bodyFile) {
		args.push("--body-file", bodyFile);
	}
	const result = await gh(pi, args);
	const urlMatch = result.match(/pull\/(\d+)/);
	if (urlMatch) {
		return { number: parseInt(urlMatch[1], 10) };
	}
	const numMatch = result.match(/(\d+)/);
	if (numMatch) {
		return { number: parseInt(numMatch[1], 10) };
	}
	throw new Error(`gh pr create failed to parse PR number from output: ${result}`);
}
