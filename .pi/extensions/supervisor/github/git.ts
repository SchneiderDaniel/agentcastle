// ─── Git Operations ──────────────────────────────────────────────
// commitChanges, pushBranch, commitAndPush.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Commit staged changes in a working directory. */
export async function commitChanges(pi: ExtensionAPI, cwd: string, message: string): Promise<void> {
	const result = await pi.exec("git", ["commit", "-m", message], { cwd });
	if (result.code !== 0) {
		throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
	}
}

/** Push a branch to a remote. */
export async function pushBranch(
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
): Promise<void> {
	const result = await pi.exec("git", ["push", remote, branch], { cwd });
	if (result.code !== 0) {
		throw new Error(`git push failed: ${result.stderr || result.stdout}`);
	}
}

/** Add all, commit, and push in sequence. */
export async function commitAndPush(
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
	message: string,
): Promise<void> {
	const addResult = await pi.exec("git", ["add", "-A"], { cwd });
	if (addResult.code !== 0) {
		throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
	}
	const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd });
	if (commitResult.code !== 0) {
		const output = (commitResult.stderr || "") + (commitResult.stdout || "");
		if (output.includes("nothing to commit")) {
			// No changes to commit — developer produced no output or all changes already committed.
			// This is not an error; pipeline should continue.
			return;
		}
		throw new Error(`git commit failed: ${output.trim()}`);
	}
	await pushBranch(pi, cwd, remote, branch);
}
