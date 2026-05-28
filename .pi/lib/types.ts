/**
 * Shared types for .pi/extensions/
 *
 * Eliminates duplication of onUpdate callback signatures,
 * tool result shapes, and common utility types across extensions.
 */

// ─── Tool result types ───────────────────────────────────────────────

/** Tool result details — use this instead of empty `{}` type */
export type ToolResultDetails = Record<string, unknown>;

/** Standard content block in tool results */
export interface ContentBlock {
	type: "text";
	text: string;
}

/** Standard tool result shape */
export interface ToolResult {
	content: ContentBlock[];
	details: ToolResultDetails;
}

// ─── Callback types ──────────────────────────────────────────────────

/** Update callback signature for extensions */
export type OnUpdateCallback = (update: { content: ContentBlock[]; details: unknown }) => void;

// ─── Extension init ──────────────────────────────────────────────────

/** Extension default export signature */
export type ExtensionInit = (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;

// ─── Utility type guards ─────────────────────────────────────────────

/** Check if value is a non-null object */
export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check if value is a text content block */
export function isTextBlock(value: unknown): value is ContentBlock {
	return isObject(value) && value.type === "text" && typeof value.text === "string";
}

/** Extract text from content blocks or string */
export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is ContentBlock => isTextBlock(b))
		.map((b) => b.text)
		.join("\n");
}
