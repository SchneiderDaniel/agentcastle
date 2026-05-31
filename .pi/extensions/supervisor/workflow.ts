// ─── Workflow Config ──────────────────────────────────────────────
// Config-driven pipeline: define transitions as data, not code.

import { parseAgentOutput, isSuccess as isAgentOutputSuccess } from "./agent-output.ts";
import type { AgentOutput, ParseResult } from "./types.ts";

export interface WorkflowStep {
	/** Board status column name (must match config.statusMapping keys) */
	status: string;
	/** Agent .md name (omitted for built-in statuses like Backlog/Done) */
	agentName?: string;
	/** Map of output marker substrings → next status */
	markerMap?: Record<string, string>;
	/** Statuses this step can send back to (feedback loop) */
	canLoopBackTo?: string[];
	/** Hooks to run before transition */
	hooks?: ("tsc" | "lsp" | "ci")[];
	/** Max rejections before forcing human intervention */
	maxRejections?: number;
	/** Built-in handler */
	builtIn?: "backlog" | "done";
}

export const WORKFLOW: WorkflowStep[] = [
	// Built-in: Backlog → Architecture
	{ status: "Backlog", builtIn: "backlog" },

	// Architecture → Research (linear forward)
	{
		status: "Architecture",
		agentName: "architect",
		markerMap: { ARCHITECTURE_COMPLETE: "Research" },
	},

	// Research → TestDesign (or loop back to Architecture)
	{
		status: "Research",
		agentName: "researcher",
		markerMap: {
			RESEARCH_COMPLETE: "TestDesign",
			FEEDBACK_ARCHITECTURE: "Architecture",
		},
		canLoopBackTo: ["Architecture"],
	},

	// TestDesign → Implementation
	{
		status: "TestDesign",
		agentName: "test-designer",
		markerMap: { TEST_PLAN_COMPLETE: "Implementation" },
	},

	// Implementation → Audit (with CI + TSC + LSP hooks)
	{
		status: "Implementation",
		agentName: "developer",
		markerMap: { IMPLEMENTATION_COMPLETE: "Audit" },
		hooks: ["ci", "tsc", "lsp"],
	},

	// Audit → Done (approve) or Implementation (reject/loop back)
	// Uses both AUDIT_DECISION (structured output) and standalone
	// AUDIT_APPROVED/AUDIT_REJECTED markers for backward compatibility.
	// AUDIT_DECISION is the canonical marker; standalone markers kept
	// for agents not yet updated to use structured output.
	{
		status: "Audit",
		agentName: "auditor",
		markerMap: {
			"AUDIT_DECISION: APPROVED": "Done",
			"AUDIT_DECISION: REJECTED": "Implementation",
			AUDIT_APPROVED: "Done",
			AUDIT_REJECTED: "Implementation",
		},
		canLoopBackTo: ["Implementation"],
		maxRejections: 5,
	},

	// Built-in: Done → stop
	{ status: "Done", builtIn: "done" },
];

/**
 * Find the LATEST matching marker in agent output.
 * Last occurrence wins — enables feedback markers to override forward markers.
 * Kept for backward compatibility during transition.
 */
export function resolveNextStatus(step: WorkflowStep, agentOutput: string): string | null {
	if (!step.markerMap) return null;

	let bestStatus: string | null = null;
	let bestIdx = -1;
	for (const [marker, nextStatus] of Object.entries(step.markerMap)) {
		const idx = agentOutput.lastIndexOf(marker);
		if (idx > bestIdx) {
			bestIdx = idx;
			bestStatus = nextStatus;
		}
	}
	return bestStatus;
}

/**
 * Resolve next status from parsed AgentOutput.
 * Uses deterministic JSON parsing instead of text marker lookups.
 * Falls back to marker-based resolution if AgentOutput can't be parsed.
 */
export function resolveNextStatusFromAgentOutput(
	step: WorkflowStep,
	agentOutputText: string,
): string | null {
	if (!step.markerMap) return null;

	// Try structured JSON parsing first
	const parseResult = parseAgentOutput(agentOutputText);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		const action = output.action;

		// Map action to appropriate marker key in the step's markerMap
		if (action === "APPROVED") {
			// Look for approval markers
			if (step.markerMap["AUDIT_DECISION: APPROVED"])
				return step.markerMap["AUDIT_DECISION: APPROVED"];
			if (step.markerMap["AUDIT_APPROVED"]) return step.markerMap["AUDIT_APPROVED"];
		}

		if (action === "REJECTED") {
			// Look for rejection markers
			if (step.markerMap["AUDIT_DECISION: REJECTED"])
				return step.markerMap["AUDIT_DECISION: REJECTED"];
			if (step.markerMap["AUDIT_REJECTED"]) return step.markerMap["AUDIT_REJECTED"];
		}

		if (action === "COMPLETE") {
			// Look for agent completion markers — skip audit markers
			const completionMarkers = Object.keys(step.markerMap).filter(
				(m) => !m.startsWith("AUDIT") && !m.startsWith("FEEDBACK"),
			);
			// Return the first forward status
			for (const marker of completionMarkers) {
				const status = step.markerMap[marker];
				if (status) return status;
			}
		}

		// If we still couldn't map, fall through to marker fallback
	}

	// Fallback: use old marker-based detection
	return resolveNextStatus(step, agentOutputText);
}

/**
 * Extract audit score from agent output.
 * First tries structured AgentOutput.auditScore, then falls back to
 * text marker `AUDIT_SCORE: N/M` pattern (last occurrence wins).
 * Returns null if no score is found.
 */
export interface AuditScore {
	passing: number;
	total: number;
}

export function extractAuditScore(agentOutput: string): AuditScore | null {
	// Try structured JSON parsing first
	const parseResult = parseAgentOutput(agentOutput);
	if (isAgentOutputSuccess(parseResult)) {
		const output = parseResult as AgentOutput;
		if (output.auditScore) {
			return {
				passing: output.auditScore.passing,
				total: output.auditScore.total,
			};
		}
	}

	// Fallback: text marker detection
	const regex = /AUDIT_SCORE:\s*(\d+)\s*\/\s*(\d+)/g;
	let match: RegExpExecArray | null;
	let lastMatch: RegExpExecArray | null = null;
	while ((match = regex.exec(agentOutput)) !== null) {
		lastMatch = match;
	}
	if (!lastMatch) return null;
	return {
		passing: parseInt(lastMatch[1], 10),
		total: parseInt(lastMatch[2], 10),
	};
}
