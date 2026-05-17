// ─── GitHub Module ─────────────────────────────────────────────────
// All gh/ghJson/ghGraphQL, project board ops, dependency checks,
// PR conflict detection.

import type {
	ProjectField,
	ProjectItem,
	FilteredIssueData,
	DepsResult,
	PrConflictInfo,
	GhTimelineResponse,
} from "./types";
import { execFileSync } from "node:child_process";

// ─── Low-level gh CLI wrappers ──────────────────────────────────────

export function gh(args: string[]): string {
	try {
		return execFileSync("gh", args, {
			encoding: "utf-8",
			timeout: 30_000,
		}).trim();
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		const stderr =
			err instanceof Error && "stderr" in err && typeof (err as any).stderr?.toString === "function"
				? (err as any).stderr.toString()
				: msg;
		throw new Error(`gh ${args[0]} failed: ${stderr}`);
	}
}

export function ghJson(args: string[]): any {
	const output = gh(args);
	if (!output) return null;
	return JSON.parse(output);
}

export function ghGraphQL(query: string): any {
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

// ─── Project Board Operations ───────────────────────────────────────

export function getProjectFields(projectNumber: number): ProjectField[] {
	const resp = ghGraphQL(`{
		viewer {
			projectV2(number: ${projectNumber}) {
				fields(first: 10) {
					nodes {
						... on ProjectV2Field { id name dataType }
						... on ProjectV2SingleSelectField { id name dataType options { id name } }
						... on ProjectV2IterationField { id name dataType }
					}
				}
			}
		}
	}`);
	const nodes = resp?.data?.viewer?.projectV2?.fields?.nodes || [];
	return nodes.map((n: any) => ({
		id: n.id,
		name: n.name,
		type: n.dataType || "UNKNOWN",
		options: n.options || undefined,
	}));
}

export function getProjectItems(projectNumber: number): ProjectItem[] {
	const resp = ghGraphQL(`{
		viewer {
			projectV2(number: ${projectNumber}) {
				items(first: 100) {
					nodes {
						id
						content {
							... on Issue { number url }
							... on PullRequest { number url }
						}
						fieldValues(first: 20) {
							nodes {
								... on ProjectV2ItemFieldSingleSelectValue {
									name
									field { ... on ProjectV2FieldCommon { id name } }
								}
								... on ProjectV2ItemFieldTextValue {
									text
									field { ... on ProjectV2FieldCommon { id name } }
								}
							}
						}
					}
				}
			}
		}
	}`);
	const nodes = resp?.data?.viewer?.projectV2?.items?.nodes || [];
	return nodes.map((n: any) => {
		const fieldNodes: any[] = n.fieldValues?.nodes || [];
		let status: string | undefined;
		const fv: Array<{ fieldId: string; value: string; optionId?: string }> = [];
		for (const f of fieldNodes) {
			if (f.name && f.field?.name?.toLowerCase() === "status") {
				status = f.name;
			}
			if (f.field?.id) {
				fv.push({
					fieldId: f.field.id,
					value: f.name || f.text || "",
					optionId: undefined,
				});
			}
		}
		return {
			id: n.id,
			status,
			content: n.content
				? {
						url: n.content.url,
						number: n.content.number,
					}
				: undefined,
			fieldValues: fv.length > 0 ? fv : undefined,
		};
	});
}

export function getProjectId(projectNumber: number): string {
	const resp = ghGraphQL(`{
		viewer {
			projectV2(number: ${projectNumber}) {
				id
			}
		}
	}`);
	return resp?.data?.viewer?.projectV2?.id || "";
}

export function findIssueItem(items: ProjectItem[], issueNumber: number): ProjectItem | null {
	for (const item of items) {
		if (item.content?.number === issueNumber) return item;
		const url = item.content?.url || "";
		if (url.includes(`/issues/${issueNumber}`) || url.includes(`/pull/${issueNumber}`)) return item;
	}
	return null;
}

export function getItemStatusName(item: ProjectItem): string {
	return item.status || "Unknown";
}

export function findStatusOption(
	fields: ProjectField[],
	statusFieldId: string,
	statusName: string,
): string | null {
	const field = fields.find((f) => f.id === statusFieldId);
	if (!field?.options) return null;
	const option = field.options.find((o) => o.name.toLowerCase() === statusName.toLowerCase());
	return option?.id || null;
}

export function setItemStatus(
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

// ─── Dependency Gate ("blocked by" links) ──────────────────────────

function parseTimelineResponse(response: GhTimelineResponse | null): DepsResult {
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

	const blockers: DepsResult["blockers"] = [];
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

export async function checkBlockedByDependencies(
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
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to query GitHub for dependencies: ${msg}`);
	}

	return parseTimelineResponse(response);
}

// ─── PR Conflict Detection ──────────────────────────────────────────

export async function checkPrConflicts(
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
			return null;
		}
		const pr = result[0];
		return {
			number: pr.number,
			hasConflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
			mergeable: pr.mergeable || "UNKNOWN",
			mergeStateStatus: pr.mergeStateStatus || "UNKNOWN",
			headRefName: pr.headRefName,
			baseRefName: pr.baseRefName,
		};
	} catch {
		return null;
	}
}

// ─── Security: Filter Issue Data ────────────────────────────────────

/** Filter issue body and comments to only trusted codeowners.
 *  This is enforced in code — NOT via LLM prompt — to prevent prompt injection. */
export function filterIssueData(rawIssue: any, codeowners: string[]): FilteredIssueData {
	const issueAuthor: string = rawIssue?.author?.login || "";
	const isIssueAuthorTrusted = codeowners.includes(issueAuthor);

	const body = isIssueAuthorTrusted
		? rawIssue?.body || "(no body)"
		: `[Issue body hidden — author @${issueAuthor} is not a trusted codeowner]`;

	const rawComments: any[] = rawIssue?.comments || [];
	const trustedComments = rawComments
		.filter((c: any) => {
			const commentAuthor: string = c?.author?.login || "";
			return codeowners.includes(commentAuthor);
		})
		.map((c: any) => ({
			author: c?.author?.login || "unknown",
			body: c?.body || "",
		}));

	return { body, comments: trustedComments };
}
