// ─── GitHub Module ─────────────────────────────────────────────────
// All gh/ghJson/ghGraphQL, project board ops, dependency checks,
// PR conflict detection.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	ProjectField,
	ProjectItem,
	FilteredIssueData,
	DepsResult,
	PrConflictInfo,
	GhTimelineResponse,
} from "./types";

// ─── Low-level gh CLI wrappers ──────────────────────────────────────

export async function gh(
	pi: ExtensionAPI,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string> {
	const result = await pi.exec("gh", args, {
		signal: opts?.signal,
		timeout: opts?.timeout ?? 30_000,
	});
	if (result.code !== 0) {
		throw new Error(`gh ${args[0]} failed: ${result.stderr || result.stdout}`);
	}
	return (result.stdout || "").trim();
}

export async function ghJson(
	pi: ExtensionAPI,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<any> {
	const output = await gh(pi, args, opts);
	if (!output) return null;
	return JSON.parse(output);
}

export async function ghGraphQL(
	pi: ExtensionAPI,
	query: string,
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<any> {
	const result = await gh(
		pi,
		["api", "graphql", "--header", "Accept: application/vnd.github+json", "-f", `query=${query}`],
		opts,
	);
	if (!result) return null;
	return JSON.parse(result);
}

// ─── Project Board Operations ───────────────────────────────────────

export async function getProjectFields(
	pi: ExtensionAPI,
	projectNumber: number,
): Promise<ProjectField[]> {
	const resp = await ghGraphQL(
		pi,
		`{
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
	}`,
	);
	const nodes = resp?.data?.viewer?.projectV2?.fields?.nodes || [];
	return nodes.map((n: any) => ({
		id: n.id,
		name: n.name,
		type: n.dataType || "UNKNOWN",
		options: n.options || undefined,
	}));
}

export async function getProjectItems(
	pi: ExtensionAPI,
	projectNumber: number,
): Promise<ProjectItem[]> {
	const allItems: ProjectItem[] = [];
	let after: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const afterArg = after ? `, after: "${after}"` : "";
		const resp = await ghGraphQL(
			pi,
			`{
			viewer {
				projectV2(number: ${projectNumber}) {
					items(first: 100${afterArg}) {
						pageInfo {
							hasNextPage
							endCursor
						}
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
		}`,
		);
		const page = resp?.data?.viewer?.projectV2?.items;
		const nodes = page?.nodes || [];
		for (const n of nodes) {
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
			allItems.push({
				id: n.id,
				status,
				content: n.content
					? {
							url: n.content.url,
							number: n.content.number,
						}
					: undefined,
				fieldValues: fv.length > 0 ? fv : undefined,
			});
		}
		hasNextPage = page?.pageInfo?.hasNextPage ?? false;
		after = page?.pageInfo?.endCursor ?? null;
	}

	return allItems;
}

export async function getProjectId(pi: ExtensionAPI, projectNumber: number): Promise<string> {
	const resp = await ghGraphQL(
		pi,
		`{
		viewer {
			projectV2(number: ${projectNumber}) {
				id
			}
		}
	}`,
	);
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

export async function setItemStatus(
	pi: ExtensionAPI,
	itemId: string,
	projectId: string,
	fieldId: string,
	optionId: string,
): Promise<void> {
	await gh(pi, [
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
	pi: ExtensionAPI,
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
		response = (await ghGraphQL(pi, query)) as GhTimelineResponse;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to query GitHub for dependencies: ${msg}`);
	}

	return parseTimelineResponse(response);
}

// ─── PR Conflict Detection ──────────────────────────────────────────

export async function checkPrConflicts(
	pi: ExtensionAPI,
	branch: string,
	repo: string,
): Promise<PrConflictInfo | null> {
	try {
		const result = await ghJson(pi, [
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

// ─── Post GitHub Issue Comment ─────────────────────────────────────

/** Post a comment on a GitHub issue.
 *  Uses authenticated gh CLI — respects same auth session as other gh calls. */
export async function postIssueComment(
	pi: ExtensionAPI,
	issueNum: number,
	repo: string,
	body: string,
): Promise<void> {
	await gh(pi, ["issue", "comment", String(issueNum), "--repo", repo, "--body", body]);
}

// ─── Deterministic git/GitHub helpers (Phase 1) ────────────────────

/** Commit staged changes in a working directory.
 *  Throws if git commit fails (nothing to commit, merge conflict, etc). */
export async function commitChanges(pi: ExtensionAPI, cwd: string, message: string): Promise<void> {
	const result = await pi.exec("git", ["commit", "-m", message], { cwd });
	if (result.code !== 0) {
		throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
	}
}

/** Push a branch to a remote.
 *  Throws if git push fails (auth failed, rejected, no remote). */
export async function pushBranch(
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
): Promise<void> {
	const result = await pi.exec("git", ["push", remote, branch], { cwd });
	if (result.code !== 0) {
		throw new Error(`git push failed: ${result.stderr || result.stdout}`);
	}
}

/** Add all, commit, and push in sequence.
 *  Pushes even if commit fails with "nothing to commit" (dev already committed). */
export async function commitAndPush(
	pi: ExtensionAPI,
	cwd: string,
	remote: string,
	branch: string,
	message: string,
): Promise<void> {
	// Stage all changes first
	const addResult = await pi.exec("git", ["add", "-A"], { cwd });
	if (addResult.code !== 0) {
		throw new Error(`git add failed: ${addResult.stderr || addResult.stdout}`);
	}
	// Try commit — skip on "nothing to commit" (dev already committed)
	const commitResult = await pi.exec("git", ["commit", "-m", message], { cwd });
	if (commitResult.code !== 0) {
		const output = (commitResult.stderr || "") + (commitResult.stdout || "");
		// "nothing to commit" is not a real error — still push
		if (!output.includes("nothing to commit")) {
			throw new Error(`git commit failed: ${output.trim()}`);
		}
	}
	await pushBranch(pi, cwd, remote, branch);
}

/** Create a pull request using gh CLI.
 *  Returns PR number from output.
 *  If bodyFile is provided, uses --body-file flag (avoids shell escaping issues). */
export async function createPullRequest(
	pi: ExtensionAPI,
	repo: string,
	base: string,
	head: string,
	title: string,
	bodyFile?: string,
): Promise<{ number: number }> {
	const args: string[] = [
		"pr",
		"create",
		"--repo",
		repo,
		"--base",
		base,
		"--head",
		head,
		"--title",
		title,
	];
	if (bodyFile) {
		args.push("--body-file", bodyFile);
	}
	const result = await gh(pi, args);
	// gh pr create outputs URL like https://github.com/owner/repo/pull/123
	// or sometimes just the number "123"
	const urlMatch = result.match(/pull\/(\d+)/);
	if (urlMatch) {
		return { number: parseInt(urlMatch[1], 10) };
	}
	const numMatch = result.match(/(\d+)/);
	if (numMatch) {
		return { number: parseInt(numMatch[1], 10) };
	}
	throw new Error(`gh pr create failed to parse PR number from output: ${result}`);
}

// ─── Structured agent output parsing (Phase 2+3) ──────────────────

/** Parse structured audit output from auditor agent.
 *  Looks for AUDIT_DECISION, PR_TITLE, PR_BODY, COMMENT_BODY markers.
 *  Last occurrence of each marker wins. */
export interface StructuredAuditOutput {
	decision: "APPROVED" | "REJECTED";
	prTitle?: string;
	prBody?: string;
	commentBody?: string;
}

export function extractStructuredAuditOutput(output: string): StructuredAuditOutput | null {
	const decisionMatch = output.match(/AUDIT_DECISION\s*:\s*(APPROVED|REJECTED)/g);
	if (!decisionMatch) return null;

	const lastDecision = decisionMatch[decisionMatch.length - 1];
	const decision = lastDecision.includes("APPROVED")
		? ("APPROVED" as const)
		: ("REJECTED" as const);

	const result: StructuredAuditOutput = { decision };

	// Extract PR_TITLE (last occurrence)
	const prTitleMatch = output.match(/PR_TITLE\s*:\s*(.+)$/gm);
	if (prTitleMatch) {
		result.prTitle = prTitleMatch[prTitleMatch.length - 1].replace(/^PR_TITLE\s*:\s*/i, "").trim();
	}

	// Extract PR_BODY (text between PR_BODY: and next marker or end)
	const prBodyMatch = output.match(/PR_BODY\s*:\s*([\s\S]*?)(?=\n[A-Z_]+\s*:|$)/);
	if (prBodyMatch) {
		result.prBody = prBodyMatch[1].trim();
	}

	// Extract COMMENT_BODY (text between COMMENT_BODY: and next marker or end)
	const commentBodyMatch = output.match(/COMMENT_BODY\s*:\s*([\s\S]*?)(?=\n[A-Z_]+\s*:|$)/);
	if (commentBodyMatch) {
		result.commentBody = commentBodyMatch[1].trim();
	}

	return result;
}

/** Extract agent comment body from text after COMMENT_BODY marker.
 *  Last occurrence wins. Returns null if no marker found. */
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
