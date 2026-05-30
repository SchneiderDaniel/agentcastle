// ─── Config: loading, validation, timeout resolution ──────────────

import type { SupervisorConfig } from "./types";
import { readFileSync, existsSync } from "node:fs";

// ─── Constants ──────────────────────────────────────────────────────

/** Default agent timeout in milliseconds (30 minutes). */
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parse .gitmodules into submodule entries. Only returns entries with GitHub URLs. */
function parseGitmodules(): Array<{ path: string; repo: string }> {
	const gitmodulesPath = ".gitmodules";
	if (!existsSync(gitmodulesPath)) return [];
	const content = readFileSync(gitmodulesPath, "utf-8");
	const subs: Array<{ path: string; repo: string }> = [];
	const sectionRe = /\[submodule\s+"(.+?)"\]/g;
	let match: RegExpExecArray | null;
	while ((match = sectionRe.exec(content)) !== null) {
		const name = match[1];
		const sectionStart = match.index + match[0].length;
		const nextSection = content.indexOf("[", sectionStart);
		const sectionBody =
			nextSection === -1 ? content.slice(sectionStart) : content.slice(sectionStart, nextSection);
		const pathMatch = sectionBody.match(/^\s*path\s*=\s*(.+)$/m);
		const urlMatch = sectionBody.match(/^\s*url\s*=\s*(.+)$/m);
		if (!pathMatch || !urlMatch) continue;
		const path = pathMatch[1].trim();
		const url = urlMatch[1].trim();
		const ghMatch = url.match(/github\.com[/:](.+?)\/(.+?)(?:\.git)?$/);
		if (!ghMatch) continue;
		const repo = `${ghMatch[1]}/${ghMatch[2]}`;
		subs.push({ path, repo });
	}
	return subs;
}

// ─── Config loading ──────────────────────────────────────────────────

export function loadConfig(): SupervisorConfig {
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) {
		throw new Error("No .pi/settings.json found. Add a 'supervisor' key.");
	}
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	const cfg = settings.supervisor;
	if (!cfg) throw new Error("No 'supervisor' key in .pi/settings.json.");
	if (!cfg.repo) throw new Error("supervisor.repo is required.");
	if (!cfg.projectNumber) throw new Error("supervisor.projectNumber is required.");
	if (!cfg.statusMapping || Object.keys(cfg.statusMapping).length === 0) {
		throw new Error("supervisor.statusMapping is required.");
	}
	const codeowners: string[] = Array.isArray(cfg.codeowners) ? cfg.codeowners : [];
	if (codeowners.length === 0) {
		throw new Error("supervisor.codeowners must be a non-empty list of trusted GitHub usernames.");
	}
	let submodules: Array<{ path: string; repo: string }>;
	if (Array.isArray(cfg.submodules) && cfg.submodules.length > 0) {
		submodules = cfg.submodules;
	} else {
		submodules = parseGitmodules();
	}
	const knownAgents = Object.values(cfg.statusMapping) as string[];
	const agentTimeoutsMin = validateAgentTimeouts(cfg.agentTimeoutsMin, knownAgents);

	// Validate agentTokenBudget (optional, non-negative integer)
	const agentTokenBudget = cfg.agentTokenBudget;
	if (agentTokenBudget !== undefined) {
		if (
			typeof agentTokenBudget !== "number" ||
			!Number.isInteger(agentTokenBudget) ||
			agentTokenBudget < 0
		) {
			throw new Error("supervisor.agentTokenBudget must be a non-negative integer");
		}
	}

	// Validate maxToolCalls (optional, non-negative integer)
	const maxToolCalls = cfg.maxToolCalls;
	if (maxToolCalls !== undefined) {
		if (typeof maxToolCalls !== "number" || !Number.isInteger(maxToolCalls) || maxToolCalls < 0) {
			throw new Error("supervisor.maxToolCalls must be a non-negative integer");
		}
	}

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
		ciGatingTimeoutSec: cfg.ciGatingTimeoutSec ?? 300,
		bellOnComplete: cfg.bellOnComplete ?? false,
		agentTokenBudget: agentTokenBudget,
		maxToolCalls: maxToolCalls,
	};
}

// ─── Timeout validation ──────────────────────────────────────────────

/**
 * Validate the raw agentTimeoutsMin config value.
 * Returns a sanitized Record<string, number>.
 */
export function validateAgentTimeouts(raw: unknown, knownAgents: string[]): Record<string, number> {
	if (raw === undefined || raw === null) {
		return {};
	}
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		throw new Error(`agentTimeoutsMin must be an object, got ${typeof raw}`);
	}
	const record = raw as Record<string, unknown>;
	const result: Record<string, number> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!knownAgents.includes(key)) {
			console.warn(`agentTimeoutsMin: unknown agent "${key}" — entry ignored`);
			continue;
		}
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
