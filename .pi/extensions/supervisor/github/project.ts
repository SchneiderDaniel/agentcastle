// ─── Project Board Operations ─────────────────────────────────────
// getProjectFields, getProjectItems, getProjectId, findIssueItem,
// getItemStatusName, findStatusOption, setItemStatus.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProjectField, ProjectItem } from "../types.ts";
import { ghGraphQL, gh } from "./gh-client.ts";
import type { ProjectFieldsResponse, ProjectItemsResponse, ProjectIdResponse } from "./types.ts";

// ─── Get Project Fields ───────────────────────────────────────────

export async function getProjectFields(
	pi: ExtensionAPI,
	projectNumber: number,
): Promise<ProjectField[]> {
	const resp = await ghGraphQL<ProjectFieldsResponse>(
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
	return nodes.map((n) => ({
		id: n.id,
		name: n.name,
		type: n.dataType || "UNKNOWN",
		options: n.options || undefined,
	}));
}

// ─── Get Project Items (paginated) ────────────────────────────────

export async function getProjectItems(
	pi: ExtensionAPI,
	projectNumber: number,
): Promise<ProjectItem[]> {
	const allItems: ProjectItem[] = [];
	let after: string | null = null;
	let hasNextPage = true;

	while (hasNextPage) {
		const afterArg: string = after ? `, after: "${after}"` : "";
		const resp = await ghGraphQL<ProjectItemsResponse>(
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
		const page:
			| {
					pageInfo: { hasNextPage: boolean; endCursor: string | null };
					nodes?: Array<{
						id: string;
						content?: { url?: string; number?: number };
						fieldValues?: {
							nodes?: Array<{
								name?: string;
								text?: string;
								field?: { id: string; name: string };
							}>;
						};
					}>;
			  }
			| undefined = resp?.data?.viewer?.projectV2?.items;
		const nodes = page?.nodes || [];
		for (const n of nodes) {
			const fieldNodes = n.fieldValues?.nodes || [];
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

// ─── Get Project ID ───────────────────────────────────────────────

export async function getProjectId(pi: ExtensionAPI, projectNumber: number): Promise<string> {
	const resp = await ghGraphQL<ProjectIdResponse>(
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

// ─── Find Issue Item ──────────────────────────────────────────────

export function findIssueItem(items: ProjectItem[], issueNumber: number): ProjectItem | null {
	for (const item of items) {
		if (item.content?.number === issueNumber) return item;
		const url = item.content?.url || "";
		if (url.includes(`/issues/${issueNumber}`) || url.includes(`/pull/${issueNumber}`)) return item;
	}
	return null;
}

// ─── Get Item Status Name ─────────────────────────────────────────

export function getItemStatusName(item: ProjectItem): string {
	return item.status || "Unknown";
}

// ─── Find Status Option ───────────────────────────────────────────

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

// ─── Set Item Status ──────────────────────────────────────────────

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
