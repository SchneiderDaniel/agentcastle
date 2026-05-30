// ─── Issue Comment Operations ─────────────────────────────────────
// postIssueComment, extractStructuredAuditOutput, extractAgentCommentBody,
// buildAuditCommentFallback, filterIssueData.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FilteredIssueData } from "../types.ts";
import { gh } from "./gh-client.ts";

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

export interface StructuredAuditOutput {
	decision: "APPROVED" | "REJECTED";
	prTitle?: string;
	prBody?: string;
	commentBody?: string;
}

export function extractStructuredAuditOutput(output: string): StructuredAuditOutput | null {
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

	const prBodyMatch = output.match(/PR_BODY\s*:\s*([\s\S]*?)(?=\n[A-Z_]+\s*:|$)/);
	if (prBodyMatch) {
		result.prBody = prBodyMatch[1].trim();
	}

	const commentBodyMatch = output.match(/COMMENT_BODY\s*:\s*([\s\S]*?)(?=\n[A-Z_]+\s*:|$)/);
	if (commentBodyMatch) {
		result.commentBody = commentBodyMatch[1].trim();
	}

	return result;
}

// ─── Agent Comment Body Extraction ────────────────────────────────

export function extractAgentCommentBody(output: string): string | null {
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

// ─── Audit Comment Fallback Builder ──────────────────────────────

export function buildAuditCommentFallback(
	decision: "APPROVED" | "REJECTED",
	agentOutput: string,
): string | null {
	if (decision === "REJECTED") {
		return buildRejectionCommentFallback(agentOutput);
	}
	return buildApprovalCommentFallback(agentOutput);
}

function buildRejectionCommentFallback(output: string): string | null {
	const lines: string[] = ["## Audit Rejected", ""];
	let hasAny = false;

	const findingPattern = /\*\*(🔴|🟡)\s*(Critical|Warning)\s*[—–-]\s*(.+?):\s*(.+?)\s*\*\*/g;
	let match: RegExpExecArray | null;
	const headerPositions: Array<{
		index: number;
		severity: string;
		label: string;
		dimTitle: string;
	}> = [];

	while ((match = findingPattern.exec(output)) !== null) {
		headerPositions.push({
			index: match.index,
			severity: match[1],
			label: match[2],
			dimTitle: `${match[3].trim()}: ${match[4].trim()}`,
		});
	}

	if (headerPositions.length === 0) {
		const hasRejectedHeader = /##\s*Audit\s*Rejected/i.test(output);
		const hasCritical = /\bCritical\b/i.test(output);
		const hasWarning = /\bWarning\b/i.test(output);
		if (hasRejectedHeader || hasCritical || hasWarning) {
			const rawLines = output.split("\n");
			let inCodeBlock = false;
			for (const l of rawLines) {
				const trimmed = l.trim();
				if (trimmed.startsWith("```")) {
					inCodeBlock = !inCodeBlock;
					continue;
				}
				if (inCodeBlock) continue;
				if (/^gh\s/.test(trimmed)) continue;
				if (/^(SUMMARY_FILE|AUDIT_|COMMENT_BODY|PR_TITLE|PR_BODY)/.test(trimmed)) continue;
				if (/^(cat|if|fi|else|then)/.test(trimmed)) continue;
				if (trimmed === "" || trimmed === "\n") continue;
				if (lines.length === 1) {
					lines.push(
						"**Note:** Structured findings could not be parsed. Raw review excerpt below.",
						"",
					);
				}
				if (
					trimmed.startsWith("**🔴") ||
					trimmed.startsWith("**🟡") ||
					trimmed.startsWith("-") ||
					trimmed.startsWith("Symptom:") ||
					trimmed.startsWith("Consequence:") ||
					trimmed.startsWith("Remedy:") ||
					trimmed.startsWith("Location:") ||
					trimmed.startsWith("###") ||
					trimmed.startsWith("##") ||
					/^\d+\.\s/.test(trimmed)
				) {
					lines.push(trimmed);
					hasAny = true;
				}
			}
		}
	} else {
		hasAny = true;
		lines.push("### Critical");
		lines.push("");
		let criticalCount = 0;
		let hasWarnings = false;

		for (let i = 0; i < headerPositions.length; i++) {
			const h = headerPositions[i];
			const nextIdx = i + 1 < headerPositions.length ? headerPositions[i + 1].index : output.length;
			const block = output.slice(h.index, nextIdx);

			const locMatch = block.match(/Location:\s*(`[^`]+`|[^\n]+)/i);
			const location = locMatch ? locMatch[1].trim() : "";

			const symMatch = block.match(
				/Symptom:\s*(.+?)(?=\n\s*-\s*(?:Consequence|Symptom)\s*:|\n\s*(?:Consequence|Symptom)\s*:|$)/is,
			);
			const conMatch = block.match(
				/Consequence:\s*(.+?)(?=\n\s*-\s*(?:Remedy|Consequence)\s*:|\n\s*(?:Remedy|Consequence)\s*:|$)/is,
			);
			const remMatch = block.match(
				/Remedy:\s*(.+?)(?=\n\s*-\s*(?:Location|Remedy)\s*:|\n\s*(?:Location|Remedy)\s*:|$)/is,
			);

			const symptom = symMatch ? symMatch[1].trim().replace(/^\s*-\s*/, "") : "";
			const consequence = conMatch ? conMatch[1].trim().replace(/^\s*-\s*/, "") : "";
			const remedy = remMatch ? remMatch[1].trim().replace(/^\s*-\s*/, "") : "";

			const severity = h.severity === "🔴" ? "🔴" : "🟡";
			const isCritical = h.label === "Critical";

			if (!isCritical && !hasWarnings) {
				lines.push("");
				lines.push("### Warnings (3+ → rejection)");
				lines.push("");
				hasWarnings = true;
			}

			const num = isCritical ? ++criticalCount : i - criticalCount + 1;
			lines.push(`${num}. **${severity} ${h.label} — ${h.dimTitle}**`);
			if (symptom) lines.push(`   - Symptom: ${symptom}`);
			if (consequence) lines.push(`   - Consequence: ${consequence}`);
			if (remedy) lines.push(`   - Remedy: ${remedy}`);
			if (location) lines.push(`   - Location: ${location}`);
			lines.push("");
		}

		lines.push("Fix and resubmit.");
	}

	return hasAny ? lines.join("\n") : null;
}

function buildApprovalCommentFallback(output: string): string | null {
	const lines: string[] = ["## Audit Approved", ""];
	let hasAny = false;

	const scoreMatch = output.match(/AUDIT_SCORE\s*:\s*(\d+)\s*\/\s*(\d+)/);
	if (scoreMatch) {
		lines.push(
			`**Score:** ${scoreMatch[1]}/${scoreMatch[2]} — ${scoreMatch[1] === scoreMatch[2] ? "All dimensions passing" : `${scoreMatch[1]} of ${scoreMatch[2]} dimensions passing`}`,
		);
		lines.push("");
		hasAny = true;
	}

	const checklistPattern = /^-\s+(.+?):\s*(✅|✓|❌|✗)/gm;
	let clMatch: RegExpExecArray | null;
	while ((clMatch = checklistPattern.exec(output)) !== null) {
		const dimension = clMatch[1].trim();
		const status = clMatch[2] === "✅" || clMatch[2] === "✓" ? "✅" : "❌";
		if (!hasAny) {
			hasAny = true;
		}
		lines.push(`- ${dimension}: ${status}`);
	}

	if (!hasAny) return null;

	const summaryMatch = output.match(/###\s*Summary\n([\s\S]*?)(?=\n###|$)/i);
	if (summaryMatch) {
		const summary = summaryMatch[1].trim();
		if (summary) {
			lines.push("");
			lines.push("### Summary");
			lines.push(summary);
			hasAny = true;
		}
	}

	return lines.join("\n");
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
