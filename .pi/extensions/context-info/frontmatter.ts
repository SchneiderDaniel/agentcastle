/**
 * Frontmatter extraction utility for context-info
 *
 * Extracts `description:` field from YAML frontmatter in markdown files.
 * Pure function — no I/O, no dependencies.
 *
 * Domain layer — owns regex internals. Zero framework imports.
 */

// ─── Constants ────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const DESCR_RE = /^description:\s*(.+)$/m;

// ─── Extraction ───────────────────────────────────────────────────

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
