// ─── Formatting helpers ──────────────────────────────────────────────
// Pure formatting functions — no Pi API, no filesystem side effects.

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const sec = Math.round(ms / 1_000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remainSec = sec % 60;
	return `${min}m ${remainSec}s`;
}

export function getTermWidth(): number {
	return process.stdout.columns || 120;
}

export function boldText(theme: any, text: string): string {
	return theme.bold?.(text) ?? text;
}

export function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text" && b.text)
		.map((b: any) => b.text)
		.join("\n");
}

/** Pull a one-line summary from the agent's text output */
export function extractSummaryLine(
	textOutput: string,
	success: boolean,
	agentName: string,
): string {
	if (!textOutput) return success ? `${agentName} completed` : `${agentName} failed`;

	const markers = [
		"ARCHITECTURE_COMPLETE",
		"RESEARCH_COMPLETE",
		"TEST_PLAN_COMPLETE",
		"IMPLEMENTATION_COMPLETE",
		"AUDIT_APPROVED",
		"AUDIT_REJECTED",
	];
	let lastIdx = -1;
	let lastMarker = "";
	for (const marker of markers) {
		const idx = textOutput.lastIndexOf(marker);
		if (idx > lastIdx) {
			lastIdx = idx;
			lastMarker = marker;
		}
	}
	if (lastMarker) {
		return lastMarker
			.replace(/_/g, " ")
			.toLowerCase()
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	const firstLine = textOutput
		.split("\n")
		.find((l) => l.trim() && !l.startsWith("🔧") && !l.startsWith("📋") && !l.startsWith("💭"));
	if (firstLine) {
		return firstLine.trim().slice(0, 120);
	}
	return success ? `${agentName} completed` : `${agentName} failed`;
}

// ─── Subagent status line builder ──────────────────────────────────
// Builds the status string for ctx.ui.setStatus("supervisor", ...) with
// subagent prefix, model, and token count colored by context window %.
// Uses hex truecolor thresholds (borrowed from context-info styling).

const THRESHOLD_HEX_COLORS = [
	"#50fa7b",
	"#ff6d00",
	"#ff5252",
];

function thresholdHex(tokens: number, cw?: number): string | undefined {
	if (!cw || cw <= 0) return undefined;
	const pct = (tokens / cw) * 100;
	if (pct > 90) return THRESHOLD_HEX_COLORS[2];
	if (pct > 70) return THRESHOLD_HEX_COLORS[1];
	return THRESHOLD_HEX_COLORS[0];
}

export function fgHex(hex: string, text: string): string {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) return text;
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return text;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function buildSubagentStatusLine(
	agentName: string,
	startedAt: number,
	tokenCount: number,
	toolCount: number,
	contextInfoReceived: boolean,
	contextWindow: number | undefined,
	now: number,
	model?: string,
	theme?: { fg: (color: string, text: string) => string },
): string {
	const parts: string[] = [];
	const durationMs = now - startedAt;

	const shortModel = model ? model.split("/").pop() || model : undefined;
	if (shortModel) parts.push(`\ud83e\udde0 ${shortModel}`);

	parts.push(`\u23f1 ${formatDuration(durationMs)}`);

	if (tokenCount > 0) {
		let tokenStr = `${formatTokens(tokenCount)} tokens`;
		if (contextInfoReceived && contextWindow !== undefined && contextWindow > 0) {
			const hex = thresholdHex(tokenCount, contextWindow);
			if (hex) {
				tokenStr = fgHex(hex, formatTokens(tokenCount)) + ` tokens`;
			}
		} else if (theme) {
			tokenStr = `${theme.fg("dim", formatTokens(tokenCount))} tokens`;
		}
		parts.push(`\ud83d\udcca ${tokenStr}`);
	}

	if (toolCount > 0) parts.push(`\ud83d\udd27 ${toolCount} tools`);

	return `subagent: ${agentName}  ${parts.join(" \u00b7 ")}`;
}

// ─── Footer extension statuses joiner ──────────────────────────────
// Joins extension statuses with pipe separator for visual distinction.

export function joinExtensionStatuses(statuses: string[]): string {
	return statuses.join(" | ");
}

export function countRejections(comments: any[]): number {
	let count = 0;
	for (let i = comments.length - 1; i >= 0; i--) {
		const body = comments[i]?.body || "";
		if (body.includes("Audit Rejected") || body.includes("AUDIT_REJECTED")) {
			count++;
		} else if (
			body.includes("Audit Approved") ||
			body.includes("ARCHITECTURE") ||
			body.includes("Test Plan")
		) {
			break;
		}
	}
	return count;
}
