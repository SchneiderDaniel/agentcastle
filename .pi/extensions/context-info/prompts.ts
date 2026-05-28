/**
 * Prompt enumeration and metadata extraction for context-info
 *
 * Provides listLocalPrompts() used by welcome banner and /explain-prompts command.
 * Reads description from YAML frontmatter (`description:` field) of .md files in .pi/prompts/.
 * Falls back to first content line if no frontmatter found.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { extractDescription } from "./frontmatter.js";

// ─── Types ────────────────────────────────────────────────────────

export interface PromptMeta {
	name: string;
	filePath: string;
	description: string | null;
}

// ─── Prompt enumeration ───────────────────────────────────────────

/**
 * List all prompt markdown files in .pi/prompts/ with metadata.
 * Recursively walks subdirectories. Returns sorted by name.
 */
export function listLocalPrompts(): PromptMeta[] {
	const promptDir = ".pi/prompts";
	try {
		if (!existsSync(promptDir)) return [];
		const entries = readdirSync(promptDir, { withFileTypes: true });

		const result: PromptMeta[] = [];
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
				// Recurse into subdirectories
				const subDir = joinPath(promptDir, entry.name);
				try {
					const subEntries = readdirSync(subDir, { withFileTypes: true });
					for (const sub of subEntries) {
						if (sub.isFile() && sub.name.endsWith(".md")) {
							const filePath = joinPath(subDir, sub.name);
							const content = readFileSync(filePath, "utf-8");
							const description = extractDescription(content);
							const name = sub.name.replace(/\.md$/, "");
							result.push({ name, filePath, description });
						}
					}
				} catch {
					// skip unreadable subdirectories
				}
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const filePath = joinPath(promptDir, entry.name);
				const content = readFileSync(filePath, "utf-8");
				const description = extractDescription(content);
				const name = entry.name.replace(/\.md$/, "");
				result.push({ name, filePath, description });
			}
		}

		return result.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}
