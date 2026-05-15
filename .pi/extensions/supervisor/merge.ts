// ─── Merge Conflict Resolution ──────────────────────────────────────
// Auto-merge logic for worktree branches.

import type { MergeResult } from "./types";
import { execFileSync } from "node:child_process";

export function tryAutoMerge(
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
	} catch (err: any) {
		const stderr = err.stderr?.toString() || err.message || "";

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
