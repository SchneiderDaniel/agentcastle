/**
 * Git helpers for context-info extension
 *
 * All I/O deferred to function calls, not module load.
 */

import { existsSync, readFileSync } from "node:fs";

/** Detect if we're in a git worktree and return its name */
export function getWorktreeName(cwd: string): string | null {
	try {
		const gitFile = `${cwd}/.git`;
		if (!existsSync(gitFile)) return null;
		const content = readFileSync(gitFile, "utf-8");
		const match = content.match(/^gitdir:\s*(.+)$/m);
		if (!match) return null; // regular repo, not a worktree
		const gitDir = match[1]!.trim();
		// Parse worktree name from path: .../.git/worktrees/<name>
		const wtMatch = gitDir.match(/worktrees\/(.+?)(\/|$)/);
		return wtMatch ? wtMatch[1]! : "worktree";
	} catch {
		return null;
	}
}
