// ─── PR Creation ─────────────────────────────────────────────────
// PR creation logic: decoupled from handler, triggered on auditor approval.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SupervisorConfig, PipelineAgentResult } from "../types.ts";
import { writeFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { generateBranchName } from "../agent-task.ts";
import { createPullRequest } from "../github/pr.ts";
import { buildPipelineSummary } from "../pipeline-output.ts";
import { getDebugLogger } from "../debug.ts";

/**
 * Create a pull request after auditor approves and transitions to Done.
 * Checks ahead commits first, pushes branch, builds body, creates PR.
 */
export async function createPrOnApproval(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	issueNum: number,
	issueTitle: string,
	config: SupervisorConfig,
	agentResults: PipelineAgentResult[],
	worktreePath: string | undefined,
	worktreeBranch: string | undefined,
): Promise<void> {
	const log = getDebugLogger();
	const headBranch =
		worktreeBranch ?? generateBranchName(issueNum, issueTitle, config.branchPrefix!);

	log.info("pr-creation", `Checking ahead commits for ${headBranch}`, {
		worktreePath,
		defaultBranch: config.defaultBranch,
	});

	// Check branch has commits ahead of base before creating PR
	let aheadCommits = 0;
	try {
		const aheadResult = await pi.exec(
			"git",
			["rev-list", "--count", `${config.defaultBranch!}..${headBranch}`],
			{ cwd: ctx.cwd, timeout: 5000 },
		);
		const ahead = (aheadResult.stdout || "").trim();
		aheadCommits = parseInt(ahead, 10) || 0;
		log.debug("pr-creation", `Ahead by ${aheadCommits} commits`);
	} catch {
		log.warn("pr-creation", `git rev-list failed — branch ${headBranch} may not exist locally`);
	}

	if (aheadCommits === 0) {
		log.info("pr-creation", `No new commits — skipping PR creation for ${headBranch}`);
		ctx.ui.notify(
			`No new commits on ${headBranch} — skipping PR creation (already up to date with ${config.defaultBranch!})`,
			"info",
		);
		return;
	}

	const prBody = buildPipelineSummary(agentResults, "success", issueNum, issueTitle, config);
	const tempFile = joinPath(tmpdir(), `pr-body-${issueNum}.md`);
	log.info("pr-creation", `Writing PR body to ${tempFile}`);
	try {
		await writeFile(tempFile, prBody, "utf-8");
		const prTitle = `feat(#${issueNum}): ${issueTitle}`;
		log.info("pr-creation", `PR title: ${prTitle}`);

		// Push branch before creating PR so remote ref exists
		if (worktreePath) {
			log.info("pr-creation", `Pushing ${headBranch} from worktree`);
			try {
				await pi.exec("git", ["push", config.remote!, headBranch], {
					cwd: worktreePath,
					timeout: 15000,
				});
				log.info("pr-creation", "Push OK");
			} catch {
				log.warn("pr-creation", "Push failed — branch may already exist on remote");
			}
		}

		const prResult = await createPullRequest(
			pi,
			config.repo,
			config.defaultBranch!,
			headBranch,
			prTitle,
			tempFile,
		);
		log.info("pr-creation", `PR #${prResult.number} created`);
		ctx.ui.notify(`PR #${prResult.number} created`, "info");
	} catch (prErr: unknown) {
		const prMsg = prErr instanceof Error ? prErr.message : String(prErr);
		log.error("pr-creation", `Failed to create PR: ${prMsg}`);
		ctx.ui.notify(`Failed to create PR: ${prMsg}`, "warning");
		console.warn(`[supervisor] createPullRequest failed: ${prMsg}`);
	}
}
