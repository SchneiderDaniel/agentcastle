// ─── Agent Task Builder ────────────────────────────────────────────
// Builds task prompts per agent type. Generates branch names.
// Structured output protocol: agents output JSON in a ```json code fence.
// Pipeline parses JSON deterministically via parseAgentOutput() — no text
// markers, no regex fallback. Agents never run gh/git commands themselves.

import type { FilteredIssueData } from "../config/types.ts";

// ─── Constants ─────────────────────────────────────────────────────

const MAX_COMMENT_CHARS = 2000;

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

// ─── JSON Output Template ────────────────────────────────────────
// All agents must output a JSON object as their final message.
// The pipeline parses this as the primary completion signal.
// Text markers (e.g., ARCHITECTURE_COMPLETE) are only used as fallback if JSON is unavailable.

const JSON_OUTPUT_INSTRUCTION = `
### Structured Output Format

Output your response as a JSON object in the following format (primary).
The pipeline parses this deterministically for status transitions, comments, and PRs.
If you absolutely cannot output JSON, fall back to the text completion marker mentioned in your system prompt.

\`\`\`json
{
  "action": "COMPLETE",
  "agentName": "<agent-name>",
  "summary": "<one-line summary of what was accomplished>",
  "commentBody": "<full comment body to post on GitHub issue (optional)>",
  "refusal": "<if you cannot complete the task, explain why here>"
}
\`\`\`

For the **auditor** agent, also include approval/rejection fields:

\`\`\`json
{
  "action": "APPROVED" | "REJECTED",
  "agentName": "auditor",
  "summary": "<one-line summary>",
  "commentBody": "<audit comment body>",
  "prTitle": "feat(#N): title (optional, for approval)",
  "prBody": "<PR description (optional, for approval)>",
  "auditScore": { "passing": N, "total": M },
  "findings": [
    {
      "severity": "critical" | "warning" | "suggestion",
      "dimension": "<dimension-name>",
      "symptom": "<what is the issue>",
      "consequence": "<why it matters>",
      "remedy": "<how to fix>",
      "location": "<file path or reference (optional)>"
    }
  ]
}
\`\`\`

Place the JSON in a \`\`\`json\`\`\` code fence or as the last JSON object in your response.
The pipeline extracts it automatically.
`;

/**
 * Truncate a comment body to `maxLength` chars with an overflow note.
 */
export function truncateComment(body: string, maxLength: number = MAX_COMMENT_CHARS): string {
	if (body.length <= maxLength) return body;
	const overflow = body.length - maxLength;
	return body.slice(0, maxLength) + `\n…[+${overflow} more chars]`;
}

/**
 * Summarize a list of trusted comments.
 * When > threshold comments: first n-1 are summarized into bullet list, latest is in full.
 * When ≤ threshold comments: renders all verbatim.
 * Comments > maxCommentChars are truncated with overflow note.
 *
 * @param threshold - Comment count threshold (default 7). Set to 0 to always summarize.
 * @param maxCommentChars - Max chars per comment body before truncation (default 2000).
 */
export function summarizeComments(
	comments: Array<{ author: string; body: string }>,
	threshold: number = 7,
	maxCommentChars: number = MAX_COMMENT_CHARS,
): string {
	if (comments.length === 0) return "(no trusted comments)";

	if (threshold > 0 && comments.length <= threshold) {
		// ≤ threshold comments: render all verbatim (threshold=0 = always summarize)
		return comments
			.map((c, i) => {
				const body = truncateComment(c.body, maxCommentChars);
				return `--- Comment #${i + 1} by @${c.author} ---\n${body}`;
			})
			.join("\n\n");
	}

	// > threshold comments: summarize all but the latest
	const latest = comments[comments.length - 1];
	const earlier = comments.slice(0, -1);

	// Build summarized bullet list for earlier comments
	const bullets = earlier
		.map((c) => {
			const preview = truncateComment(c.body, maxCommentChars);
			// Take first meaningful line for the summary
			const firstLine =
				preview.split("\n").find((l) => l.trim() && !l.startsWith("---")) || preview;
			return `- @${c.author}: ${firstLine.slice(0, 200)}`;
		})
		.join("\n");

	const summaryBlock = ["### Previous Comments (summarized)", bullets].join("\n");

	// Latest comment in full (also truncate if needed)
	const latestBody = truncateComment(latest.body, maxCommentChars);
	const latestBlock = `--- Comment #${comments.length} by @${latest.author} ---\n${latestBody}`;

	return `${summaryBlock}\n\n${latestBlock}`;
}

/**
 * Build audit dimensions checklist for the auditor prompt.
 */
function buildAuditChecklist(dimensionCount: number): string {
	let checklist = [
		"Architecture compliance: ✓",
		"Ticket fulfillment: ✓",
		"Tests passed: ✓",
		"Test quality: ✓",
		"Correctness & Safety: ✓",
		"Code quality: ✓",
		"Completeness: ✓",
		"Duplicate code: ← run jscpd or ripgrep_search to verify",
		"Research incorporation: ← verify researcher findings reflected in implementation, or deviation justified",
	];
	return checklist.join("\n");
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
	summarizedRejections?: string,
	duplicateCodeContext?: string | null,
): string {
	// Build trusted comments block
	// If summarizedRejections is provided, use it (pre-summarized by pipeline).
	// Otherwise, build from raw comments (backward compatible).
	let commentsBlock: string;
	if (summarizedRejections !== undefined) {
		commentsBlock = summarizedRejections;
	} else if (filteredData.comments.length > 0) {
		commentsBlock = filteredData.comments
			.map((c, i) => {
				const body = truncateComment(c.body);
				return `--- Comment #${i + 1} by @${c.author} ---\n${body}`;
			})
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
			return `${issueBlock}\n\n## Task\nAnalyze the issue body above and write an architecture comment describing the implementation approach.\n\nThe pipeline will post your commentBody as a GitHub issue comment automatically.\n\n${JSON_OUTPUT_INSTRUCTION}\n\nExample output:\n\n\`\`\`json\n{\n  \"action\": \"COMPLETE\",\n  \"agentName\": \"architect\",\n  \"summary\": \"Designed architecture for the feature\",\n  \"commentBody\": \"## Architecture\\n\\n[your architecture text here]\"\n}\n\`\`\`\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;

		case "test-designer":
			return `${issueBlock}\n\n## Task\nReview the issue body and trusted comments above (architecture), then write a test plan comment.\n\nThe pipeline will post your commentBody as a GitHub issue comment automatically.\n\n${JSON_OUTPUT_INSTRUCTION}\n\nExample output:\n\n\`\`\`json\n{\n  \"action\": \"COMPLETE\",\n  \"agentName\": \"test-designer\",\n  \"summary\": \"Wrote test plan\",\n  \"commentBody\": \"## Test Plan\\n\\n[your test plan text here]\"\n}\n\`\`\`\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;

		case "developer": {
			const branch = generateBranchName(issueNum, title, branchPrefix);
			// Use JS string concatenation to avoid backtick escape issues in template literals
			const developerExample = JSON.stringify(
				{
					action: "COMPLETE",
					agentName: "developer",
					summary: "Implemented the feature",
					commentBody: "## Implementation\n\n[optional implementation notes]",
				},
				null,
				2,
			);
			return `${issueBlock}\n\n## Task\nImplement the code changes. Worktree already set up — current directory is the worktree.\n\n### Setup\nWork from current directory — worktree already set up by supervisor. Branch already created.\n\n⚠️ **This may be a resume after previous failure.** The worktree and branch may already contain\n   partial work from a prior attempt. Always check existing state before starting fresh:\n\n1. Run \`git status\` — if files modified/staged, a previous attempt left work behind\n2. Run \`git log --oneline ${remote}/${defaultBranch}..HEAD\` — if commits exist but unpushed,\n   previous work is sitting on the branch\n3. Run \`git stash list\` — there may be stashed changes from a prior attempt\n\n**If existing work found:** resume from it. Read existing files, check what\'s done, complete what\nremains. Do NOT start over — that wastes time and may discard partial progress.\n\n**If no existing work (clean state):** proceed with fresh implementation.\n\n### Implementation\nFollow the **Test First** rule:\n\n⚠️ **The TDD gate enforces this deterministically.** After you commit and push, the pipeline will revert your\n   implementation files and run your tests. If tests pass without implementation (tautological tests) or no\n   tests exist, the pipeline returns to Implementation with the failure reason. The gate also verifies\n   that test files reference the new implementation code.\n\n**Step 0 — Evaluate research findings:**\n- Find the Research Findings comment in the issue comments above (look for \`## Research Findings\`)\n- If research exists, evaluate whether its recommendations (e.g. BM25F, field-weighted scoring) should influence the architecture\n- If research recommends a substantively better approach than the architecture, deviate — explain why in your summary\n- If research is absent or purely informational, proceed with the architecture as designed\n\n**Step A — Write tests first:**\n- Read the test plan from the TestDesigner comment\n- Write tests that fail because the implementation doesn't exist yet\n- Run tests to confirm they fail (red)\n\n**Step B — Implement:**\n- Read relevant source files using \`read\`\n- Write the minimal code to make tests pass (green)\n- Keep changes focused\n- Edit files in BOTH main repo and any submodule\n\n**Step C — Verify:**\n- Run all tests — new ones AND existing ones\n- Confirm green across the board\n\n**Step D — Update README if needed**\n\n### Commit and push\n\nThe pipeline will automatically stage, commit, and push your changes after you complete implementation. You do NOT need to run git commands yourself.\n\n**Branch name:** ${branch}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\n${JSON_OUTPUT_INSTRUCTION}\n\nExample output:\n\n\`\`\`json\n${developerExample}\n\`\`\``;
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

			// Pre-audit duplicate code context — injected when pipeline found duplicates
			const dupBlock = duplicateCodeContext
				? `\n### ⚠️ Duplicate Code Detected (Pre-Audit Gate)\nThe automated duplicate code check found potential clones involving your changed files.\nPlease verify these findings and include them in your audit if confirmed.\n\n${duplicateCodeContext}\n`
				: "";

			const checklist = buildAuditChecklist(8);

			return `${issueBlock}\n\n## Task\nReview the implementation in the developer's worktree and decide APPROVE or REJECT.\n${wtBlock}${dupBlock}\n### Steps\n1. Review the code: \`git diff ${defaultBranch}\` (shows all changes on this branch vs ${defaultBranch})\n2. Run jscpd (or fallback tools) to detect duplicate code introduced by changes\n3. Run tests if any exist\n4. Evaluate against the architecture and test plan from the trusted comments above.\n\n### Duplicate Code Detection\nCheck for code that already exists elsewhere in the codebase:\n- **jscpd** (if available): \`jscpd ${worktreePath || "."} --min-lines 5 --min-tokens 50 --output json\`\n- **Fallback — ripgrep_search**: Use \`ripgrep_search\` for exact literal matches of distinctive code blocks from the diff\n- **Fallback — structural_search**: Use \`structural_search\` for renamed/near-miss clones (AST patterns)\n- **Manual**: Read + diff for borderline cases\n\nReport findings under the \`duplicate-code\` dimension in your audit output.\n\n${JSON_OUTPUT_INSTRUCTION}\n\n**IF APPROVE:**\n\n\`\`\`json\n{\n  \"action\": \"APPROVED\",\n  \"agentName\": \"auditor\",\n  \"summary\": \"Approved implementation\",\n  \"commentBody\": \"## Audit Approved\\n\\n### Summary\\n[1-2 sentences: what changed, why]\\n\\n### Review Findings\\n[Non-blocking notes]\\n\\n### Checklist\\n${checklist.replace(/\n/g, "\\n")}\\n\\n### Audit Score\\nAUDIT_SCORE: <passing>/9\",\n  \"prTitle\": \"feat(#${issueNum}): ${title}\",\n  \"prBody\": \"## PR Description\\n\\n[details]\",\n  \"auditScore\": { \"passing\": 9, \"total\": 9 },\n  \"findings\": []\n}\n\`\`\`\n\n**IF REJECT:**\n\n\`\`\`json\n{\n  \"action\": \"REJECTED\",\n  \"agentName\": \"auditor\",\n  \"summary\": \"Rejected - issues found\",\n  \"commentBody\": \"## Audit Rejected\\n\\n[list specific issues with Symptom → Consequence → Remedy → Location]\",\n  \"findings\": [\n    {\n      \"severity\": \"critical\",\n      \"dimension\": \"code-quality\",\n      \"symptom\": \"<what is the issue>\",\n      \"consequence\": \"<why it matters>\",\n      \"remedy\": \"<how to fix>\",\n      \"location\": \"<file path>\"\n    }\n  ]\n}\n\`\`\`\n\nThe pipeline will:\n1. Create a PR in ${repo} with the prBody as description\n2. Post a GitHub issue comment with the commentBody\n\n**Submodules:**\n${submoduleList}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		case "researcher": {
			// Trimmed issue block for researcher — issue body + architecture comment only.
			// Full comments list is unnecessary (and costly) for web research.
			const archComment = filteredData.comments.find((c) => c.body.includes("## Architecture"));
			const researcherBlock = [
				`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
				`**Title:** ${title}`,
				`**Repository:** ${repo}`,
				``,
				`### Body`,
				filteredData.body,
			];
			if (archComment) {
				researcherBlock.push(``, `### Architecture Comment`, archComment.body);
			} else if (filteredData.comments.length > 0) {
				// No architecture comment yet — include first comment for minimal context
				researcherBlock.push(
					``,
					`### First Comment (trimmed — architecture comment not yet available)`,
					truncateComment(filteredData.comments[0].body),
				);
			}
			return `${researcherBlock.join("\n")}\n\n## Task\nResearch the issue topic against public web sources and write a structured findings comment.\n\n### Steps\n1. Scan the provided issue data above. If you see a comment containing \`## Research Findings\`, add "Already has research findings" to your summary and skip directly to the JSON output.\n2. Extract the core topic from the issue title, body, and architecture comment.\n3. Crawl 1-2 relevant public web pages using \`web_crawl <url> --maxPages 1\`. Hard limit: keep total crawled content under 75K tokens.\n4. Synthesize findings into a structured comment.\n\n${JSON_OUTPUT_INSTRUCTION}\n\nExample output:\n\n\`\`\`json\n{\n  \"action\": \"COMPLETE\",\n  \"agentName\": \"researcher\",\n  \"summary\": \"Researched topic and wrote findings\",\n  \"commentBody\": \"## Research Findings\\n\\n### Best Practices\\n- <finding> — <source link>\\n\\n### Recent Libraries\\n- <library> <version> — <why relevant> — <source link>\\n\\n### Common Pitfalls\\n- <pitfall> — <why it matters> — <source link>\"\n}\n\`\`\`\n\nEvery bullet must include a source URL. Findings only — no recommendations, no architectural judgments.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		default:
			return `${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
	}
}
