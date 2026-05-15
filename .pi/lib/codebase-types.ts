/**
 * Codebase Memory types for codebase-memory.ts
 *
 * Typed interfaces for the codebase-memory-mcp bridge protocol.
 * Replaces pervasive `any` usage in tool handlers.
 */

import { isObject } from "./types.js";

// ─── CLI response shapes ─────────────────────────────────────────────

export interface CbmCliResult {
	ok: boolean;
	data: unknown;
	error?: string;
}

// ─── Search / query result types ─────────────────────────────────────

export interface SearchResult {
	name: string;
	file: string;
	line?: number;
	column?: number;
	kind: string;
	detail?: string;
	score?: number;
}

export interface TraceResult {
	callers: Array<{ name: string; file: string; line: number }>;
	callees: Array<{ name: string; file: string; line: number }>;
}

export interface SchemaResult {
	nodes: number;
	edges: number;
	labels: string[];
	relationshipTypes: string[];
}

export interface AdrResult {
	id: string;
	title: string;
	status: string;
	context?: string;
	decision?: string;
	consequences?: string;
}

export interface CodeSnippet {
	name: string;
	file: string;
	startLine: number;
	endLine: number;
	code: string;
	language: string;
}

export interface GraphQueryResult {
	rows: Array<Record<string, unknown>>;
	columns: string[];
}

export interface ProjectInfo {
	name: string;
	path: string;
	indexed: boolean;
	nodeCount?: number;
	edgeCount?: number;
}

// ─── Type guards ─────────────────────────────────────────────────────

export function isSearchResult(obj: unknown): obj is SearchResult {
	return isObject(obj) && typeof obj.name === "string" && typeof obj.file === "string";
}

export function isSearchResultArray(obj: unknown): obj is SearchResult[] {
	return Array.isArray(obj) && obj.every(isSearchResult);
}

export function isTraceResult(obj: unknown): obj is TraceResult {
	return isObject(obj) && Array.isArray(obj.callers) && Array.isArray(obj.callees);
}

export function isSchemaResult(obj: unknown): obj is SchemaResult {
	return isObject(obj) && typeof obj.nodes === "number" && Array.isArray(obj.labels);
}

export function isProjectInfo(obj: unknown): obj is ProjectInfo {
	return isObject(obj) && typeof obj.name === "string";
}

// ─── Tool set: heavy operations (default light for unknown tools) ────

/** Heavy tools that need longer timeouts */
export const HEAVY_TOOLS = new Set([
	"index_repository", "get_architecture",
	"detect_changes", "semantic_query",
	"manage_adr", "ingest_traces",
]);

/** Light timeout (most ops) */
export const QUERY_TIMEOUT = 10_000;
/** Heavy timeout (indexing, architecture) */
export const HEAVY_TIMEOUT = 120_000;
