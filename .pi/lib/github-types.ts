/**
 * GitHub API types for supervisor extension
 *
 * Top-level shapes returned by `gh project`, `gh issue`, etc.
 * Used by supervisor.ts for typed GitHub API responses.
 */

import { isObject } from "./types.ts";

// ─── GitHub Issue ────────────────────────────────────────────────────

export interface GhIssue {
	number: number;
	title: string;
	body: string;
	state: string;
	url: string;
	author?: { login: string };
	labels?: Array<{ name: string }>;
	comments?: GhComment[];
}

export interface GhComment {
	id: number;
	author: { login: string };
	body: string;
	createdAt: string;
	url?: string;
}

// ─── GitHub Project V2 ───────────────────────────────────────────────

export interface GhProjectField {
	id: string;
	name: string;
	type: string;
	options?: Array<{ id: string; name: string }>;
}

export interface GhProjectItem {
	id: string;
	status?: string;
	content?: { url?: string; number?: number };
	fieldValues?: Array<{ fieldId: string; value: string; optionId?: string }>;
}

export interface GhTimelineEvent {
	__typename: string;
	createdAt: string;
	actor?: { login: string };
	// Cross-referenced event
	source?: {
		__typename: string;
		number?: number;
		title?: string;
		url?: string;
	};
	// LabeledEvent
	label?: { name: string };
	// UnlabeledEvent
	// AddedToProjectEvent
	project?: { title: string };
	projectColumnName?: string;
}

// ─── Type guards ─────────────────────────────────────────────────────

export function isGhIssue(obj: unknown): obj is GhIssue {
	return isObject(obj) && typeof obj.number === "number" && typeof obj.title === "string";
}

export function isGhComment(obj: unknown): obj is GhComment {
	return (
		isObject(obj) &&
		typeof obj.id === "number" &&
		isObject(obj.author) &&
		typeof obj.author.login === "string"
	);
}

export function isGhProjectField(obj: unknown): obj is GhProjectField {
	return isObject(obj) && typeof obj.id === "string" && typeof obj.name === "string";
}

export function isGhProjectItem(obj: unknown): obj is GhProjectItem {
	return isObject(obj) && typeof obj.id === "string";
}

export function isGhTimelineEvent(obj: unknown): obj is GhTimelineEvent {
	return isObject(obj) && typeof obj.__typename === "string" && typeof obj.createdAt === "string";
}
