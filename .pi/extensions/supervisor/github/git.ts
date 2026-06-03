// ─── Git Operations ──────────────────────────────────────────────
// commitChanges, pushBranch, commitAndPush.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDebugLogger } from "../config/debug.ts";

/** Commit staged changes in a working directory. */
export async function commitChanges(pi: ExtensionAPI, cwd: string, message: string): Promise<void> {
	const log = getDebugLogger();
	log.info("git", `git commit -m "${message.slice(0, 100)}"`, { cwd });
	const result = await pi.exec("git", ["commit", "-m", message], { cwd });
	if (result.code !== 0) {
		log.warn("git", "git commit failed", {
			cwd,
			stderr: (result.stderr || "").slice(0, 500),
			stdout: (result.stdout || "").slice(0, 500),
		});
		throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
	}
	log.info("git", "git commit OK", {
		stdout: (result.stdout || "").slice(0, 200),
	});
}

/** Push a branch to a remote. Retries with --force on non-fast-forward rejection. */
export async function pushBranch(
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
): Promise<void> {
	const log = getDebugLogger();
	log.info("git", `git push ${remote} ${branch}`, { cwd });
	const result = await pi.exec("git", ["push", remote, branch], { cwd });
	if (result.code === 0) {
		log.info("git", `git push OK — ${remote}/${branch}`);
		return;
	}

	const stderr = (result.stderr || "") + (result.stdout || "");
	// Non-fast-forward: old branch exists remotely from previous pipeline run.
	// Force-push since this branch is pipeline-owned (single-author, not shared).
	if (stderr.includes("non-fast-forward") || stderr.includes("fetch first")) {
		log.warn("git", "Non-fast-forward push — retrying with --force", {
			cwd,
			remote,
			branch,
			stderr: stderr.slice(0, 300),
		});
		const forceResult = await pi.exec("git", ["push", "--force", remote, branch], { cwd });
		if (forceResult.code === 0) {
			log.info("git", `git push --force OK — ${remote}/${branch}`);
			return;
		}
		const forceStderr = (forceResult.stderr || "") + (forceResult.stdout || "");
		log.error("git", "git push --force also failed", {
			cwd,
			stderr: forceStderr.slice(0, 500),
		});
		throw new Error(`git push --force failed: ${forceStderr}`);
	}

	log.warn("git", "git push failed", {
		cwd,
		remote,
		branch,
		stderr: stderr.slice(0, 500),
	});
	throw new Error(`git push failed: ${stderr}`);
}

/** Add all, commit, and push in sequence. */
export async function commitAndPush(
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
	message: string,
): Promise<void> {
	const log = getDebugLogger();
	log.info("git", `commitAndPush starting: ${branch}`, {
		cwd,
		remote,
		message: message.slice(0, 100),
	});

	const addResult = await pi.exec("git", ["add", "-A"], { cwd });
	if (addResult.code !== 0) {
		log.error("git", "git add -A failed", {
			cwd,
			stderr: (addResult.stderr || "").slice(0, 500),
		});
		throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
	}
	log.debug("git", "git add -A OK");

	const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd });
	if (commitResult.code !== 0) {
		const output = (commitResult.stderr || "") + (commitResult.stdout || "");
		if (output.includes("nothing to commit")) {
			log.info("git", "Nothing to commit — skipping");
			return;
		}
		log.warn("git", "git commit failed", {
			cwd,
			output: output.slice(0, 500),
		});
		throw new Error(`git commit failed: ${output.trim()}`);
	}
	log.info("git", "git commit OK");

	await pushBranch(pi, cwd, remote, branch);
	log.info("git", `commitAndPush complete: ${branch}`);
}
