// ─── Worktree Lifecycle ──────────────────────────────────────────
// Worktree create/cleanup/install-deps using pi.exec.
// Supervisor-owned: creates before agent dispatch, cleans up after pipeline.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";

// ─── Create Worktree ─────────────────────────────────────────────

export async function createWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreeBase: string,
	worktreeBranch: string,
	defaultBranch: string,
): Promise<string> {
	const wt = resolvePath(cwd, worktreeBase, worktreeBranch);
	try {
		const result = await pi.exec(
			"git",
			["worktree", "add", "-b", worktreeBranch, wt, defaultBranch],
			{ cwd, timeout: 15000 },
		);
		if (result.code !== 0) {
			throw new Error(result.stderr || result.stdout || "git worktree add failed");
		}
	} catch {
		// Branch or worktree may already exist — try add without -b
		try {
			const result = await pi.exec("git", ["worktree", "add", wt, worktreeBranch], {
				cwd,
				timeout: 15000,
			});
			if (result.code !== 0) {
				// Worktree already exists — idempotent, just use it
			}
		} catch {
			// Worktree already exists — idempotent
		}
	}
	return wt;
}

// ─── Install Worktree Dependencies ───────────────────────────────

export async function installWorktreeDeps(pi: ExtensionAPI, worktreePath: string): Promise<void> {
	try {
		await pi.exec("npm", ["ci"], { cwd: worktreePath, timeout: 120_000 });
	} catch {
		// npm ci failure is non-fatal — worktree still usable
	}
}

// ─── Cleanup Worktree ────────────────────────────────────────────

export async function cleanupWorktree(
	pi: ExtensionAPI,
	cwd: string,
	worktreePath: string,
	worktreeBranch: string,
): Promise<void> {
	try {
		await pi.exec("git", ["worktree", "remove", "--force", worktreePath], {
			cwd,
			timeout: 15000,
		});
		await pi.exec("git", ["worktree", "prune"], { cwd, timeout: 15000 });
	} catch {
		console.warn(`[supervisor] Failed to remove worktree at ${worktreePath}`);
	}
	try {
		await pi.exec("git", ["branch", "-D", worktreeBranch], { cwd, timeout: 10000 });
	} catch {
		console.warn(`[supervisor] Failed to delete branch ${worktreeBranch}`);
	}
}
