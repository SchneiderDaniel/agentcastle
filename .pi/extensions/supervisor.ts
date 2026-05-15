/**
 * supervisor — Kanban-driven agent orchestration for GitHub issues
 *
 * Registers `/supervisor <issue-number>` slash command.
 * Reads issue status from a GitHub project board and dispatches the
 * appropriate sub-agent (Architect, TestDesigner, Developer, Auditor).
 * Runs the full pipeline in a loop until Done or blocked.
 * Agents are defined as .pi/agents/*.md files with YAML frontmatter.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { Container, Spacer, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GhIssue, GhComment } from "./github-types.js";
import { isGhIssue } from "./github-types.js";
import { extractTextFromContent } from "./types.js";


// ─── Types ───────────────────────────────────────────────────────────

interface SupervisorConfig {
	repo: string;
	projectNumber: number;
	statusField?: string;
	statusMapping: Record<string, string>;
	maxRejections?: number;
	codeowners: string[];
	submodules?: Array<{path: string; repo: string}>;
	defaultBranch?: string;     // e.g. "main" (default: "main")
	remote?: string;            // e.g. "origin" (default: "origin")
	worktreeBase?: string;      // e.g. "../" (default: "../")
	branchPrefix?: string;      // e.g. "worktree-git-issue-" (default: "worktree-git-issue-")
	agentTimeoutsMin?: Record<string, number>; // per-agent timeout overrides in minutes
}

interface AgentFrontmatter {
	name: string;
	description?: string;
	tools?: string;
	model?: string;
	extensions?: string;
	[key: string]: unknown;
}

interface ParsedAgent {
	config: AgentFrontmatter;
	systemPrompt: string;
}

interface ProjectField {
	id: string;
	name: string;
	type: string;
	options?: Array<{ id: string; name: string }>;
}

interface ProjectItem {
	id: string;
	status?: string;
	content?: { url?: string; number?: number };
	fieldValues?: { fieldId: string; value: string; optionId?: string }[];
}

/** Filtered issue data after codeowner trust check */
interface FilteredIssueData {
	/** Issue body (empty string if author not a trusted codeowner) */
	body: string;
	/** Only comments from trusted codeowners */
	comments: Array<{ author: string; body: string }>;
	/** Whether filtering was applied (codeowners list was non-empty) */
	filteringActive: boolean;
}

/** Structured result returned by runAgent for rendering */
interface AgentRunResult {
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
}

// ─── Message renderer details type ───────────────────────────────────

interface SupervisorMessageDetails {
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
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse .gitmodules into submodule entries. Only returns entries with GitHub URLs. */
function parseGitmodules(): Array<{path: string; repo: string}> {
	const gitmodulesPath = ".gitmodules";
	if (!existsSync(gitmodulesPath)) return [];
	const content = readFileSync(gitmodulesPath, "utf-8");
	const subs: Array<{path: string; repo: string}> = [];
	const sectionRe = /\[submodule\s+"(.+?)"\]/g;
	let match: RegExpExecArray | null;
	while ((match = sectionRe.exec(content)) !== null) {
		const name = match[1];
		// Extract the section body between this [submodule] and the next one (or EOF)
		const sectionStart = match.index + match[0].length;
		const nextSection = content.indexOf("[", sectionStart);
		const sectionBody = nextSection === -1
			? content.slice(sectionStart)
			: content.slice(sectionStart, nextSection);
		const pathMatch = sectionBody.match(/^\s*path\s*=\s*(.+)$/m);
		const urlMatch = sectionBody.match(/^\s*url\s*=\s*(.+)$/m);
		if (!pathMatch || !urlMatch) continue;
		const path = pathMatch[1].trim();
		const url = urlMatch[1].trim();
		// Extract owner/repo from GitHub URLs: https://github.com/owner/repo or git@github.com:owner/repo.git
		const ghMatch = url.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/);
		if (!ghMatch) continue; // skip non-GitHub submodules (gh CLI can't create PRs there)
		const repo = `${ghMatch[1]}/${ghMatch[2]}`;
		subs.push({ path, repo });
	}
	return subs;
}

export function loadConfig(): SupervisorConfig {
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) {
		throw new Error("No .pi/settings.json found. Add a 'supervisor' key.");
	}
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	const cfg = settings.supervisor;
	if (!cfg) throw new Error("No 'supervisor' key in .pi/settings.json.");
	if (!cfg.repo) throw new Error("supervisor.repo is required.");
	if (!cfg.projectNumber)
		throw new Error("supervisor.projectNumber is required.");
	if (!cfg.statusMapping || Object.keys(cfg.statusMapping).length === 0) {
		throw new Error("supervisor.statusMapping is required.");
	}
	const codeowners: string[] = Array.isArray(cfg.codeowners) ? cfg.codeowners : [];
	if (codeowners.length === 0) {
		throw new Error("supervisor.codeowners must be a non-empty list of trusted GitHub usernames.");
	}
	// Submodules: explicit config takes precedence, otherwise auto-detect from .gitmodules
	let submodules: Array<{path: string; repo: string}>;
	if (Array.isArray(cfg.submodules) && cfg.submodules.length > 0) {
		submodules = cfg.submodules;
	} else {
		submodules = parseGitmodules();
	}
	// Validate per-agent timeouts against known agents from statusMapping
	const knownAgents = Object.values(cfg.statusMapping);
	const agentTimeoutsMin = validateAgentTimeouts(cfg.agentTimeoutsMin, knownAgents);
	return {
		repo: cfg.repo,
		projectNumber: cfg.projectNumber,
		statusField: cfg.statusField || "Status",
		statusMapping: cfg.statusMapping,
		maxRejections: cfg.maxRejections ?? 3,
		codeowners,
		submodules,
		defaultBranch: cfg.defaultBranch || "main",
		remote: cfg.remote || "origin",
		worktreeBase: cfg.worktreeBase || "../",
		branchPrefix: cfg.branchPrefix || "worktree-git-issue-",
		agentTimeoutsMin,
	};
}

// ─── Timeout configuration ────────────────────────────────────────────

/** Default agent timeout in milliseconds (30 minutes). */
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;

/**
 * Validate the raw agentTimeoutsMin config value.
 * Returns a sanitized Record<string, number>.
 * - undefined/null/empty → {}
 * - Positive integers only
 * - Unknown agent names: warn and strip
 * - Non-integer / non-positive → throw
 */
export function validateAgentTimeouts(
	raw: unknown,
	knownAgents: string[],
): Record<string, number> {
	// Handle undefined/null
	if (raw === undefined || raw === null) {
		return {};
	}

	// Must be an object
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		throw new Error(
			`agentTimeoutsMin must be an object, got ${typeof raw}`,
		);
	}

	const record = raw as Record<string, unknown>;
	const result: Record<string, number> = {};

	for (const [key, value] of Object.entries(record)) {
		// Check if agent name is known
		if (!knownAgents.includes(key)) {
			console.warn(
				`agentTimeoutsMin: unknown agent "${key}" — entry ignored`,
			);
			continue;
		}

		// Validate value: must be a positive integer
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			throw new Error(
				`agentTimeoutsMin.${key} must be a positive integer, got ${JSON.stringify(value)}`,
			);
		}

		result[key] = value;
	}

	return result;
}

/**
 * Resolve the timeout in milliseconds for a given agent.
 * - Looks up agentTimeoutsMin map by agent name (case-sensitive, exact match)
 * - Returns minutes * 60_000 if found
 * - Falls back to defaultMs if not found or map is empty/null
 */
export function resolveTimeoutMs(
	agentName: string,
	agentTimeoutsMin: Record<string, number> | undefined,
	defaultMs: number = DEFAULT_AGENT_TIMEOUT_MS,
): number {
	if (!agentTimeoutsMin || typeof agentTimeoutsMin !== "object") {
		return defaultMs;
	}

	const minutes = agentTimeoutsMin[agentName];
	if (
		minutes !== undefined &&
		typeof minutes === "number" &&
		Number.isInteger(minutes) &&
		minutes > 0
	) {
		return minutes * 60_000;
	}

	return defaultMs;
}

function parseAgentFile(filePath: string): ParsedAgent {
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		throw new Error(`Agent file ${filePath} missing YAML frontmatter`);
	}
	const config: AgentFrontmatter = { name: "" };
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
		if (kv) {
			let val = kv[2]!.trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			config[kv[1]!] = val;
		}
	}
	if (!config.name) throw new Error(`Agent file ${filePath} missing 'name'`);
	return { config, systemPrompt: match[2]!.trim() };
}

/** Filter issue body and comments to only trusted codeowners.
 *  This is enforced in code — NOT via LLM prompt — to prevent prompt injection.
 *  Uses type guards on unknown input to prevent malicious payload bypass. */
function filterIssueData(rawIssue: unknown, codeowners: string[]): FilteredIssueData {
	const issue = isGhIssue(rawIssue) ? rawIssue : null;
	const issueAuthor: string = issue?.author?.login || "";
	const isIssueAuthorTrusted = codeowners.includes(issueAuthor);

	const body = isIssueAuthorTrusted
		? (issue?.body || "(no body)")
		: `[Issue body hidden — author @${issueAuthor} is not a trusted codeowner]`;

	const rawComments: unknown[] = Array.isArray((rawIssue as Record<string, unknown>)?.comments)
		? (rawIssue as Record<string, unknown>).comments as unknown[]
		: [];
	const trustedComments = rawComments
		.filter((c: unknown): c is GhComment => {
			if (typeof c !== "object" || c === null) return false;
			const author = (c as Record<string, unknown>)?.author;
			if (typeof author !== "object" || author === null) return false;
			const login = (author as Record<string, unknown>)?.login;
			return typeof login === "string" && codeowners.includes(login);
		})
		.map((c: GhComment) => ({
			author: c.author?.login || "unknown",
			body: c.body || "",
		}));

	return { body, comments: trustedComments, filteringActive: true };
}

function gh(args: string[]): string {
	try {
		return execFileSync("gh", args, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
		}).trim();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`gh ${args[0]} failed: ${message}`);
	}
}

function ghJson(args: string[]): unknown {
	const output = gh(args);
	if (!output) return null;
	return JSON.parse(output);
}

function getProjectFields(
	projectNumber: number,
	owner: string,
): ProjectField[] {
	const result = ghJson([
		"project",
		"field-list",
		String(projectNumber),
		"--owner",
		owner,
		"--format",
		"json",
	]);
	return result?.fields || result || [];
}

function getProjectItems(projectNumber: number, owner: string): ProjectItem[] {
	const result = ghJson([
		"project",
		"item-list",
		String(projectNumber),
		"--owner",
		owner,
		"-L",
		"100",
		"--format",
		"json",
	]);
	return result?.items || result || [];
}

function findIssueItem(
	items: ProjectItem[],
	issueNumber: number,
): ProjectItem | null {
	for (const item of items) {
		if (item.content?.number === issueNumber) return item;
		const url = item.content?.url || "";
		if (
			url.includes(`/issues/${issueNumber}`) ||
			url.includes(`/pull/${issueNumber}`)
		)
			return item;
	}
	return null;
}

function getItemStatusName(item: ProjectItem): string {
	return item.status || "Unknown";
}

function findStatusOption(
	fields: ProjectField[],
	statusFieldId: string,
	statusName: string,
): string | null {
	const field = fields.find((f) => f.id === statusFieldId);
	if (!field?.options) return null;
	const option = field.options.find(
		(o) => o.name.toLowerCase() === statusName.toLowerCase(),
	);
	return option?.id || null;
}

function setItemStatus(
	itemId: string,
	projectId: string,
	fieldId: string,
	optionId: string,
): void {
	gh([
		"project",
		"item-edit",
		"--id",
		itemId,
		"--project-id",
		projectId,
		"--field-id",
		fieldId,
		"--single-select-option-id",
		optionId,
	]);
}

function getProjectId(projectNumber: number, owner: string): string {
	const result = ghJson([
		"project",
		"view",
		String(projectNumber),
		"--owner",
		owner,
		"--format",
		"json",
	]);
	return result?.id || "";
}

// ─── Dependency gate ("blocked by" links) ─────────────────────────

interface BlockerInfo {
	number: number;
	title: string;
	type: "issue" | "pullrequest";
	state: string;
}

interface DepsResult {
	blocked: boolean;
	blockers: BlockerInfo[];
}

interface GhBlockingIssue {
	id: string;
	number: number;
	title: string;
	state: string;
}

interface GhTimelineNode {
	__typename: string;
	blockingIssue?: GhBlockingIssue | null;
}

interface GhTimelineResponse {
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

function ghGraphQL(query: string): unknown {
	const result = gh([
		"api",
		"graphql",
		"--header",
		"Accept: application/vnd.github+json",
		"-f",
		`query=${query}`,
	]);
	if (!result) return null;
	return JSON.parse(result);
}

function parseTimelineResponse(
	response: GhTimelineResponse | null,
): DepsResult {
	if (response?.errors && response.errors.length > 0) {
		const msgs = response.errors.map((e) => e.message).join("; ");
		throw new Error(`GitHub GraphQL error: ${msgs}`);
	}

	const nodes = response?.data?.repository?.issue?.timelineItems?.nodes;
	if (!nodes || nodes.length === 0) {
		return { blocked: false, blockers: [] };
	}

	const lastEventByIssue = new Map<string, string>();

	for (const node of nodes) {
		const blockingId = node?.blockingIssue?.id;
		if (!blockingId) continue;
		lastEventByIssue.set(blockingId, node.__typename);
	}

	const blockers: BlockerInfo[] = [];
	const seenNumbers = new Set<number>();

	for (const node of nodes) {
		const issue = node.blockingIssue;
		if (!issue) continue;

		const lastEvent = lastEventByIssue.get(issue.id);
		if (lastEvent !== "BlockedByAddedEvent") continue;

		if (seenNumbers.has(issue.number)) continue;
		seenNumbers.add(issue.number);

		const state = issue.state || "UNKNOWN";
		if (state === "CLOSED") continue;

		blockers.push({
			number: issue.number,
			title: issue.title || "",
			type: "issue",
			state,
		});
	}

	return {
		blocked: blockers.length > 0,
		blockers,
	};
}

async function checkBlockedByDependencies(
	issueNumber: number,
	repo: string,
): Promise<DepsResult> {
	const [owner, name] = repo.split("/");
	if (!owner || !name) {
		throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);
	}

	const query = `
    query {
      repository(owner: "${owner}", name: "${name}") {
        issue(number: ${issueNumber}) {
          timelineItems(itemTypes: [BLOCKED_BY_ADDED_EVENT, BLOCKED_BY_REMOVED_EVENT], first: 100) {
            nodes {
              __typename
              ... on BlockedByAddedEvent {
                blockingIssue {
                  id
                  number
                  title
                  state
                }
              }
              ... on BlockedByRemovedEvent {
                blockingIssue {
                  id
                  number
                  title
                  state
                }
              }
            }
          }
        }
      }
    }`;

	let response: GhTimelineResponse;
	try {
		response = ghGraphQL(query) as GhTimelineResponse;
	} catch (err) {
		throw new Error(`Failed to query GitHub for dependencies: ${err instanceof Error ? err.message : String(err)}`);
	}

	return parseTimelineResponse(response);
}

// ─── Formatting helpers ──────────────────────────────────────────────

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

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function boldText(theme: any, text: string): string {
	return theme.bold?.(text) ?? text;
}

// ─── Extension resolution ───────────────────────────────────────────

/**
 * Resolve the extensions CLI flags for a given agent frontmatter.
 * - If extensions field is present and non-empty, split, trim, filter out
 *   "supervisor" (case-insensitive), and return `--extension <path>` flags.
 * - If nothing remains after filtering, fall back to `--no-extensions`.
 * - If extensions field is missing or empty, return `--no-extensions`.
 *
 * pi CLI uses `--extension` (singular) with a file path per flag.
 * Extension names are resolved relative to .pi/extensions/<name>.ts
 *
 * This is a pure function exported for unit testing.
 */
const CONTEXT_INFO_EXTENSION = ".pi/extensions/context-info.ts";

/**
 * Resolve the extensions CLI flags for a given agent frontmatter.
 * - If extensions field is present and non-empty, split, trim, filter out
 *   "supervisor" (case-insensitive), and return `--extension <path>` flags.
 * - If nothing remains after filtering, fall back to context-info only.
 * - If extensions field is missing or empty, return context-info only.
 * - Context-info is always auto-injected (deduplicated).
 *
 * pi CLI uses `--extension` (singular) with a file path per flag.
 * Extension names are resolved relative to .pi/extensions/<name>.ts
 *
 * This is a pure function exported for unit testing.
 */
export function resolveExtensions(extensionsRaw: string | undefined): string[] {
	if (!extensionsRaw || !extensionsRaw.trim()) {
		return ["--extension", CONTEXT_INFO_EXTENSION];
	}

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	const result: string[] = [];
	for (const ext of extensions) {
		result.push("--extension", `.pi/extensions/${ext}.ts`);
	}

	// Auto-inject context-info (deduplicated)
	const hasContextInfo = result.some(
		(r) => r === CONTEXT_INFO_EXTENSION || r.endsWith("/context-info.ts"),
	);
	if (!hasContextInfo) {
		result.push("--extension", CONTEXT_INFO_EXTENSION);
	}

	return result;
}

// ─── Constants ──────────────────────────────────────────────────────

export const MAX_FULL_LOG = 200;
export const WIDGET_LINES = 12;
export const MAX_LIVE_THINKING = 500;

// ─── Pure helpers (no framework imports) ────────────────────────────

/** Numeric priority for phase ordering. Higher = more important. */
export function phasePriority(phase: AgentPhase): number {
	switch (phase) {
		case "tool": return 3;
		case "thinking": return 2;
		case "text": return 1;
		case "idle": return 0;
	}
}

export function pushLog(state: AgentRunState, entry: string): void {
	state.fullLog.push(entry);
	if (state.fullLog.length > MAX_FULL_LOG) state.fullLog.shift();
}

/** Determine phase from a JSON event. Tool > thinking > text > idle. */
export function getPhaseFromEvent(ev: any): AgentPhase {
	if (!ev) return "idle";

	if (ev.type === "tool_execution_start") return "tool";
	if (ev.type === "tool_execution_end") return "idle";

	if (ev.type === "message_update") {
		const delta = ev.delta;
		if (!delta) return "idle";
		switch (delta.type) {
			case "thinking_delta":
				// Guard against empty delta — avoid spurious phase change on empty string
				if (delta.thinking_delta) return "thinking";
				break;
			case "thinking_start":
				return "thinking";
			case "text_delta":
				// Guard against empty delta — avoid spurious phase change on empty string
				if (delta.text_delta) return "text";
				break;
			case "text_start":
				return "text";
			case "thinking_end":
			case "text_end":
				return "idle";
		}
	}

	if (ev.type === "message_end") return "idle";
	return "idle";
}

/**
 * Process a single JSON line from pi's stdout.
 * Mutates state in place. Returns flush + workingChange flags.
 */
export function processJsonLine(
	line: string,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	if (!line.trim()) return { flush: false, workingChange: false };
	try {
		const ev = JSON.parse(line);
		switch (ev.type) {
			case "session":
				break;

			case "context_info": {
				const tokens = ev.contextTokens;
				const window = ev.contextWindow;
				if (typeof tokens === "number" && typeof window === "number" && window > 0) {
					state.contextTokens = tokens;
					state.contextWindow = window;
					state.contextInfoReceived = true;
					pushLog(state, `📊 Context: ${formatTokens(tokens)}/${formatTokens(window)} (initial)`);
					return { flush: true, workingChange: false };
				}
				break;
			}

			case "tool_execution_start": {
				const prevPhase = state.phase;
				state.currentTool = ev.toolName || "tool";
				state.currentToolArgs = ev.args
					? JSON.stringify(ev.args).slice(0, 200)
					: undefined;
				state.lastToolName = ev.toolName;
				state.phase = "tool";
				const logArgs = ev.args
					? JSON.stringify(ev.args).slice(0, 200)
					: "";
				pushLog(state, `🔧 ${ev.toolName}${logArgs ? ` ${logArgs}` : ""}`);
				return { flush: true, workingChange: prevPhase !== "tool" };
			}

			case "tool_execution_end": {
				state.toolCount++;
				state.currentTool = undefined;
				state.currentToolArgs = undefined;
				state.phase = "idle";
				pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
				return { flush: true, workingChange: true };
			}

			// ── message_update (streaming events) ────────────
			case "message_update": {
				const delta = ev.delta;
				if (!delta) break;

				const prevPhase = state.phase;
				const eventPhase = getPhaseFromEvent(ev);
				// Never downgrade: tool > thinking > text > idle
				if (eventPhase !== "idle" && phasePriority(eventPhase) >= phasePriority(state.phase)) {
					state.phase = eventPhase;
				}

				switch (delta.type) {
					case "thinking_delta": {
						const td = delta.thinking_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveThinking += td;
							// Prevent unbounded buffer growth
							if (state.liveThinking.length > MAX_LIVE_THINKING * 2) {
								state.liveThinking = state.liveThinking.slice(-MAX_LIVE_THINKING);
							}
							return { flush: true, workingChange: prevPhase !== "thinking" };
						}
						break;
					}

					case "text_delta": {
						const td = delta.text_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveText += td;
							if (state.liveText.length > 10_000) {
								state.liveText = state.liveText.slice(-8_000);
							}
							return { flush: true, workingChange: prevPhase !== "text" };
						}
						break;
					}

					case "thinking_end": {
						if (state.liveThinking.trim()) {
							state.thinkingOutputLines.push(state.liveThinking.trim());
							for (const t of state.liveThinking.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, `💭 ${trimmed.slice(0, 200)}`);
							}
						}
						state.liveThinking = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}

					case "text_end": {
						if (state.liveText.trim()) {
							state.textOutputLines.push(state.liveText.trim());
							for (const t of state.liveText.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, trimmed);
							}
						}
						// Capture usage from text_end or parent message
						if (ev.usage) {
							state.tokenCount =
								ev.usage.totalTokens || ev.usage.input + ev.usage.output || state.tokenCount;
						}
						state.liveText = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}
				}
				break;
			}

			// ── message_end ──────────────────────────────────
			case "message_end": {
				const msg = ev.message;
				if (!msg) break;

				if (msg.role === "assistant") {
					// Capture thinking from content blocks
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "thinking" && block.thinking) {
								const thinkingText = typeof block.thinking === "string"
									? block.thinking
									: JSON.stringify(block.thinking).slice(0, 500);
								for (const t of thinkingText.split("\n")) {
									if (t.trim()) pushLog(state, `💭 ${t.slice(0, 200)}`);
								}
							}
						}
					}
					const text = extractTextFromContent(msg.content);
					if (text && text.trim()) {
						state.textOutputLines.push(text.trim());
						for (const t of text.split("\n")) {
							if (t.trim()) pushLog(state, t);
						}
					}
					if (msg.usage) {
						state.tokenCount =
							msg.usage.totalTokens || msg.usage.input + msg.usage.output;
					}
				} else if (msg.role === "toolResult") {
					const resultText = extractTextFromContent(msg.content);
					const label = msg.toolName || state.lastToolName || "tool";
					if (resultText && resultText.trim()) {
						const resultLines = resultText.split("\n");
						pushLog(state, `📋 ${label}: ${resultLines[0]?.slice(0, 300) || "(no output)"}`);
						for (let i = 1; i < Math.min(resultLines.length, 6); i++) {
							if (resultLines[i].trim())
								pushLog(state, `   ${resultLines[i].slice(0, 200)}`);
						}
					} else {
						pushLog(state, `📋 ${label}: (no output)`);
					}
					state.lastToolName = undefined;
				}
				state.phase = "idle";
				return { flush: true, workingChange: true };
			}

			case "agent_end":
			case "turn_end":
				break;
		}
	} catch {
		// non-JSON stdout lines
	}
	return { flush: false, workingChange: false };
}

/**
 * Build widget lines from state. Pure function — no side effects.
 * Returns at most WIDGET_LINES (12) lines.
 */
export function buildWidgetLines(
	state: AgentRunState,
	agentName: string,
): string[] {
	const lines: string[] = [];
	const now = Date.now();

	// Header
	lines.push(`⚙ ${agentName}`);

	// Context line
	if (state.contextInfoReceived && state.contextTokens !== undefined && state.contextWindow !== undefined) {
		lines.push(`  Context: ${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`);
	} else {
		lines.push("  Context: computing...");
	}

	// Live thinking (accent line, ... prefix while incomplete)
	if (state.phase === "thinking" && state.liveThinking.trim()) {
		const live = state.liveThinking.slice(-MAX_LIVE_THINKING);
		const condensed = live.replace(/\s+/g, " ").trim().slice(-100);
		if (condensed) lines.push(`  ... ${condensed}`);
	}

	// Live text (streaming output)
	if (state.phase === "text" && state.liveText.trim()) {
		const live = state.liveText.slice(-500);
		const condensed = live.replace(/\s+/g, " ").trim().slice(-100);
		if (condensed) lines.push(`  ${condensed}`);
	}

	// Current tool display
	if (state.currentTool) {
		const toolLabel = state.currentToolArgs
			? `${state.currentTool}: ${state.currentToolArgs.slice(0, 80)}`
			: state.currentTool;
		lines.push(`  🔧 ${toolLabel}`);
	}

	// Recent fullLog entries (fill remaining lines up to WIDGET_LINES)
	const remaining = WIDGET_LINES - lines.length - 1; // -1 for stats footer
	if (remaining > 0 && state.fullLog.length > 0) {
		const recent = state.fullLog.slice(-remaining);
		for (const entry of recent) {
			// Strip emoji prefix to avoid clutter
			const display = entry.replace(/^[^\s]+\s/, "").slice(0, 90);
			lines.push(`  ${display}`);
		}
	}

	// Stats footer
	const statsParts: string[] = [];
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	const elapsed = formatDuration(now - state.startedAt);
	statsParts.push(`⏱ ${elapsed}`);
	if (statsParts.length > 0) {
		lines.push(`  ${statsParts.join(" · ")}`);
	}

	return lines.slice(0, WIDGET_LINES);
}

/** Build working message from phase. Priority: tool > thinking > text. */
export function getWorkingMessage(state: AgentRunState, agentName: string): string | null {
	switch (state.phase) {
		case "tool":
			if (state.currentTool) return `${agentName}: ${state.currentTool}`;
			return `${agentName}: working...`;
		case "thinking":
			return `${agentName}: thinking...`;
		case "text":
			return `${agentName}: responding...`;
		default:
			return null;
	}
}

// ─── runAgent ────────────────────────────────────────────────────────

export async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
	timeoutMs: number = DEFAULT_AGENT_TIMEOUT_MS,
): Promise<AgentRunResult> {
	const tools = agent.config.tools || "read,bash,write,edit";
	// NOTE: Extension-declared tools (e.g. codebase search from codebase-memory.ts)
	// are NOT automatically added to the --tools flag. Agent configs that specify
	// extensions: must also explicitly list extension tool names in their tools: field.
	// This is a known limitation — previous resolveTools/discoverExtensionTools
	// functions that auto-resolved extension tools were removed during cleanup.
	const model = agent.config.model || "";
	const extFlags = resolveExtensions(agent.config.extensions);

	const args: string[] = [
		"-p",
		"--mode",
		"json",
		task,
		"--system-prompt",
		agent.systemPrompt,
		"--tools",
		tools,
		...extFlags,
		"--no-skills",
		"--no-context-files",
	];
	if (model) args.push("--model", model);

	const widgetId = `agent-${agent.config.name}`;
	const agentName = agent.config.name;
	ctx.ui.notify(`Running agent: ${agentName}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

	const startedAt = Date.now();

	// ── Mutable state ─────────────────────────────────────────────
	const state: AgentRunState = {
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		phase: "idle",
		startedAt,
		contextInfoReceived: false,
	};

	return new Promise((resolve) => {
		const abortController = new AbortController();
		const child = spawn("/usr/bin/pi", args, {
			cwd: process.cwd(),
			env: { ...process.env, PI_NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			signal: abortController.signal,
		});

		// Enforceable timeout via AbortController — spawn timeout option is
		// Node >=14.18.0 but AbortController is more portable.
		const timeoutTimer = setTimeout(() => {
			abortController.abort();
			child.kill("SIGTERM");
			// Grace period then force kill
			setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5_000);
		}, timeoutMs);

		const MAX_RAW_STDOUT = 500_000; // prevent RangeError on huge output
		let rawStdout = "";
		let stderr = "";
		let jsonBuffer = "";

		let flushTimer: NodeJS.Timeout | null = null;

		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			ctx.ui.setWidget(widgetId, buildWidgetLines(state, agentName));
			// Update status bar with live time/tokens
			const now = Date.now();
			const parts: string[] = [];
			parts.push(`⏱ ${formatDuration(now - state.startedAt)}`);
			if (state.tokenCount > 0) parts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
			if (state.toolCount > 0) parts.push(`🔧 ${state.toolCount} tools`);
			ctx.ui.setStatus("supervisor", `${agentName}  ${parts.join(" · ")}`);
		};

		// Batch widget updates to avoid flicker
		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 80);
			}
		};

		const handleLine = (line: string) => {
			const result = processJsonLine(line, state);
			if (result.flush) scheduleFlush();
			if (result.workingChange) {
				const wm = getWorkingMessage(state, agentName);
				ctx.ui.setWorkingMessage(wm ?? undefined);
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (rawStdout.length + chunk.length > MAX_RAW_STDOUT) {
				// Truncate from beginning to avoid RangeError
				const keep = MAX_RAW_STDOUT - chunk.length;
				rawStdout = rawStdout.slice(-Math.max(keep, 0)) + chunk;
			} else {
				rawStdout += chunk;
			}
			jsonBuffer += chunk;
			const lines = jsonBuffer.split("\n");
			jsonBuffer = lines.pop() || "";
			for (const line of lines) handleLine(line);
		});

		child.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			if (stderr.length + chunk.length <= MAX_RAW_STDOUT) {
				stderr += chunk;
			}
		});

		child.on("close", (code, signal) => {
			clearTimeout(timeoutTimer);
			if (jsonBuffer.trim()) handleLine(jsonBuffer);
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}

			const durationMs = Date.now() - startedAt;
			const textOutput = state.fullLog.join("\n").trim();
			const rawOutput = rawStdout + (stderr ? "\n[STDERR]\n" + stderr : "");
			const killed = signal !== null;
			const success = code === 0 && !killed;
			if (killed) {
				pushLog(state, `[Timeout: ${agentName} killed by ${signal} after ${formatDuration(durationMs)}]`);
			}

			// Build thinking output from accumulated lines
			const thinkingOutput = state.thinkingOutputLines.length > 0
				? state.thinkingOutputLines.join("\n\n")
				: undefined;

			// Extract a one-line summary from the text output
			const summaryLine = extractSummaryLine(textOutput, success, agentName);

			// Clear widget and working message — results go to chat via message renderer
			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus("supervisor", "");

			resolve({
				output: rawOutput,
				success,
				agentName,
				toolCount: state.toolCount,
				tokenCount: state.tokenCount,
				durationMs,
				textOutput,
				summaryLine,
				errorOutput: stderr,
				thinkingOutput,
			});
		});

		child.on("error", (err) => {
			clearTimeout(timeoutTimer);
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setWorkingMessage(undefined);
			ctx.ui.setStatus("supervisor", "");
			resolve({
				output: `Failed to start pi: ${err.message}`,
				success: false,
				agentName: agent.config.name,
				toolCount: 0,
				tokenCount: 0,
				durationMs: Date.now() - startedAt,
				textOutput: "",
				summaryLine: `Failed to start: ${err.message}`,
				errorOutput: err.message,
			});
		});
	});
}

// ─── Output helpers ──────────────────────────────────────────────────

/** Pull a one-line summary from the agent's text output */
function extractSummaryLine(
	textOutput: string,
	success: boolean,
	agentName: string,
): string {
	if (!textOutput) return success ? `${agentName} completed` : `${agentName} failed`;

	// Find the LAST completion marker (avoids matching echoed task instructions
	// that contain both AUDIT_APPROVED and AUDIT_REJECTED).
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
		return lastMarker.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
	}

	// Use first non-empty, non-tool line
	const firstLine = textOutput.split("\n").find(
		(l) => l.trim() && !l.startsWith("🔧") && !l.startsWith("📋") && !l.startsWith("💭"),
	);
	if (firstLine) {
		return firstLine.trim().slice(0, 120);
	}
	return success ? `${agentName} completed` : `${agentName} failed`;
}

function countRejections(comments: any[]): number {
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

function buildAgentTask(
	agentName: string,
	issueNum: number,
	repo: string,
	title: string,
	filteredData: FilteredIssueData,
	submodules: Array<{path: string; repo: string}>,
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
			const wt = `${worktreeBase}${branch}`;
			return `${issueBlock}\n\n## Task\nImplement the code changes in a git worktree.\n\n### Setup\n1. Create worktree: \`git worktree add ${wt} ${defaultBranch}\`\n2. For ALL implementation work, use: \`cd ${wt} && <your commands>\`\n   (Never run write/edit/bash in the project root — always cd into worktree first!)\n3. Implement the feature following the architecture and test plan from the trusted comments above.\n\n### Commit\n\`\`\`\ncd ${wt}\ngit add -A\ngit commit -m "feat(#${issueNum}): ${title}"\ngit push ${remote} ${branch}\n\`\`\`\n\n**Branch name:** ${branch}\n**Worktree path:** ${wt}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output IMPLEMENTATION_COMPLETE on its own line.`;
		}

		case "auditor": {
			const branch = generateBranchName(issueNum, title, branchPrefix);
			const wt = `${worktreeBase}${branch}`;

			// Build submodule PR creation instructions
			let submodulePrSection = "";
			let submodulePrList = "";
			if (submodules.length > 0) {
				const subBlocks: string[] = [];
				const subListItems: string[] = [];
				for (const sub of submodules) {
					// Only create PR if submodule has actual changes (uncommitted or unpushed)
					subBlocks.push(
						`cd ${sub.path}\n` +
						`CHANGES=$(git status --porcelain 2>/dev/null)\n` +
						`COMMITS=$(git rev-list --count ${remote}/${defaultBranch}..${branch} 2>/dev/null || echo 0)\n` +
						`if [ -n "$CHANGES" ] || [ "$COMMITS" != "0" ]; then\n` +
						`  if [ -z "$CHANGES" ]; then\n` +
						`    gh pr create --repo ${sub.repo} --base ${defaultBranch} --head ${branch} \\\n` +
						`      --title "feat(#${issueNum}): ${title}" \\\n` +
						`      --body "Companion PR for ${repo}#${issueNum}"\n` +
						`  else\n` +
						`    git checkout -b ${branch} 2>/dev/null || git checkout ${branch}\n` +
						`    git add -A\n` +
						`    git commit -m "feat(#${issueNum}): ${title}"\n` +
						`    git push ${remote} ${branch}\n` +
						`    gh pr create --repo ${sub.repo} --base ${defaultBranch} --head ${branch} \\\n` +
						`      --title "feat(#${issueNum}): ${title}" \\\n` +
						`      --body "Companion PR for ${repo}#${issueNum}"\n` +
						`  fi\n` +
						`fi\n` +
						`cd ${worktreeBase}`
					);
					subListItems.push(`${sub.repo}: \`${branch}\``);
				}
				submodulePrSection =
					`**Step 1 — Create submodule PRs first (critical order):**\n` +
					`Check each submodule for changes. Only create a PR if there are actual changes (uncommitted files or unpushed commits):\n\n` +
					`\`\`\`\n${subBlocks.join("\n\n")}\n\`\`\`\n\n`;
				submodulePrList = subListItems.map(s => `- ${s}`).join("\n");
			}

			const stepLabel = submodules.length > 0 ? "Step 2 — " : "";
			const prList = submodulePrList
				? `\n\nPRs created:\n- ${repo}: \`${branch}\`\n${submodulePrList}`
				: "";

			return `${issueBlock}\n\n## Task\nReview the implementation in the developer's worktree at ${wt} and decide APPROVE or REJECT.\n\n### Steps\n1. Enter worktree: \`cd ${wt}\`\n2. Review the code: \`git diff ${defaultBranch}\` (shows all changes on this branch vs ${defaultBranch})\n3. Run tests if any exist\n4. Evaluate against the architecture and test plan from the trusted comments above.\n\n### Decision\n\n**IF APPROVE:**\n\n${submodulePrSection}**${stepLabel}Create ${repo} PR:**\n\`\`\`\ngh pr create --repo ${repo} --base ${defaultBranch} --head ${branch} \\\n  --title "feat(#${issueNum}): ${title}" \\\n  --body "Closes #${issueNum}"\n\ngh issue comment ${issueNum} --repo ${repo} --body "## Audit Approved\n\nThe implementation has been reviewed and meets all requirements.\n\n- Architecture compliance: ✓\n- Test coverage: ✓\n- Code quality: ✓\n- Completeness: ✓${prList}"\n\`\`\`\nOutput AUDIT_APPROVED on its own line.\n\n**IF REJECT:**\n\`\`\`\ngh issue comment ${issueNum} --repo ${repo} --body "## Audit Rejected\n\n[list specific issues]"\n\`\`\`\nOutput AUDIT_REJECTED on its own line.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		case "researcher":
			return `${issueBlock}\n\n## Task\nResearch the issue topic against public web sources and post a structured findings comment.\n\n### Steps\n1. Scan the provided issue data above. If you see a comment containing \`## Research Findings\`, skip all research and output RESEARCH_COMPLETE on its own line immediately.\n2. Extract the core topic from the issue title, body, and architecture comment.\n3. Crawl 3-5 distinct public web pages using \`web_crawl <url> --maxPages 1\`\n4. Synthesize findings into a single comment using:\n   \`gh issue comment ${issueNum} --repo ${repo} --body "...your findings..."\`\n\n### Comment format\n\`\`\`\n## Research Findings\n\n### Best Practices\n- <finding> — <source link>\n\n### Recent Libraries\n- <library> <version> — <why relevant> — <source link>\n\n### Common Pitfalls\n- <pitfall> — <why it matters> — <source link>\n\`\`\`\n\nEvery bullet must include a source URL. Findings only — no recommendations, no architectural judgments. If all crawls fail, post: \`## Research Findings — No relevant results found for this topic.\`\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output RESEARCH_COMPLETE on its own line.`;

		default:
			return `${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
	}
}

function generateBranchName(issueNum: number, title: string, prefix: string = "worktree-git-issue-"): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 50);
	return `${prefix}${issueNum}-${slug}`;
}

// ─── PR Conflict Detection ──────────────────────────────────────────

interface PrConflictInfo {
	number: number;
	hasConflict: boolean;
	mergeable: string;
	mergeStateStatus: string;
	headRefName: string;
	baseRefName: string;
}

async function checkPrConflicts(
	branch: string,
	repo: string,
): Promise<PrConflictInfo | null> {
	try {
		const result = ghJson([
			"pr",
			"list",
			"--repo",
			repo,
			"--head",
			branch,
			"--json",
			"number,mergeable,mergeStateStatus,headRefName,baseRefName",
		]);
		if (!result || !Array.isArray(result) || result.length === 0) {
			return null; // No PR found for this branch
		}
		const pr = result[0];
		return {
			number: pr.number,
			hasConflict:
				pr.mergeable === "CONFLICTING" ||
				pr.mergeStateStatus === "DIRTY",
			mergeable: pr.mergeable || "UNKNOWN",
			mergeStateStatus: pr.mergeStateStatus || "UNKNOWN",
			headRefName: pr.headRefName,
			baseRefName: pr.baseRefName,
		};
	} catch {
		// PR might not exist yet, or gh command failed
		return null;
	}
}

// ─── Merge Conflict Resolution ──────────────────────────────────────

interface MergeResult {
	success: boolean;
	conflictFiles: string[];
	message: string;
}

function tryAutoMerge(
	worktreePath: string,
	branch: string,
	defaultBranch: string,
	remote: string,
): MergeResult {
	const execOpts = { encoding: "utf-8" as const, timeout: 60_000 };

	try {
		// Fetch base branch
		execFileSync("git", ["fetch", remote, defaultBranch], {
			cwd: worktreePath,
			...execOpts,
		});

		// Try merge
		execFileSync(
			"git",
			["merge", `${remote}/${defaultBranch}`, "--no-edit"],
			{ cwd: worktreePath, ...execOpts },
		);

		return {
			success: true,
			conflictFiles: [],
			message: "Merge succeeded with no conflicts.",
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const stderr = (err instanceof Error && "stderr" in err) ? (err as NodeJS.ErrnoException).stderr?.toString() || message : message;

		// Check for conflicted files
		let conflictFiles: string[] = [];
		try {
			const status = execFileSync(
				"git",
				["diff", "--name-only", "--diff-filter=U"],
				{ cwd: worktreePath, encoding: "utf-8", timeout: 10_000 },
			).trim();
			if (status) {
				conflictFiles = status.split("\n").filter(Boolean);
			}
		} catch {
			// Couldn't get conflict list
		}

		if (conflictFiles.length > 0) {
			// Abort the failed merge to leave a clean state for the developer agent
			try {
				execFileSync("git", ["merge", "--abort"], {
					cwd: worktreePath,
					encoding: "utf-8",
					timeout: 10_000,
				});
			} catch {
				// best effort
			}
			return {
				success: false,
				conflictFiles,
				message: `Merge conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(", ")}`,
			};
		}

		return {
			success: false,
			conflictFiles,
			message: `Merge failed: ${stderr.slice(0, 300)}`,
		};
	}
}

function determineNextStatus(
	agentName: string,
	output: string,
	_currentStatus: string,
	_config: SupervisorConfig,
): string | null {
	switch (agentName) {
		case "architect":
			return output.includes("ARCHITECTURE_COMPLETE") ? "Research" : null;
		case "researcher":
			return output.includes("RESEARCH_COMPLETE") ? "TestDesign" : null;
		case "test-designer":
			return output.includes("TEST_PLAN_COMPLETE") ? "Implementation" : null;
		case "developer":
			return output.includes("IMPLEMENTATION_COMPLETE") ? "Audit" : null;
		case "auditor": {
			// Use lastIndexOf: the agent's task prompt contains both
			// "AUDIT_APPROVED" and "AUDIT_REJECTED" in the instructions.
			// The final verdict always appears last in the output.
			const idxApproved = output.lastIndexOf("AUDIT_APPROVED");
			const idxRejected = output.lastIndexOf("AUDIT_REJECTED");
			if (idxRejected > idxApproved) return "Implementation";
			if (idxApproved > idxRejected) return "Done";
			return null;
		}
		default:
			return null;
	}
}

// ─── LSP Pre-Audit Hook (pure helper for testability) ──────────────

export interface LspPreAuditDecision {
	/** New status to transition to — "Audit" if proceeding, "Implementation" if blocking */
	nextStatus: string;
	/** Note to include in notification */
	note: string;
	/** Whether LSP audit was actually triggered */
	auditTriggered: boolean;
}

/**
 * Decide the next transition status based on LSP pre-audit result.
 * Pure function — does not call Pi API or spawn processes.
 *
 * @param intendedNext The status supervisor planned (e.g. "Audit")
 * @param preAuditResult Result from runPreAudit (null if audit skipped)
 * @param retryCount Number of LSP audit retries already used
 * @param hasModifiedFiles Whether the developer session produced any file changes
 */
export function determineLspPreAuditDecision(
	intendedNext: string,
	preAuditResult: { proceed: boolean; note: string } | null,
	retryCount: number,
	hasModifiedFiles: boolean,
): LspPreAuditDecision {
	// Not an Implementation→Audit transition — pass through
	if (intendedNext !== "Audit") {
		return { nextStatus: intendedNext, note: "", auditTriggered: false };
	}

	// No modified files — skip audit, proceed normally
	if (!hasModifiedFiles) {
		return { nextStatus: "Audit", note: "LSP audit skipped: no modified files", auditTriggered: false };
	}

	// Audit was not run (null result) — proceed normally
	if (!preAuditResult) {
		return { nextStatus: "Audit", note: "", auditTriggered: false };
	}

	// Audit says proceed (clean or all-servers-failed)
	if (preAuditResult.proceed) {
		return { nextStatus: "Audit", note: preAuditResult.note, auditTriggered: true };
	}

	// Audit found errors — check retry limit
	const n = typeof retryCount !== "number" || Number.isNaN(retryCount) || retryCount < 0 ? 0 : retryCount;
	if (n >= 3) {
		// Retries exhausted — force through to Audit with errors documented
		return { nextStatus: "Audit", note: preAuditResult.note, auditTriggered: true };
	}

	// Retries remain — block transition, keep in Implementation
	return { nextStatus: "Implementation", note: preAuditResult.note, auditTriggered: true };
}

// ─── Extension ───────────────────────────────────────────────────────

export default function supervisor(pi: ExtensionAPI): void {
	// Dynamically import runPreAudit (lazy to avoid issues at load time)
	let _runPreAudit: unknown = null;
	async function getRunPreAudit(): Promise<unknown> {
		if (_runPreAudit) return _runPreAudit;
		try {
			const mod = await import("./lsp-auditor.ts");
			_runPreAudit = mod.runPreAudit;
			return _runPreAudit;
		} catch {
			return null;
		}
	}
	// ── Message renderer: styled supervisor result ──────────────────

	pi.registerMessageRenderer<SupervisorMessageDetails>("supervisor", (message, _options, theme) => {
		const details = message.details as SupervisorMessageDetails | undefined;
		// Fallback for old-format messages that only have content string
		if (!details && typeof message.content === "string") {
			return new Text(message.content, 1, 1);
		}
		if (!details) return new Text("(no details)", 1, 1);

		const w = Math.max(40, getTermWidth() - 4);
		const fit = (s: string) => truncateToWidth(s, w);

		const c = new Container();
		const statusColor = details.success ? "success" : "error";
		const statusIcon = details.success ? "✓" : "✗";
		const statusText = details.success ? "SUCCESS" : "FAILED";

		// Header: status icon + agent name + status
		c.addChild(new Text(
			fit(`${theme.fg(statusColor, statusIcon)} ${theme.fg("toolTitle", boldText(theme, details.agentName))} — ${theme.fg(statusColor, statusText)}`),
			1, 0,
		));

		// Stats line: tools, tokens, duration
		const statsParts: string[] = [];
		if (details.toolCount > 0) statsParts.push(`${details.toolCount} tool${details.toolCount === 1 ? "" : "s"}`);
		if (details.tokenCount > 0) statsParts.push(`${formatTokens(details.tokenCount)} tokens`);
		if (details.durationMs > 0) statsParts.push(formatDuration(details.durationMs));
		if (statsParts.length > 0) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(
				fit(theme.fg("dim", statsParts.join(" · "))),
				1, 0,
			));
		}

		// Summary line
		if (details.summaryLine) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(
				fit(theme.fg("dim", details.summaryLine)),
				1, 0,
			));
		}

		// Thinking output (expanded view, color-coded as dim)
		if (details.hasThinking && details.thinkingOutput) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(
				fit(theme.fg("dim", "── Thinking ──")),
				1, 0,
			));
			const thinkingLines = details.thinkingOutput.split("\n");
			for (const line of thinkingLines) {
				const styled = theme.fg("dim", line || " ");
				for (const wrapped of wrapTextWithAnsi(styled, w)) {
					c.addChild(new Text(wrapped, 1, 0));
				}
			}
		}

		// Text output (word-wrapped, color-coded by event type)
		if (details.textOutput) {
			c.addChild(new Spacer(1));
			const outputLines = details.textOutput.split("\n");
			for (const line of outputLines) {
				let styledLine: string;
				if (line.startsWith("🔧 ")) {
					styledLine = theme.fg("toolTitle", line);
				} else if (line.startsWith("✓ ")) {
					styledLine = theme.fg("success", line);
				} else if (line.startsWith("✗ ")) {
					styledLine = theme.fg("error", line);
				} else if (line.startsWith("💭 ")) {
					styledLine = theme.fg("dim", line);
				} else if (line.startsWith("📋 ")) {
					styledLine = theme.fg("dim", line);
				} else {
					styledLine = line;
				}
				for (const wrapped of wrapTextWithAnsi(styledLine || " ", w)) {
					c.addChild(new Text(wrapped, 1, 0));
				}
			}
		}

		return c;
	});

	// ── Slash command ───────────────────────────────────────────────

	pi.registerCommand("supervisor", {
		description: "Process a GitHub issue through the full Kanban pipeline",
		handler: async (args, ctx) => {
			const issueNum = parseInt(args?.trim() || "", 10);
			if (!issueNum || issueNum < 1) {
				ctx.ui.notify("Usage: /supervisor <issue-number>", "error");
				return;
			}

			try {
				const config = loadConfig();
				const owner = config.repo.split("/")[0]!;

				// Initial fetch
				ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
				let issueData: any;
				try {
					issueData = ghJson([
						"issue",
						"view",
						String(issueNum),
						"--repo",
						config.repo,
						"--json",
						"number,title,body,author,comments",
					]);
				} catch {
					ctx.ui.notify(
						`Issue #${issueNum} not found in ${config.repo}`,
						"error",
					);
					return;
				}

				const issueTitle: string = issueData?.title || `Issue #${issueNum}`;

				// Print issue header so user knows what issue is being processed
				pi.sendMessage({
					content: `## GitHub Issue: [#${issueNum}] ${issueTitle}\n\n**Repository:** \`${config.repo}\``,
					display: true,
				});

				// Code-level security: filter issue body + comments to trusted codeowners only
				const filteredData = filterIssueData(issueData, config.codeowners);

				// Get board info
				ctx.ui.setStatus("supervisor", "Reading project board...");
				let fields: ProjectField[];
				let items: ProjectItem[];
				let projectId: string;

				try {
					fields = getProjectFields(config.projectNumber, owner);
					items = getProjectItems(config.projectNumber, owner);
					projectId = getProjectId(config.projectNumber, owner);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (
						msg.includes("missing required scopes") ||
						msg.includes("project")
					) {
						ctx.ui.notify(
							"GitHub token missing 'project' scope. Run: gh auth refresh -s project",
							"error",
						);
					} else {
						ctx.ui.notify(`Failed to read project board: ${msg}`, "error");
					}
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				const statusField = fields.find(
					(f) => f.name.toLowerCase() === config.statusField?.toLowerCase(),
				);
				if (!statusField) {
					ctx.ui.notify(
						`Status field '${config.statusField}' not found. Fields: ${fields.map((f) => f.name).join(", ")}`,
						"error",
					);
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				const loopItem = findIssueItem(items, issueNum);
				if (!loopItem) {
					ctx.ui.notify(
						`Issue #${issueNum} not on project board #${config.projectNumber}.`,
						"error",
					);
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				// ── Dependency gate: check "blocked by" links ──────
				ctx.ui.setStatus("supervisor", "Checking dependencies...");
				try {
					const depsResult = await checkBlockedByDependencies(
						issueNum,
						config.repo,
					);
					if (depsResult.blocked) {
						const lines = depsResult.blockers.map((b) => {
							const prefix = b.type === "pullrequest" ? "!" : "#";
							return `${prefix}${b.number}: ${b.title} (open)`;
						});
						ctx.ui.notify(
							`Issue #${issueNum} is blocked by unresolved dependencies:\n${lines.join("\n")}`,
							"error",
						);
						ctx.ui.setStatus("supervisor", "");
						return;
					}
				} catch (err) {
					ctx.ui.notify(
						`Dependency check failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				// ── Pipeline loop ────────────────────────────────────
				let loopStatus = getItemStatusName(loopItem);
				const MAX_LOOPS = 20;

				for (let i = 0; i < MAX_LOOPS; i++) {
					ctx.ui.notify(
						`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`,
						"info",
					);

					// BACKLOG → advance to Architecture
					if (loopStatus.toLowerCase() === "backlog") {
						const optId = findStatusOption(
							fields,
							statusField.id,
							"Architecture",
						);
						if (!optId) {
							ctx.ui.notify(
								"Cannot find 'Architecture' status option",
								"error",
							);
							break;
						}
						setItemStatus(loopItem.id, projectId, statusField.id, optId);
						ctx.ui.notify(
							`Issue #${issueNum} moved: Backlog → Architecture`,
							"info",
						);
						loopStatus = "Architecture";
						continue;
					}

					// DONE → complete
					if (loopStatus.toLowerCase() === "done") {
						ctx.ui.notify(
							`Issue #${issueNum} is Done. Pipeline complete.`,
							"info",
						);
						break;
					}

					// Map status to agent
					const agentName = config.statusMapping[loopStatus];
					if (!agentName) {
						const mapped = Object.keys(config.statusMapping).join(", ");
						ctx.ui.notify(
							`No agent for status '${loopStatus}'. Mapped: ${mapped}`,
							"error",
						);
						break;
					}

					// Re-read issue for fresh comments
					let freshData: any;
					try {
						freshData = ghJson([
							"issue",
							"view",
							String(issueNum),
							"--repo",
							config.repo,
							"--json",
							"number,title,body,author,comments",
						]);
					} catch {
						freshData = issueData;
					}

					// Code-level security: filter issue body + comments to trusted codeowners only
					const loopFilteredData = filterIssueData(freshData, config.codeowners);

					// Rejection limit check (uses filtered comments to prevent attacker-triggered limit)
					if (agentName === "auditor") {
						const rejectionCount = countRejections(
							loopFilteredData.comments.map((c) => ({ body: c.body })),
						);
						if (rejectionCount >= (config.maxRejections || 3)) {
							ctx.ui.notify(
								`Issue #${issueNum} rejected ${config.maxRejections} times. Human intervention required.`,
								"error",
							);
							break;
						}
					}

					// Load agent
					const agentPath = `.pi/agents/${agentName}.md`;
					if (!existsSync(agentPath)) {
						ctx.ui.notify(`Agent file not found: ${agentPath}`, "error");
						break;
					}

					let agent: ParsedAgent;
					try {
						agent = parseAgentFile(agentPath);
					} catch (err) {
						ctx.ui.notify(`Failed to parse agent: ${err instanceof Error ? err.message : String(err)}`, "error");
						break;
					}

					// Build task and run
					const submodules = config.submodules || [];
					const task = buildAgentTask(
						agentName,
						issueNum,
						config.repo,
						issueTitle,
						loopFilteredData,
						submodules,
						config.defaultBranch!,
						config.remote!,
						config.worktreeBase!,
						config.branchPrefix!,
					);
					ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");

					// Compute per-agent timeout
					const timeoutMs = resolveTimeoutMs(agentName, config.agentTimeoutsMin);

					let result = await runAgent(agent, task, ctx, timeoutMs);
					let usedRetry = false;

					if (!result.success) {
						ctx.ui.notify(
							`Agent ${agent.config.name} failed. Retrying once...`,
							"warning",
						);
						result = await runAgent(agent, task, ctx, timeoutMs);
						usedRetry = true;
					}

					// Send structured result to chat (rendered by message renderer)
					const statusLabel = !result.success
						? "FAILED"
						: usedRetry
							? "SUCCESS (after retry)"
							: "SUCCESS";

					pi.sendMessage({
						customType: "supervisor",
						content: `## Agent: ${result.agentName} — ${statusLabel}\n\n${result.textOutput || result.summaryLine}`,
						display: true,
						details: {
							agentName: result.agentName,
							success: result.success,
							statusLabel,
							toolCount: result.toolCount,
							tokenCount: result.tokenCount,
							durationMs: result.durationMs,
							textOutput: result.textOutput,
							summaryLine: result.summaryLine,
							thinkingOutput: result.thinkingOutput,
							hasThinking: !!result.thinkingOutput,
						} satisfies SupervisorMessageDetails,
					});

					// Determine and apply next status
					const nextStatus = determineNextStatus(
						agentName,
						result.textOutput,
						loopStatus,
						config,
					);

					// Break on failure only if the next agent depends on this one's output.
					// Auditor should still review a "failed" developer run (code exists
					// despite non-zero exit e.g. from a hung tool).
					if (!result.success && nextStatus !== "Audit") {
						ctx.ui.notify(
							`Agent ${agent.config.name} failed. Pipeline stops before ${nextStatus || "next stage"}.`,
							"warning",
						);
						break;
					}
					if (!nextStatus) {
						ctx.ui.notify(
							`Agent ${agent.config.name} output unclear. Pipeline stopped.`,
							"warning",
						);
						break;
					}

					// ── LSP Pre-Audit Hook (Implementation → Audit only) ──
					let effectiveNextStatus = nextStatus;
					if (nextStatus === "Audit") {
						try {
							const runPreAuditFn = await getRunPreAudit();
							let preAuditResult: any = null;
							let hasModifiedFiles = true;
							let retryCount = 0;

							if (runPreAuditFn) {
								const branch = generateBranchName(issueNum, issueTitle, config.branchPrefix!);
								const wt = `${config.worktreeBase!}${branch}`;
								try {
									const diffOut = execFileSync("git", ["diff", config.defaultBranch!, "--name-only"], {
										cwd: resolvePath(wt),
										encoding: "utf-8",
										stdio: ["pipe", "pipe", "pipe"],
										timeout: 10_000,
									}).trim();
									hasModifiedFiles = diffOut.length > 0;
								} catch {
									hasModifiedFiles = false;
								}

								// Count retries BEFORE runPreAudit so the count reflects
								// state before this invocation records a new entry.
								const entries = ctx.sessionManager.getEntries();
								retryCount = 0;
								for (const e of entries) {
									if (e.type === "lsp-audit-retry" && (e.payload as any)?.issueNum === issueNum) {
										retryCount++;
									}
								}

								if (hasModifiedFiles) {
									ctx.ui.setStatus("supervisor", "Running LSP pre-audit diagnostics...");
									preAuditResult = await runPreAuditFn(
										{ issueNum, worktreePath: wt, defaultBranch: config.defaultBranch!, repo: config.repo },
										pi,
										ctx,
									);
								}
							}

							const decision = determineLspPreAuditDecision(
								nextStatus,
								preAuditResult,
								retryCount,
								hasModifiedFiles,
							);

							effectiveNextStatus = decision.nextStatus;
							if (decision.note) {
								ctx.ui.notify(decision.note, "info");
							}
						} catch (auditErr) {
							ctx.ui.notify(`LSP pre-audit error: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`, "warning");
						}
					}

					const nextOptId = findStatusOption(
						fields,
						statusField.id,
						effectiveNextStatus,
					);
					if (!nextOptId) {
						ctx.ui.notify(
							`Cannot find '${effectiveNextStatus}' option on board.`,
							"warning",
						);
						break;
					}

					try {
						setItemStatus(loopItem.id, projectId, statusField.id, nextOptId);
						ctx.ui.notify(
							`Issue #${issueNum} moved: ${loopStatus} → ${effectiveNextStatus}`,
							"info",
						);
					} catch (err) {
						ctx.ui.notify(`Failed to update status: ${err instanceof Error ? err.message : String(err)}`, "error");
						break;
					}

					loopStatus = effectiveNextStatus;
				}

				// ── Post-pipeline: check for PR merge conflicts ──────
				if (loopStatus.toLowerCase() === "done") {
					const branch = generateBranchName(
						issueNum,
						issueTitle,
						config.branchPrefix!,
					);

					ctx.ui.setStatus("supervisor", "Checking PR for merge conflicts...");
					const conflictInfo = await checkPrConflicts(branch, config.repo);

					if (conflictInfo && conflictInfo.hasConflict) {
						ctx.ui.notify(
							`PR #${conflictInfo.number} has merge conflicts! (mergeable: ${conflictInfo.mergeable}, state: ${conflictInfo.mergeStateStatus})`,
							"warning",
						);

						const shouldFix = await ctx.ui.confirm(
							"Merge Conflict Detected",
							`PR #${conflictInfo.number} (${branch}) has merge conflicts with ${conflictInfo.baseRefName}. Should I fix them?`,
						);

						if (shouldFix) {
							const wt = `${config.worktreeBase}${branch}`;

							// Step 1: Try auto-merge
							ctx.ui.setStatus("supervisor", "Attempting auto-merge...");
							const mergeResult = tryAutoMerge(
								wt,
								branch,
								config.defaultBranch!,
								config.remote!,
							);

							if (mergeResult.success) {
								// Push the resolved merge
								try {
									execFileSync("git", ["push", config.remote!, branch], {
										cwd: wt,
										encoding: "utf-8",
										timeout: 30_000,
									});
									ctx.ui.notify(
										"Merge conflicts resolved and pushed!",
										"success",
									);
									pi.sendMessage({
										content: `## ✅ Merge Conflicts Resolved\n\nPR #${conflictInfo.number} conflicts were resolved automatically and pushed.`,
										display: true,
									});
								} catch (pushErr) {
									ctx.ui.notify(
										`Merge succeeded but push failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
										"error",
									);
								}
							} else {
								// Step 2: Auto-merge failed → dispatch developer agent
								ctx.ui.notify(
									`Auto-merge failed: ${mergeResult.message}. Dispatching developer to resolve...`,
									"warning",
								);

								const devAgentPath = `.pi/agents/developer.md`;
								if (existsSync(devAgentPath)) {
									try {
										const devAgent = parseAgentFile(devAgentPath);
										const devTask = [
											`## Task: Resolve Merge Conflicts`,
											``,
											`**Branch:** ${branch}`,
											`**Worktree:** ${wt}`,
											`**Base branch:** ${config.defaultBranch}`,
											`**Conflicted files:** ${mergeResult.conflictFiles.join(", ") || "(unknown)"}`,
											``,
											`### Steps`,
											`1. Enter worktree: \`cd ${wt}\``,
											`2. Fetch base: \`git fetch ${config.remote} ${config.defaultBranch}\``,
											`3. Merge base: \`git merge ${config.remote}/${config.defaultBranch}\``,
											`4. Resolve conflicts in the conflicted files`,
											`5. Stage resolved files: \`git add -A\``,
											`6. Commit merge: \`git commit -m "fix: resolve merge conflicts for PR #${conflictInfo.number}"\``,
											`7. Push: \`git push ${config.remote} ${branch}\``,
											``,
											`When done, output CONFLICTS_RESOLVED on its own line.`,
										].join("\n");

										const devTimeoutMs = resolveTimeoutMs(
											"developer",
											config.agentTimeoutsMin,
										);
										const devResult = await runAgent(
											devAgent,
											devTask,
											ctx,
											devTimeoutMs,
										);

										pi.sendMessage({
											customType: "supervisor",
											content: `## Conflict Resolution: ${devResult.agentName} — ${devResult.success ? "SUCCESS" : "FAILED"}\n\n${devResult.textOutput || devResult.summaryLine}`,
											display: true,
											details: {
												agentName: devResult.agentName,
												success: devResult.success,
												statusLabel: devResult.success
													? "SUCCESS"
													: "FAILED",
												toolCount: devResult.toolCount,
												tokenCount: devResult.tokenCount,
												durationMs: devResult.durationMs,
												textOutput: devResult.textOutput,
												summaryLine: devResult.summaryLine,
												thinkingOutput: devResult.thinkingOutput,
												hasThinking: !!devResult.thinkingOutput,
											},
										});

										if (devResult.success) {
											ctx.ui.notify(
												"Developer resolved merge conflicts successfully!",
												"success",
											);
										} else {
											ctx.ui.notify(
												"Developer failed to resolve conflicts. Manual intervention required.",
												"error",
											);
										}
									} catch (devErr) {
										ctx.ui.notify(
											`Failed to dispatch developer: ${devErr instanceof Error ? devErr.message : String(devErr)}`,
											"error",
										);
									}
								} else {
									ctx.ui.notify(
										"Developer agent not found. Cannot resolve conflicts automatically.",
										"error",
									);
								}
							}
						}
					} else if (conflictInfo) {
						ctx.ui.notify(
							`PR #${conflictInfo.number} has no merge conflicts (mergeable: ${conflictInfo.mergeable}).`,
							"info",
						);
					} else {
						ctx.ui.notify(
							"No PR found for this branch — skipping conflict check.",
							"info",
						);
					}
				}

				ctx.ui.setStatus("supervisor", "");
			} catch (err) {
				ctx.ui.notify(`Supervisor error: ${err instanceof Error ? err.message : String(err)}`, "error");
				ctx.ui.setStatus("supervisor", "");
			}
		},
	});
}
