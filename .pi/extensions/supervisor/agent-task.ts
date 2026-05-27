// ─── Agent Task Builder ────────────────────────────────────────────
// Builds task prompts per agent type. Generates branch names.
// Summary file protocol: auditor writes audit summary to temp file,
// then uses --body-file for both PR body and issue comment.

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
			return `${issueBlock}\n\n## Task\nAnalyze the issue body above and post an architecture comment describing the implementation approach.\n\nUse: gh issue comment ${issueNum} --repo ${repo} --body "...your architecture..."\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output ARCHITECTURE_COMPLETE on its own line.`;

		case "test-designer":
			return `${issueBlock}\n\n## Task\nReview the issue body and trusted comments above (architecture), then post a test plan comment.\n\nUse: gh issue comment ${issueNum} --repo ${repo} --body "...your test plan..."\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output TEST_PLAN_COMPLETE on its own line.`;

		case "developer": {
			const branch = generateBranchName(issueNum, title, branchPrefix);
			return `${issueBlock}\n\n## Task\nImplement the code changes. Worktree already set up — current directory is the worktree.\n\n### Setup\nWork from current directory — worktree already set up by supervisor. Branch already created.\n\n⚠️ **This may be a resume after previous failure.** The worktree and branch may already contain\n   partial work from a prior attempt. Always check existing state before starting fresh:\n\n1. Run \`git status\` — if files modified/staged, a previous attempt left work behind\n2. Run \`git log --oneline ${remote}/${defaultBranch}..HEAD\` — if commits exist but unpushed,\n   previous work is sitting on the branch\n3. Run \`git stash list\` — there may be stashed changes from a prior attempt\n\n**If existing work found:** resume from it. Read existing files, check what\'s done, complete what\nremains. Do NOT start over — that wastes time and may discard partial progress.\n\n**If no existing work (clean state):** proceed with fresh implementation.\n\n### Implementation\nFollow the **Test First** rule:\n\n**Step A — Write tests first:**\n- Read the test plan from the TestDesigner comment\n- Write tests that fail because the implementation doesn't exist yet\n- Run tests to confirm they fail (red)\n\n**Step B — Implement:**\n- Read relevant source files using \`read\`\n- Write the minimal code to make tests pass (green)\n- Keep changes focused\n- Edit files in BOTH main repo and any submodule\n\n**Step C — Verify:**\n- Run all tests — new ones AND existing ones\n- Confirm green across the board\n\n**Step D — Update README if needed**\n\n### Commit\n\`\`\`\ngit add -A\ngit commit -m "feat(#${issueNum}): ${title}"\ngit push ${remote} ${branch}\n\`\`\`\n\n**Branch name:** ${branch}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output IMPLEMENTATION_COMPLETE on its own line.`;
		}

		case "auditor": {
			const branch = generateBranchName(issueNum, title, branchPrefix);
			const summaryFile = `/tmp/audit-summary-${issueNum}.md`;

			// --- Write audit summary to temp file (shared by PR body + comment) ---
			const writeSummaryBlock =
				`**Step 1 — Write audit summary to temp file:**\n` +
				`Write the structured audit summary to a temp file, omitting empty sections. ` +
				`This file is used for both the PR body and the approval comment.\n\n` +
				"```\n" +
				`SUMMARY_FILE=${summaryFile}\n` +
				`cat > "$SUMMARY_FILE" << 'SUMMARYEOF'\n` +
				`## Audit Approved\n\n` +
				`### Summary\n` +
				`[1-2 sentences: what changed, why]\n\n` +
				`### How it works\n` +
				`[Brief approach. Code snippets only when they clarify. Keep short.]\n\n` +
				`### Key decisions\n` +
				`[Trade-offs, 1 sentence each. Omit section if none.]\n\n` +
				`### Review findings\n` +
				`[Non-blocking notes. Omit section if none.]\n\n` +
				`- Architecture compliance: ✓\n` +
				`- Ticket fulfillment: ✓\n` +
				`- Tests passed: ✓\n` +
				`- Test quality: ✓\n` +
				`- Correctness & Safety: ✓\n` +
				`- Code quality: ✓\n` +
				`- Completeness: ✓\n` +
				`SUMMARYEOF\n` +
				"```\n\n";

			// --- Build submodule PR creation instructions with --body-file ---
			let submodulePrSection = "";
			let submodulePrList = "";
			if (submodules.length > 0) {
				const subBlocks: string[] = [];
				const subListItems: string[] = [];
				for (const sub of submodules) {
					subBlocks.push(
						`cd ${sub.path}\n` +
							`CHANGES=$(git status --porcelain 2>/dev/null)\n` +
							`COMMITS=$(git rev-list --count ${remote}/${defaultBranch}..${branch} 2>/dev/null || echo 0)\n` +
							`if [ -n "$CHANGES" ] || [ "$COMMITS" != "0" ]; then\n` +
							`  if [ -z "$CHANGES" ]; then\n` +
							`    if [ -s "$SUMMARY_FILE" ]; then\n` +
							`      gh pr create --repo ${sub.repo} --base ${defaultBranch} --head ${branch} \\\n` +
							`        --title "feat(#${issueNum}): ${title}" \\\n` +
							`        --body-file "$SUMMARY_FILE"\n` +
							`    else\n` +
							`      gh pr create --repo ${sub.repo} --base ${defaultBranch} --head ${branch} \\\n` +
							`        --title "feat(#${issueNum}): ${title}" \\\n` +
							`        --body "Companion PR for ${repo}#${issueNum}"\n` +
							`    fi\n` +
							`  else\n` +
							`    git checkout -b ${branch} 2>/dev/null || git checkout ${branch}\n` +
							`    git add -A\n` +
							`    git commit -m "feat(#${issueNum}): ${title}"\n` +
							`    git push ${remote} ${branch}\n` +
							`    if [ -s "$SUMMARY_FILE" ]; then\n` +
							`      gh pr create --repo ${sub.repo} --base ${defaultBranch} --head ${branch} \\\n` +
							`        --title "feat(#${issueNum}): ${title}" \\\n` +
							`        --body-file "$SUMMARY_FILE"\n` +
							`    else\n` +
							`      gh pr create --repo ${sub.repo} --base ${defaultBranch} --head ${branch} \\\n` +
							`        --title "feat(#${issueNum}): ${title}" \\\n` +
							`        --body "Companion PR for ${repo}#${issueNum}"\n` +
							`    fi\n` +
							`  fi\n` +
							`fi\n` +
							`cd ${worktreeBase}`,
					);
					subListItems.push(`${sub.repo}: \`${branch}\``);
				}
				submodulePrSection =
					`**Step 2 — Create submodule PRs first (critical order):**\n` +
					`Check each submodule for changes. Only create a PR if there are actual changes (uncommitted files or unpushed commits):\n\n` +
					"```\n" +
					subBlocks.join("\n\n") +
					"\n```\n\n";
				submodulePrList = subListItems.map((s) => `- ${s}`).join("\n");
			}

			const stepLabel = submodules.length > 0 ? "Step 3 — " : "Step 2 — ";
			const fallbackComment =
				"## Audit Approved\n\n" +
				"The implementation has been reviewed and meets all requirements.\n\n" +
				"- Architecture compliance: ✓\n" +
				"- Test coverage: ✓\n" +
				"- Code quality: ✓\n" +
				"- Completeness: ✓";

			const prCreationBlock =
				`**${stepLabel}Create ${repo} PR and post approval comment:**\n` +
				"```\n" +
				`if [ -s "$SUMMARY_FILE" ]; then\n` +
				`  gh pr create --repo ${repo} --base ${defaultBranch} --head ${branch} \\\n` +
				`    --title "feat(#${issueNum}): ${title}" \\\n` +
				`    --body-file "$SUMMARY_FILE"\n` +
				`else\n` +
				`  gh pr create --repo ${repo} --base ${defaultBranch} --head ${branch} \\\n` +
				`    --title "feat(#${issueNum}): ${title}" \\\n` +
				`    --body "Closes #${issueNum}"\n` +
				`fi\n` +
				`\n` +
				`if [ -s "$SUMMARY_FILE" ]; then\n` +
				`  gh issue comment ${issueNum} --repo ${repo} --body-file "$SUMMARY_FILE"\n` +
				`else\n` +
				`  gh issue comment ${issueNum} --repo ${repo} --body "${fallbackComment}"\n` +
				`fi\n` +
				"```\n";

			return `${issueBlock}\n\n## Task\nReview the implementation in the developer's worktree and decide APPROVE or REJECT.\n\n### Steps\n1. Review the code: \`git diff ${defaultBranch}\` (shows all changes on this branch vs ${defaultBranch})\n2. Run tests if any exist\n3. Evaluate against the architecture and test plan from the trusted comments above.\n\n### Decision\n\n**IF APPROVE:**\n\n${writeSummaryBlock}${submodulePrSection}${prCreationBlock}Output AUDIT_APPROVED on its own line.\n\n**IF REJECT:**\n\`\`\`\ngh issue comment ${issueNum} --repo ${repo} --body "## Audit Rejected\n\n[list specific issues]"\n\`\`\`\nOutput AUDIT_REJECTED on its own line.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		case "researcher":
			return `${issueBlock}\n\n## Task\nResearch the issue topic against public web sources and post a structured findings comment.\n\n### Steps\n1. Scan the provided issue data above. If you see a comment containing \`## Research Findings\`, skip all research and output RESEARCH_COMPLETE on its own line immediately.\n2. Extract the core topic from the issue title, body, and architecture comment.\n3. Crawl 3-5 distinct public web pages using \`web_crawl <url> --maxPages 1\`\n4. Synthesize findings into a single comment using:\n   \`gh issue comment ${issueNum} --repo ${repo} --body "...your findings..."\`\n\n### Comment format\n\`\`\`\n## Research Findings\n\n### Best Practices\n- <finding> — <source link>\n\n### Recent Libraries\n- <library> <version> — <why relevant> — <source link>\n\n### Common Pitfalls\n- <pitfall> — <why it matters> — <source link>\n\`\`\`\n\nEvery bullet must include a source URL. Findings only — no recommendations, no architectural judgments. If all crawls fail, post: \`## Research Findings — No relevant results found for this topic.\`\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output RESEARCH_COMPLETE on its own line.`;

		default:
			return `${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
	}
}
