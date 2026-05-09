/**
 * Dependency gate for the supervisor pipeline.
 *
 * Queries GitHub GraphQL API for "blocked by" issue links on an issue.
 * Uses BLOCKED_BY_ADDED_EVENT / BLOCKED_BY_REMOVED_EVENT timeline events
 * to determine which blocking items are still unresolved.
 *
 * If any blocking item is unresolved, the supervisor pipeline is gated
 * and must not proceed.
 *
 * Extracted from supervisor.ts to keep the file testable without TUI imports.
 */

import { execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────

export interface BlockerInfo {
	/** GitHub issue/PR number */
	number: number;
	/** Title of the blocking item */
	title: string;
	/** "issue" or "pullrequest" */
	type: "issue" | "pullrequest";
	/** GitHub state: OPEN, CLOSED, MERGED */
	state: string;
}

export interface DepsResult {
	/** True if at least one unresolved blocker exists */
	blocked: boolean;
	/** List of unresolved blocking items */
	blockers: BlockerInfo[];
}

// ─── GraphQL response shapes ─────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────

function gh(args: string[]): string {
	try {
		return execSync(`gh ${args.join(" ")}`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
		}).trim();
	} catch (err: any) {
		const stderr = err.stderr?.toString() || err.message;
		throw new Error(`gh ${args[0]} failed: ${stderr}`);
	}
}

function ghGraphQL(query: string): any {
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

// ─── Core ────────────────────────────────────────────────────────────

/**
 * Parse a GitHub GraphQL timeline response into a DepsResult.
 * Pure function — no side effects, no network calls.
 *
 * Exported for unit testing.
 */
export function parseTimelineResponse(
	response: GhTimelineResponse | null,
): DepsResult {
	// Check for GraphQL-level errors (bad token scope, etc.)
	if (response?.errors && response.errors.length > 0) {
		const msgs = response.errors.map((e) => e.message).join("; ");
		throw new Error(`GitHub GraphQL error: ${msgs}`);
	}

	const nodes = response?.data?.repository?.issue?.timelineItems?.nodes;
	if (!nodes || nodes.length === 0) {
		return { blocked: false, blockers: [] };
	}

	// Build a Map<blockingIssue.id, lastEventType> — only the most recent
	// event per blocking issue wins. Iterate in order; later events overwrite.
	const lastEventByIssue = new Map<string, string>();

	for (const node of nodes) {
		const blockingId = node?.blockingIssue?.id;
		if (!blockingId) continue; // deleted / null issue → skip
		lastEventByIssue.set(blockingId, node.__typename);
	}

	// Collect blocking issues whose last event is BlockedByAddedEvent
	const blockers: BlockerInfo[] = [];
	const seenNumbers = new Set<number>();

	for (const node of nodes) {
		const issue = node.blockingIssue;
		if (!issue) continue;

		const lastEvent = lastEventByIssue.get(issue.id);
		if (lastEvent !== "BlockedByAddedEvent") continue;

		// Only process each blocking issue once (first occurrence wins for data)
		if (seenNumbers.has(issue.number)) continue;
		seenNumbers.add(issue.number);

		const state = issue.state || "UNKNOWN";

		// Issue: resolved only if CLOSED
		if (state === "CLOSED") continue; // resolved → skip

		// Still blocking
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

/**
 * Check whether the given GitHub issue has any unresolved "blocked by"
 * dependencies.  Queries the issue timeline for BLOCKED_BY_ADDED_EVENT
 * and BLOCKED_BY_REMOVED_EVENT nodes, keeps only the latest event per
 * blocking issue, and classifies each as resolved or blocking.
 *
 * @param issueNumber - GitHub issue number
 * @param repo - owner/name string (e.g. "SchneiderDaniel/agentcastle")
 * @returns {blocked, blockers} — if blocked is true the pipeline must stop
 */
export async function checkBlockedByDependencies(
	issueNumber: number,
	repo: string,
): Promise<DepsResult> {
	const [owner, name] = repo.split("/");
	if (!owner || !name) {
		throw new Error(`Invalid repo format: ${repo} (expected owner/name)`);
	}

	// Single GraphQL round-trip — query last 100 timeline blocking events
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
	} catch (err: any) {
		throw new Error(`Failed to query GitHub for dependencies: ${err.message}`);
	}

	return parseTimelineResponse(response);
}
