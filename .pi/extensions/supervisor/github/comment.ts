// ─── Issue Comment Operations ─────────────────────────────────────
// postIssueComment, extractStructuredAuditOutput (now uses parseAgentOutput),
// extractAgentCommentBody, and filterIssueData.
//
// The old regex-based builders (buildAuditCommentFallback, etc.) have been
// removed. All audit comment construction now goes through parseAgentOutput.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FilteredIssueData, AgentOutput } from "../types.ts";
import { gh } from "./gh-client.ts";
import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "../agent-output.ts";

// ─── Post Issue Comment ───────────────────────────────────────────

export async function postIssueComment(
	pi: ExtensionAPI,
	issueNum: number,
	repo: string,
	body: string,
): Promise<void> {
	await gh(pi, ["issue", "comment", String(issueNum), "--repo", repo, "--body", body]);
}

// ─── Structured Audit Output ──────────────────────────────────────
// Uses parseAgentOutput as the primary method. Falls back to text marker
// detection only for backward compatibility during agent template transition.

export interface StructuredAuditOutput {
	decision: "APPROVED" | "REJECTED";
	prTitle?: string;
	prBody?: string;
	commentBody?: string;
}

/**
 * Extract structured audit output from agent output.
 * Primary path: parseAgentOutput for structured JSON.
 * Fallback: text marker regex detection (backward compat).
 */
export function extractStructuredAuditOutput(output: string): StructuredAuditOutput | null {
	// Primary: parseAgentOutput
	const parseResult = parseAgentOutput(output);
	if (isAgentOutputSuccess(parseResult)) {
		const agentOutput = parseResult as AgentOutput;
		if (agentOutput.action === "APPROVED" || agentOutput.action === "REJECTED") {
			const result: StructuredAuditOutput = {
				decision: agentOutput.action,
			};
			if (agentOutput.commentBody) result.commentBody = agentOutput.commentBody;
			if (agentOutput.prTitle) result.prTitle = agentOutput.prTitle;
			if (agentOutput.prBody) result.prBody = agentOutput.prBody;
			return result;
		}
	}

	// Fallback: text marker detection (backward compat)
	const decisionMatch = output.match(/AUDIT_DECISION\s*:\s*(APPROVED|REJECTED)/g);
	const standaloneApproved = output.match(/\bAUDIT_APPROVED\b/g);
	const standaloneRejected = output.match(/\bAUDIT_REJECTED\b/g);

	if (!decisionMatch && !standaloneApproved && !standaloneRejected) return null;

	let decision: "APPROVED" | "REJECTED";
	if (decisionMatch && decisionMatch.length > 0) {
		const lastDecision = decisionMatch[decisionMatch.length - 1];
		decision = lastDecision.includes("APPROVED") ? ("APPROVED" as const) : ("REJECTED" as const);
	} else if (standaloneApproved && standaloneApproved.length > 0) {
		const lastStandalone = standaloneApproved[standaloneApproved.length - 1];
		const approvedIdx = output.lastIndexOf(lastStandalone);
		const rejectedIdx = standaloneRejected
			? output.lastIndexOf(standaloneRejected[standaloneRejected.length - 1])
			: -1;
		decision = approvedIdx > rejectedIdx ? "APPROVED" : "REJECTED";
	} else {
		decision = "REJECTED";
	}

	const result: StructuredAuditOutput = { decision };

	const prTitleMatch = output.match(/PR_TITLE\s*:\s*(.+)$/gm);
	if (prTitleMatch) {
		result.prTitle = prTitleMatch[prTitleMatch.length - 1].replace(/^PR_TITLE\s*:\s*/i, "").trim();
	}

	const prBodyMatch = output.match(
		/PR_BODY\s*:[^\S\n]*([\s\S]*?)(?=\n(?:COMMENT_BODY|SUBMODULE_PR|PR_TITLE)\s*:|$)/,
	);
	if (prBodyMatch) {
		result.prBody = prBodyMatch[1].trim();
	}

	const commentBodyMatch = output.match(
		/COMMENT_BODY\s*:[^\S\n]*([\s\S]*?)(?=\n(?:SUBMODULE_PR|AUDIT_DECISION)\s*:|$)/,
	);
	if (commentBodyMatch) {
		result.commentBody = commentBodyMatch[1].trim();
	}

	return result;
}

// ─── Agent Comment Body Extraction ────────────────────────────────
// Tries parseAgentOutput first for structured commentBody,
// falls back to COMMENT_BODY marker extraction.

export function extractAgentCommentBody(output: string): string | null {
	// Primary: parseAgentOutput for structured JSON
	const parseResult = parseAgentOutput(output);
	if (isAgentOutputSuccess(parseResult)) {
		const agentOutput = parseResult as AgentOutput;
		if (agentOutput.commentBody) return agentOutput.commentBody;
	}

	// Fallback: COMMENT_BODY marker extraction
	const startMarker = /COMMENT_BODY\s*:\s*/g;
	const endMarker = /COMMENT_BODY_END/g;

	let lastBody: string | null = null;
	let match;
	while ((match = startMarker.exec(output)) !== null) {
		const start = match.index + match[0].length;
		const endIdx = output.indexOf("COMMENT_BODY_END", start);
		const body = endIdx !== -1 ? output.slice(start, endIdx) : output.slice(start);
		lastBody = body.trim();
	}

	return lastBody;
}

// ─── Filter Issue Data (Security) ─────────────────────────────────

export interface RawIssueData {
	author?: { login: string };
	body?: string;
	comments?: Array<{ author?: { login: string }; body?: string }>;
}

export function filterIssueData(rawIssue: RawIssueData, codeowners: string[]): FilteredIssueData {
	const issueAuthor: string = rawIssue?.author?.login || "";
	const isIssueAuthorTrusted = codeowners.includes(issueAuthor);

	const body = isIssueAuthorTrusted
		? rawIssue?.body || "(no body)"
		: `[Issue body hidden — author @${issueAuthor} is not a trusted codeowner]`;

	const rawComments = rawIssue?.comments || [];
	const trustedComments = rawComments
		.filter((c) => {
			const commentAuthor: string = c?.author?.login || "";
			return codeowners.includes(commentAuthor);
		})
		.map((c) => ({
			author: c?.author?.login || "unknown",
			body: c?.body || "",
		}));

	return { body, comments: trustedComments };
}
