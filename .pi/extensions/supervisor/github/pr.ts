// ─── PR Operations ────────────────────────────────────────────────
// checkPrConflicts, createPullRequest.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrConflictInfo } from "../config/types.ts";
import { gh, ghJson } from "./gh-client.ts";
import { getDebugLogger } from "../config/debug.ts";

// ─── Check PR Conflicts ──────────────────────────────────────────

export async function checkPrConflicts(
	pi: ExtensionAPI,
	branch: string,
	repo: string,
): Promise<PrConflictInfo | null> {
	const log = getDebugLogger();
	log.info("pr", `Check PR conflicts: ${branch} on ${repo}`);
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
			log.info("pr", `No PR found for branch ${branch}`);
			return null;
		}
		const pr = result[0];
		const conflictInfo = {
			number: pr.number,
			hasConflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
			mergeable: pr.mergeable || "UNKNOWN",
			mergeStateStatus: pr.mergeStateStatus || "UNKNOWN",
			headRefName: pr.headRefName,
			baseRefName: pr.baseRefName,
		};
		log.info("pr", `PR #${pr.number} conflicts: ${conflictInfo.hasConflict}`, {
			mergeable: conflictInfo.mergeable,
			mergeStateStatus: conflictInfo.mergeStateStatus,
		});
		return conflictInfo;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("pr", `checkPrConflicts failed: ${msg}`);
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
	const log = getDebugLogger();
	const titlePreview = title.slice(0, 100);
	log.info("pr", `Creating PR: ${titlePreview}`, {
		repo,
		base,
		head,
		titleLen: title.length,
		hasBody: !!bodyFile,
	});
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
		log.debug("pr", `PR body from file: ${bodyFile}`);
	}

	// gh pr create returns PR URL (e.g. https://github.com/o/r/pull/123)
	// Parse via URL regex, with JSON parse fallback for backward compat
	const rawOutput = await gh(pi, args);

	// Optional: try JSON parse (backward compat with older code that passed --json)
	try {
		const parsed = JSON.parse(rawOutput);
		if (parsed !== null && typeof parsed === "object" && typeof parsed.number === "number") {
			const num = parsed.number;
			log.info("pr", `PR #${num} created (from JSON): ${head} → ${base}`);
			return { number: num };
		}
	} catch {
		// Not JSON — fall through to regex parsing
	}

	// Fallback: parse PR number from raw gh output (backward compat)
	const urlMatch = rawOutput.match(/pull\/(\d+)/);
	if (urlMatch) {
		const num = parseInt(urlMatch[1], 10);
		log.info("pr", `PR #${num} created (from URL): ${head} → ${base}`);
		return { number: num };
	}
	const numMatch = rawOutput.match(/(\d+)/);
	if (numMatch) {
		const num = parseInt(numMatch[1], 10);
		log.info("pr", `PR #${num} created (from number match)`);
		return { number: num };
	}

	log.error("pr", `Failed to parse PR number from: ${rawOutput.slice(0, 200)}`);
	throw new Error(`gh pr create failed to parse PR number from output: ${rawOutput}`);
}
