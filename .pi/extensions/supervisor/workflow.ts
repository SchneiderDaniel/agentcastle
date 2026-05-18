// ─── Workflow Config ──────────────────────────────────────────────
// Config-driven pipeline: define transitions as data, not code.

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
	hooks?: ("tsc" | "lsp")[];
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

	// Implementation → Audit (with TSC + LSP hooks)
	{
		status: "Implementation",
		agentName: "developer",
		markerMap: { IMPLEMENTATION_COMPLETE: "Audit" },
		hooks: ["tsc", "lsp"],
	},

	// Audit → Done (approve) or Implementation (reject)
	{
		status: "Audit",
		agentName: "auditor",
		markerMap: {
			AUDIT_APPROVED: "Done",
			AUDIT_REJECTED: "Implementation",
		},
		maxRejections: 5,
	},

	// Built-in: Done → stop
	{ status: "Done", builtIn: "done" },
];

/**
 * Find the LATEST matching marker in agent output.
 * Last occurrence wins — enables feedback markers to override forward markers.
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
