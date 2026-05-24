// ─── Merge Conflict Resolution ──────────────────────────────────────
// Auto-merge logic for worktree branches.

import type { MergeResult } from "./types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function tryAutoMerge(
	worktreePath: string,
	branch: string,
	defaultBranch: string,
	remote: string,
	pi: ExtensionAPI,
): Promise<MergeResult> {
	try {
		const fetchResult = await pi.exec("git", ["fetch", remote, defaultBranch], {
			cwd: worktreePath,
			timeout: 60_000,
		});
		if (fetchResult.code !== 0) {
			const msg = (fetchResult.stderr || fetchResult.stdout || "").slice(0, 300);
			return { success: false, conflictFiles: [], message: `git fetch failed: ${msg}` };
		}

		const mergeResult = await pi.exec("git", ["merge", `${remote}/${defaultBranch}`, "--no-edit"], {
			cwd: worktreePath,
			timeout: 60_000,
		});
		if (mergeResult.code === 0) {
			return { success: true, conflictFiles: [], message: "Merge succeeded with no conflicts." };
		}

		// Merge failed — check for conflicts
		const diffResult = await pi.exec("git", ["diff", "--name-only", "--diff-filter=U"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		const conflictFiles: string[] = diffResult.stdout
			? diffResult.stdout.trim().split("\n").filter(Boolean)
			: [];

		if (conflictFiles.length > 0) {
			await pi
				.exec("git", ["merge", "--abort"], {
					cwd: worktreePath,
					timeout: 10_000,
				})
				.catch(() => {});
			return {
				success: false,
				conflictFiles,
				message: `Merge conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
			};
		}

		const msg = (mergeResult.stderr || mergeResult.stdout || "").slice(0, 300);
		return { success: false, conflictFiles: [], message: `Merge failed: ${msg}` };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, conflictFiles: [], message: `Merge failed: ${msg}` };
	}
}
