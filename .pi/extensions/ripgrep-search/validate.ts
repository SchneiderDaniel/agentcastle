/**
 * Query validation for ripgrep-search.
 *
 * Pure function — no dependencies on pi SDK or other modules.
 * Enforces collision rules to prevent misuse of ripgrep_search
 * for structural/symbol searches that belong to other tools.
 */

/**
 * Validate that a query is suitable for ripgrep (literal/regex text search)
 * rather than structural/syntax-aware search.
 *
 * Collision rule:
 * - Empty or whitespace-only strings are rejected
 * - Patterns starting with `class `, `def `, `function ` are rejected —
 *   agent should use ranked_map (ctags) for class/def searches
 * - Patterns containing `$` or `{` (structural AST syntax) are rejected —
 *   agent should use structural_search (ast-grep) for structural searches
 *
 * Returns null if valid, or an error string if invalid.
 */
export function validateQuery(query: string): string | null {
	if (!query || typeof query !== "string") {
		return "Query must be a non-empty string";
	}

	const trimmed = query.trim();
	if (!trimmed) {
		return "Query must be a non-empty string";
	}

	// Reject patterns that look like structural/symbol searches
	if (trimmed.startsWith("class ")) {
		return `Query "${trimmed}" looks like a class definition search. Use ranked_map (ctags) to find class definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("def ")) {
		return `Query "${trimmed}" looks like a function definition search. Use ranked_map (ctags) to find function definitions, not ripgrep_search.`;
	}

	if (trimmed.startsWith("function ")) {
		return `Query "${trimmed}" looks like a function definition search. Use ranked_map (ctags) to find function definitions, not ripgrep_search.`;
	}

	// Reject patterns with structural AST syntax ($ or {)
	if (trimmed.includes("$") || trimmed.includes("{")) {
		return `Query "${trimmed}" contains structural syntax ($ or {). Use structural_search (ast-grep) for structural code pattern matching, not ripgrep_search.`;
	}

	return null;
}
