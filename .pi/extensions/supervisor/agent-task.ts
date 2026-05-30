// ─── Agent Task Builder ────────────────────────────────────────────
// Builds task prompts per agent type. Generates branch names.
// Structured output protocol: agents output COMMENT_BODY/AUDIT_DECISION/PR_BODY
// markers instead of running gh/git commands themselves.
// Pipeline reads markers and executes git/gh operations deterministically.

import type { FilteredIssueData } from "./types";

export function generateBranchName(
	issueNum: number,
	title: string,
	prefix: string = "worktree-git-issue-",
): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 50);
	return `${prefix}${issueNum}-${slug}`;
}

export function buildAgentTask(
	agentName: string,
	issueNum: number,
	repo: string,
	title: string,
	filteredData: FilteredIssueData,
	submodules: Array<{ path: string; repo: string }>,
	defaultBranch: string,
	remote: string,
	worktreeBase: string,
	branchPrefix: string,
	worktreePath?: string,
	branchName?: string,
): string {
	// Build trusted comments block
	let commentsBlock: string;
	if (filteredData.comments.length > 0) {
		commentsBlock = filteredData.comments
			.map((c, i) => `--- Comment #${i + 1} by @${c.author} ---\n${c.body}`)
			.join("\n\n");
	} else {
		commentsBlock = "(no trusted comments)";
	}

	// Build the pre-filtered issue data block that agents must use
	const issueBlock = [
		`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
		`**Title:** ${title}`,
		`**Repository:** ${repo}`,
		``,
		`### Body`,
		filteredData.body,
		``,
		`### Trusted Comments`,
		commentsBlock,
	].join("\n");

	switch (agentName) {
		case "architect":
			return `${issueBlock}\n\n## Task\nAnalyze the issue body above and write an architecture comment describing the implementation approach.\n\nOutput your architecture comment body between these markers:\n\nCOMMENT_BODY:\n## Architecture\n\n[your architecture text here]\nCOMMENT_BODY_END\n\nThe pipeline will post this as a GitHub issue comment automatically.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output ARCHITECTURE_COMPLETE on its own line.`;

		case "test-designer":
			return `${issueBlock}\n\n## Task\nReview the issue body and trusted comments above (architecture), then write a test plan comment.\n\nOutput your test plan comment body between these markers:\n\nCOMMENT_BODY:\n## Test Plan\n\n[your test plan text here]\nCOMMENT_BODY_END\n\nThe pipeline will post this as a GitHub issue comment automatically.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output TEST_PLAN_COMPLETE on its own line.`;

		case "developer": {
			const branch = generateBranchName(issueNum, title, branchPrefix);
			return `${issueBlock}\n\n## Task\nImplement the code changes. Worktree already set up — current directory is the worktree.\n\n### Setup\nWork from current directory — worktree already set up by supervisor. Branch already created.\n\n⚠️ **This may be a resume after previous failure.** The worktree and branch may already contain\n   partial work from a prior attempt. Always check existing state before starting fresh:\n\n1. Run \`git status\` — if files modified/staged, a previous attempt left work behind\n2. Run \`git log --oneline ${remote}/${defaultBranch}..HEAD\` — if commits exist but unpushed,\n   previous work is sitting on the branch\n3. Run \`git stash list\` — there may be stashed changes from a prior attempt\n\n**If existing work found:** resume from it. Read existing files, check what\'s done, complete what\nremains. Do NOT start over — that wastes time and may discard partial progress.\n\n**If no existing work (clean state):** proceed with fresh implementation.\n\n### Implementation\nFollow the **Test First** rule:\n\n**Step A — Write tests first:**\n- Read the test plan from the TestDesigner comment\n- Write tests that fail because the implementation doesn't exist yet\n- Run tests to confirm they fail (red)\n\n**Step B — Implement:**\n- Read relevant source files using \`read\`\n- Write the minimal code to make tests pass (green)\n- Keep changes focused\n- Edit files in BOTH main repo and any submodule\n\n**Step C — Verify:**\n- Run all tests — new ones AND existing ones\n- Confirm green across the board\n\n**Step D — Update README if needed**\n\n### Commit and push\n\nThe pipeline will automatically stage, commit, and push your changes after you complete implementation. You do NOT need to run git commands yourself.\n\n**Branch name:** ${branch}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output IMPLEMENTATION_COMPLETE on its own line.`;
		}

		case "auditor": {
			const branch = generateBranchName(issueNum, title, branchPrefix);
			const submoduleList =
				submodules.length > 0
					? submodules.map((s) => `- ${s.repo} (path: \`${s.path}\`)`).join("\n")
					: "(none)";

			// Worktree path and branch name for cwd verification
			const wtBlock = worktreePath
				? `\n### Worktree Context\nYour current working directory IS the worktree at \`${worktreePath}\`.\nBefore any bash command, verify: \`pwd\` and \`git branch --show-current\`.\nWhen running shell commands, prepend: \`cd ${worktreePath} && <command>\`\nThe worktree branch is ${branchName || branch}.\n`
				: "";

			return `${issueBlock}\n\n## Task\nReview the implementation in the developer's worktree and decide APPROVE or REJECT.\n${wtBlock}\n### Steps\n1. Review the code: \`git diff ${defaultBranch}\` (shows all changes on this branch vs ${defaultBranch})\n2. Run tests if any exist\n3. Evaluate against the architecture and test plan from the trusted comments above.\n\n### Structured Output Format (Single Marker System)\n\nOutput your decision using the single marker system below. The pipeline reads these markers to handle PR creation and comment posting — do NOT run gh or git commands yourself.\n\n**IF APPROVE:**\n\n\`\`\`\nAUDIT_DECISION: APPROVED\nPR_TITLE: feat(#${issueNum}): ${title}\nPR_BODY:\n## Audit Approved\n\n### Summary\n[1-2 sentences: what changed, why]\n\n### How it works\n[Brief approach. Code snippets only when they clarify. Keep short.]\n\n### Key decisions\n[Trade-offs, 1 sentence each. Omit section if none.]\n\n### Review findings\n[Non-blocking notes. Omit section if none.]\n\n- Architecture compliance: ✓\n- Ticket fulfillment: ✓\n- Tests passed: ✓\n- Test quality: ✓\n- Correctness & Safety: ✓\n- Code quality: ✓\n- Completeness: ✓\n\n### Audit Score\nAUDIT_SCORE: <passing>/6\n\nCOMMENT_BODY:\n## Audit Approved\n\n### Summary\n[1-2 sentences: what changed, why]\n\n### Review Findings\n[Non-blocking notes from review findings above, or "None."]\n\n### Checklist\n- Architecture compliance: ✓\n- Ticket fulfillment: ✓\n- Tests passed: ✓\n- Test quality: ✓\n- Correctness & Safety: ✓\n- Code quality: ✓\n- Completeness: ✓\n\n### Audit Score\nAUDIT_SCORE: <passing>/6\n\`\`\`\n\nThe pipeline will:\n1. Create a PR in ${repo} with the PR_BODY as description\n2. Post a GitHub issue comment with the COMMENT_BODY (includes score + checklist)\n\n**Submodules:**\n${submoduleList}\n\nIf submodules have changes, also output:\n\`\`\`\nSUBMODULE_PR: ${submodules.length > 0 ? submodules.map((s) => `${s.repo}:feat(#${issueNum}): ${title}`).join("\\n") : "(none)"}\n\`\`\`\n\n**IF REJECT:**\n\n\`\`\`\nAUDIT_DECISION: REJECTED\nCOMMENT_BODY:\n## Audit Rejected\n\n[list specific issues with Symptom → Consequence → Remedy → Location]\n\`\`\`\n\nThe pipeline will post a GitHub issue comment with the rejection reason and move the issue back to Implementation.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output AUDIT_DECISION: APPROVED or AUDIT_DECISION: REJECTED on its own line (the sole marker for workflow status).`;
		}

		case "researcher":
			return `${issueBlock}\n\n## Task\nResearch the issue topic against public web sources and write a structured findings comment.\n\n### Steps\n1. Scan the provided issue data above. If you see a comment containing \`## Research Findings\`, skip all research and output RESEARCH_COMPLETE on its own line immediately.\n2. Extract the core topic from the issue title, body, and architecture comment.\n3. Crawl 3-5 distinct public web pages using \`web_crawl <url> --maxPages 1\`\n4. Synthesize findings into a structured comment using COMMENT_BODY markers:\n\n\`\`\`\nCOMMENT_BODY:\n## Research Findings\n\n### Best Practices\n- <finding> — <source link>\n\n### Recent Libraries\n- <library> <version> — <why relevant> — <source link>\n\n### Common Pitfalls\n- <pitfall> — <why it matters> — <source link>\nCOMMENT_BODY_END\n\`\`\`\n\nThe pipeline will post this as a GitHub issue comment automatically.\n\nEvery bullet must include a source URL. Findings only — no recommendations, no architectural judgments. If all crawls fail, output:\n\n\`\`\`\nCOMMENT_BODY:\n## Research Findings — No relevant results found for this topic.\nCOMMENT_BODY_END\n\`\`\`\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output RESEARCH_COMPLETE on its own line.`;

		default:
			return `${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
	}
}
