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

/**
 * Shared suffix for all agent tasks: system prompt delegation + output protocol + security rule.
 * All agents follow their system prompt (agent .md file) instead of duplicating workflow steps here.
 */
const TASK_SUFFIX = `
## Task
Follow your system prompt instructions.

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

**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;

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
	researchFindings?: string | null,
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

	// Build the research findings block (injected for architect from issue comments)
	const researchBlock = researchFindings ? `\n### Research Findings\n\n${researchFindings}\n` : "";

	const branch = generateBranchName(issueNum, title, branchPrefix);

	switch (agentName) {
		case "architect":
			// Architect gets issue data + research findings (if any), delegates to system prompt
			return `${issueBlock}${researchBlock}${TASK_SUFFIX}`;

		case "test-designer":
			// Test designer gets issue data, delegates to system prompt
			return `${issueBlock}${TASK_SUFFIX}`;

		case "developer":
			// Developer gets issue data + research findings + setup info, delegates to system prompt
			return `${issueBlock}${researchBlock}\n\n### Setup\nWork from current directory — worktree already set up by supervisor. Branch already created.\n\n**Branch name:** ${branch}\n${TASK_SUFFIX}`;

		case "auditor": {
			const submoduleList =
				submodules.length > 0
					? submodules.map((s) => `- ${s.repo} (path: \`${s.path}\`)`).join("\n")
					: "(none)";

			// Worktree path and branch name for cwd verification
			const wtBlock = worktreePath
				? `\n### Worktree Context\nYour current working directory IS the worktree at \`${worktreePath}\`.\nThe worktree branch is ${branchName || branch}.\n`
				: "";

			// Pre-audit duplicate code context — injected when pipeline found duplicates
			const dupBlock = duplicateCodeContext
				? `\n### ⚠️ Duplicate Code Detected (Pre-Audit Gate)\nThe automated duplicate code check found potential clones involving your changed files.\nPlease verify these findings and include them in your audit if confirmed.\n\n${duplicateCodeContext}\n`
				: "";

			return `${issueBlock}${wtBlock}${dupBlock}\n### Submodules\n${submoduleList}\n${TASK_SUFFIX}`;
		}

		case "researcher": {
			// Researcher gets issue body only (no trusted comments — runs before architect)
			const researcherBlock = [
				`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
				`**Title:** ${title}`,
				`**Repository:** ${repo}`,
				``,
				`### Body`,
				filteredData.body,
			];
			return `${researcherBlock.join("\n")}${TASK_SUFFIX}`;
		}

		default:
			return `${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
	}
}
