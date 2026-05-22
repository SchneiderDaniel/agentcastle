/**
 * Skill enumeration and metadata extraction for context-info
 *
 * Provides listLocalSkills() used by welcome banner and /explain-skills command.
 * Reads description from YAML frontmatter (`description:` field) of SKILL.md files
 * in .pi/skills/ directories. Falls back to first content line if no frontmatter found.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join as joinPath } from "node:path";

// ─── Types ────────────────────────────────────────────────────────

export interface SkillMeta {
	name: string;
	filePath: string;
	description: string | null;
}

// ─── Frontmatter extraction ───────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const DESCR_RE = /^description:\s*(.+)$/m;

/**
 * Extract description from YAML frontmatter `description:` field.
 * Scans only first 30 lines. Returns null if no frontmatter or no description key.
 */
function extractDescription(content: string): string | null {
	const head = content.split("\n").slice(0, 30).join("\n");
	const fmMatch = FRONTMATTER_RE.exec(head);
	if (!fmMatch) return null;
	const descMatch = DESCR_RE.exec(fmMatch[1]);
	return descMatch ? descMatch[1]!.trim() : null;
}

// ─── Skill enumeration ────────────────────────────────────────────

/**
 * Count project-local skills in .pi/skills/.
 */
export function countSkills(): number {
	try {
		const skillsDir = ".pi/skills";
		if (!existsSync(skillsDir)) return 0;
		const entries = readdirSync(skillsDir, { withFileTypes: true });
		let count = 0;
		for (const entry of entries) {
			if (entry.name === ".gitkeep") continue;
			if (entry.isFile() && entry.name.endsWith(".md")) {
				count++;
			} else if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
				const skillMdPath = joinPath(skillsDir, entry.name, "SKILL.md");
				if (existsSync(skillMdPath)) count++;
			}
		}
		return count;
	} catch {
		return 0;
	}
}

/**
 * List all project-local skills with metadata.
 * Walks .pi/skills/ for directories containing SKILL.md or standalone .md files.
 * Returns sorted by name.
 */
export function listLocalSkills(): SkillMeta[] {
	const skillsDir = ".pi/skills";
	try {
		if (!existsSync(skillsDir)) return [];
		const entries = readdirSync(skillsDir, { withFileTypes: true });
		const result: SkillMeta[] = [];

		for (const entry of entries) {
			if (entry.name === ".gitkeep") continue;
			if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
				const skillMdPath = joinPath(skillsDir, entry.name, "SKILL.md");
				if (!existsSync(skillMdPath)) continue;
				try {
					const content = readFileSync(skillMdPath, "utf-8");
					const description = extractDescription(content);
					result.push({
						name: entry.name,
						filePath: skillMdPath,
						description,
					});
				} catch {
					// skip unreadable files
				}
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				const filePath = joinPath(skillsDir, entry.name);
				try {
					const content = readFileSync(filePath, "utf-8");
					const description = extractDescription(content);
					const name = entry.name.replace(/\.md$/, "");
					result.push({ name, filePath, description });
				} catch {
					// skip unreadable files
				}
			}
		}

		return result.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}
}
