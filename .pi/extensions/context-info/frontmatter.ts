/**
 * Shared frontmatter extraction for context-info
 *
 * Pure functions — no pi dependency, testable without any infra.
 * Used by prompts.ts and skills.ts to extract description from YAML frontmatter.
 */

// ─── Frontmatter extraction ───────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const DESCR_RE = /^description:\s*(.+)$/m;

/**
 * Extract description from YAML frontmatter `description:` field.
 * Scans only first 30 lines. Returns null if no frontmatter or no description key.
 */
export function extractDescription(content: string): string | null {
	const head = content.split("\n").slice(0, 30).join("\n");
	const fmMatch = FRONTMATTER_RE.exec(head);
	if (!fmMatch) return null;
	const descMatch = DESCR_RE.exec(fmMatch[1]);
	return descMatch ? descMatch[1]!.trim() : null;
}
