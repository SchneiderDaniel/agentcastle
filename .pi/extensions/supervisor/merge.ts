// ─── Merge Conflict Resolution ──────────────────────────────────────
// Auto-merge logic for worktree branches.

import type { MergeResult } from "./types";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";

export async function tryAutoMerge(
	worktreePath: string,
	branch: string,
	defaultBranch: string,
	remote: string,
	pi?: ExtensionAPI,
): Promise<MergeResult> {
	if (pi) {
		return tryAutoMergeWithPi(pi, worktreePath, branch, defaultBranch, remote);
	}
	return tryAutoMergeSync(worktreePath, branch, defaultBranch, remote);
}

async function tryAutoMergeWithPi(
	pi: ExtensionAPI,
	worktreePath: string,
	branch: string,
	defaultBranch: string,
	remote: string,
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

function tryAutoMergeSync(
	worktreePath: string,
	branch: string,
	defaultBranch: string,
	remote: string,
): MergeResult {
	const execOpts = { encoding: "utf-8" as const, timeout: 60_000 };

	try {
		execFileSync("git", ["fetch", remote, defaultBranch], {
			cwd: worktreePath,
			...execOpts,
		});
		execFileSync("git", ["merge", `${remote}/${defaultBranch}`, "--no-edit"], {
			cwd: worktreePath,
			...execOpts,
		});
		return {
			success: true,
			conflictFiles: [],
			message: "Merge succeeded with no conflicts.",
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const stderr =
			err instanceof Error && "stderr" in err && typeof (err as any).stderr?.toString === "function"
				? (err as any).stderr.toString()
				: msg;

		let conflictFiles: string[] = [];
		try {
			const status = execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
				cwd: worktreePath,
				encoding: "utf-8",
				timeout: 10_000,
			}).trim();
			if (status) {
				conflictFiles = status.split("\n").filter(Boolean);
			}
		} catch {
			// Couldn't get conflict list
		}

		if (conflictFiles.length > 0) {
			try {
				execFileSync("git", ["merge", "--abort"], {
					cwd: worktreePath,
					encoding: "utf-8",
					timeout: 10_000,
				});
			} catch {
				// best effort
			}
			return {
				success: false,
				conflictFiles,
				message: `Merge conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
			};
		}

		return {
			success: false,
			conflictFiles,
			message: `Merge failed: ${stderr.slice(0, 300)}`,
		};
	}
}
