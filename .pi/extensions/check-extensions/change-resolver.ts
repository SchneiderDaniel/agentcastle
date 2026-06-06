/**
 * change-resolver — Determine if a changelog entry actually affects a finding
 *
 * Pure function. Resolves limitation #2: no changelog-to-usage context mapping.
 * Compares structured changelog change signatures with AST-extracted call-site args
 * to eliminate "pi.on(tool_call) changed but extension uses pi.on(session_start)"
 * false positives.
 *
 * Domain layer — no I/O, no framework deps.
 */

import type { ChangeEntry } from "./changelog-parser.ts";
import type { ASTFinding } from "./ast-scanner.ts";

/** Structured change extracted from a changelog entry description */
export interface StructuredChange {
	/** Old/deprecated signature pattern (e.g., `pi.on("tool_call")`) */
	deprecatedSignature?: string;
	/** New/replacement signature pattern (e.g., `pi.on("tool_before_call")`) */
	newSignature?: string;
	/** Specific event type affected (e.g., "tool_call", "session_start") */
	affectedEventType?: string;
	/** Argument position affected (0-based). Defaults to 0 (first arg). */
	affectedArgPosition?: number;
	/** Deprecated method name (e.g., "pi.on") */
	deprecatedMethod?: string;
	/** New method name (e.g., "pi.on") */
	newMethod?: string;
}

/**
 * Resolve whether a changelog entry's change is relevant to a specific finding.
 *
 * Returns:
 *   - true  → change affects this finding
 *   - false → change does NOT affect this finding (false positive eliminated)
 *   - undefined → cannot determine (no structured change info) — falls through
 *
 * @param entry - The changelog ChangeEntry
 * @param finding - The AST finding to check
 * @param structured - Optional structured change info (from parseStructuredChange)
 */
export function resolveRelevance(
	entry: ChangeEntry,
	finding: ASTFinding,
	structured?: StructuredChange,
): boolean | undefined {
	// If no structured change info, we can't determine — falls through
	if (!structured) return undefined;

	// If we don't have call args to compare, can't determine
	if (!finding.callArgs || finding.callArgs.length === 0) return undefined;

	// Check if the affected event type matches finding's call args
	if (structured.affectedEventType) {
		const targetArg =
			structured.affectedArgPosition !== undefined
				? finding.callArgs[structured.affectedArgPosition]
				: finding.callArgs[0];

		if (targetArg) {
			// Detect variable/expression arg (no surrounding quotes)
			// Variables can hold any value at runtime so we can't determine
			// relevance from static analysis alone — return undefined (falls through)
			const firstChar = targetArg.trim()[0];
			if (firstChar !== '"' && firstChar !== "'" && firstChar !== "`") {
				return undefined;
			}

			// Strip quotes for comparison
			const cleanFindingArg = targetArg.replace(/^["'`]|["'`]$/g, "");
			const cleanEventType = structured.affectedEventType.replace(/^["'`]|["'`]$/g, "");

			if (cleanFindingArg === cleanEventType) {
				return true; // Match — change affects this call
			}

			// The finding's arg doesn't match — false positive
			return false;
		}
	}

	// Check if deprecated method name matches finding's API name
	if (structured.deprecatedMethod) {
		const findingApi = finding.apiName.replace(/^pi\./, "").replace(/^ctx\./, "");
		const depMethod = structured.deprecatedMethod.replace(/^pi\./, "").replace(/^ctx\./, "");

		if (findingApi === depMethod) {
			// Method name matches but no event type comparison — can't narrow
			return undefined;
		}
	}

	return undefined;
}
