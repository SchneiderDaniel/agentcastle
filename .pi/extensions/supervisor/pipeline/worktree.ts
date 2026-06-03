// ─── Worktree Lifecycle ──────────────────────────────────────────
// Worktree create/cleanup/install-deps using pi.exec.
// Supervisor-owned: creates before agent dispatch, cleans up after pipeline.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import { getDebugLogger } from "../debug.ts";

// ─── Create Worktree ─────────────────────────────────────────────

export async function createWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBase: string,
	worktreeBranch: string,
	defaultBranch: string,
): Promise<string> {
	const log = getDebugLogger();
	const wt = resolvePath(cwd, worktreeBase, worktreeBranch);
	log.info("worktree", `Creating worktree: ${wt}`);
	log.info("worktree", `git worktree add -b ${worktreeBranch} ${wt} ${defaultBranch}`, {
		cwd,
		branch: worktreeBranch,
		base: defaultBranch,
	});
	try {
		const result = await pi.exec(
			"git",
			["worktree", "add", "-b", worktreeBranch, wt, defaultBranch],
			{ cwd, timeout: 15000 },
		);
		if (result.code !== 0) {
			log.warn("worktree", `git worktree add failed, trying without -b`, {
				stderr: (result.stderr || "").slice(0, 500),
			});
			throw new Error(result.stderr || result.stdout || "git worktree add failed");
		}
		log.info("worktree", `Worktree created at ${wt}`);
	} catch {
		// Branch or worktree may already exist — try add without -b
		log.debug("worktree", "Trying worktree add without -b (branch may exist)");
		try {
			const result = await pi.exec("git", ["worktree", "add", wt, worktreeBranch], {
				cwd,
				timeout: 15000,
			});
			if (result.code !== 0) {
				log.debug("worktree", "Worktree already exists — using existing");
			}
		} catch {
			log.debug("worktree", "Worktree already exists — using existing");
		}
	}
	log.info("worktree", `Worktree ready: ${wt}`);
	return wt;
}

// ─── Install Worktree Dependencies ───────────────────────────────

export async function installWorktreeDeps(pi: ExtensionAPI, worktreePath: string): Promise<void> {
	const log = getDebugLogger();
	log.info("worktree", `Installing deps at ${worktreePath}`);
	try {
		await pi.exec("npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
		log.info("worktree", "npm ci OK");
	} catch {
		log.warn("worktree", "npm ci failed — non-fatal");
	}
}

// ─── Cleanup Worktree ────────────────────────────────────────────

export async function cleanupWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	worktreeBranch: string,
): Promise<void> {
	const log = getDebugLogger();
	log.info("worktree", `Cleaning up worktree: ${worktreePath}, branch: ${worktreeBranch}`);
	try {
		await pi.exec("git", ["worktree", "remove", "--force", worktreePath], {
			cwd,
			timeout: 15000,
		});
		await pi.exec("git", ["worktree", "prune"], { cwd, timeout: 15000 });
		log.info("worktree", "Worktree removed");
	} catch {
		log.warn("worktree", `Failed to remove worktree at ${worktreePath}`);
		console.warn(`[supervisor] Failed to remove worktree at ${worktreePath}`);
	}
	try {
		await pi.exec("git", ["branch", "-D", worktreeBranch], { cwd, timeout: 10000 });
		log.info("worktree", `Branch ${worktreeBranch} deleted`);
	} catch {
		log.warn("worktree", `Failed to delete branch ${worktreeBranch}`);
		console.warn(`[supervisor] Failed to delete branch ${worktreeBranch}`);
	}
}
