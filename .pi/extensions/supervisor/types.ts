// ─── Supervisor Types ─────────────────────────────────────────────
// All interfaces, types, enums. Zero logic, no functions.

export interface SupervisorConfig {
	repo: string;
	projectNumber: number;
	statusField?: string;
	statusMapping: Record<string, string>;
	maxRejections?: number;
	codeowners: string[];
	submodules?: Array<{ path: string; repo: string }>;
	defaultBranch?: string;
	remote?: string;
	worktreeBase?: string;
	branchPrefix?: string;
	agentTimeoutsMin?: Record<string, number>;
}

export interface AgentFrontmatter {
	name: string;
	description?: string;
	tools?: string;
	model?: string;
	extensions?: string;
	thinking?: string;
	[key: string]: unknown;
}

export interface ParsedAgent {
	config: AgentFrontmatter;
	systemPrompt: string;
}

export interface ProjectField {
	id: string;
	name: string;
	type: string;
	options?: Array<{ id: string; name: string }>;
}

export interface ProjectItem {
	id: string;
	status?: string;
	content?: { url?: string; number?: number };
	fieldValues?: { fieldId: string; value: string; optionId?: string }[];
}

/** Filtered issue data after codeowner trust check */
export interface FilteredIssueData {
	/** Issue body (empty string if author not a trusted codeowner) */
	body: string;
	/** Only comments from trusted codeowners */
	comments: Array<{ author: string; body: string }>;
}

/** Structured result returned by runAgent for rendering */
export interface AgentRunResult {
	output: string;
	success: boolean;
	agentName: string;
	toolCount: number;
	tokenCount: number;
	durationMs: number;
	/** Clean text output from the agent (no tool/emoji noise) */
	textOutput: string;
	/** Brief summary line: what the agent accomplished */
	summaryLine: string;
	/** Raw stderr if any */
	errorOutput: string;
	/** Text-only output for marker detection (no tool/thinking noise) */
	textOnly: string;
	/** Thinking output from sub-agent (for expanded message renderer view) */
	thinkingOutput?: string;
}

// ─── AgentRunState: mutable state during agent execution ────────────

export type AgentPhase = "idle" | "thinking" | "tool" | "text";

export interface AgentRunState {
	currentTool?: string;
	currentToolArgs?: string;
	toolCount: number;
	tokenCount: number;
	fullLog: string[];
	liveThinking: string;
	liveText: string;
	textOutputLines: string[];
	thinkingOutputLines: string[];
	lastToolName?: string;
	phase: AgentPhase;
	startedAt: number;
	contextTokens?: number;
	contextWindow?: number;
	contextInfoReceived: boolean;
	/** Whether thinking was already pushed via streaming (dedup message_end) */
	thinkingPushedThisTurn: boolean;
	/** Whether text was already pushed via streaming (dedup message_end) */
	textPushedThisTurn: boolean;
}

// ─── Message renderer details type ───────────────────────────────────

export interface SupervisorMessageDetails {
	agentName: string;
	success: boolean;
	statusLabel: string;
	toolCount: number;
	tokenCount: number;
	durationMs: number;
	textOutput: string;
	summaryLine: string;
	/** Thinking output for expanded view */
	thinkingOutput?: string;
	/** Whether thinking output is available */
	hasThinking?: boolean;
	/** Complete raw stdout+stderr from agent session (untruncated) */
	rawOutput: string;
	/** Whether raw output is available */
	hasRawOutput?: boolean;
}

// ─── Dependency gate types ─────────────────────────────────────────

export interface BlockerInfo {
	number: number;
	title: string;
	type: "issue" | "pullrequest";
	state: string;
}

export interface DepsResult {
	blocked: boolean;
	blockers: BlockerInfo[];
}

export interface GhBlockingIssue {
	id: string;
	number: number;
	title: string;
	state: string;
}

export interface GhTimelineNode {
	__typename: string;
	blockingIssue?: GhBlockingIssue | null;
}

export interface GhTimelineResponse {
	data?: {
		repository?: {
			issue?: {
				timelineItems?: {
					nodes?: GhTimelineNode[];
				};
			};
		};
	};
	errors?: Array<{ message: string }>;
}

// ─── PR Conflict types ──────────────────────────────────────────────

export interface PrConflictInfo {
	number: number;
	hasConflict: boolean;
	mergeable: string;
	mergeStateStatus: string;
	headRefName: string;
	baseRefName: string;
}

// ─── Merge result ────────────────────────────────────────────────────

export interface MergeResult {
	success: boolean;
	conflictFiles: string[];
	message: string;
}

// ─── LSP Pre-Audit ──────────────────────────────────────────────────

export interface LspPreAuditDecision {
	/** New status to transition to — "Audit" if proceeding, "Implementation" if blocking */
	nextStatus: string;
	/** Note to include in notification */
	note: string;
	/** Whether LSP audit was actually triggered */
	auditTriggered: boolean;
}
