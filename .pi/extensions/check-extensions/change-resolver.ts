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

// Cache of known migration patterns extracted from changelog descriptions
// Format: regex → StructuredChange
const KNOWN_PATTERNS: Array<{
	regex: RegExp;
	extract: (match: RegExpMatchArray) => StructuredChange;
}> = [
	{
		// Pattern: `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`
		regex: /\`(\w+(?:\.\w+)?)\((\w+)\)\`.*?in\s+favor\s+of\s+\`(\w+(?:\.\w+)?)\((\w+)\)\`/i,
		extract: (m) => ({
			deprecatedSignature: `${m[1]}("${m[2]}")`,
			newSignature: `${m[3]}("${m[4]}")`,
			affectedEventType: m[2]!,
			deprecatedMethod: m[1],
			newMethod: m[3],
			affectedArgPosition: 0,
		}),
	},
	{
		// Pattern: `api.method(args)` → `api.method(newArgs)`
		regex: /\`(\w+(?:\.\w+)?)\(([^)]*)\)\`.*?(?:changed|now|to)\s+\`(\w+(?:\.\w+)?)\(([^)]*)\)\`/i,
		extract: (m) => ({
			deprecatedSignature: `${m[1]}(${m[2]})`,
			newSignature: `${m[3]}(${m[4]})`,
			deprecatedMethod: m[1],
			newMethod: m[3],
			affectedArgPosition: 0,
		}),
	},
	{
		// Pattern: "Deprecated X" or "X deprecated" — captures method name
		regex: /(?:Deprecated|deprecated)\s+\`?(\w+(?:\.\w+)?(?:\([^)]*\))?)\`?/i,
		extract: (m) => {
			const sig = m[1]!;
			const parenIdx = sig.indexOf("(");
			const methodName = parenIdx >= 0 ? sig.slice(0, parenIdx) : sig;
			return {
				deprecatedSignature: sig,
				deprecatedMethod: methodName,
				affectedArgPosition: 0,
			};
		},
	},
];

/**
 * Extract structured change info from a changelog description.
 * Returns StructuredChange if description matches known migration patterns,
 * undefined otherwise.
 */
export function extractStructuredChange(
	description: string,
	apiName?: string,
): StructuredChange | undefined {
	if (!description) return undefined;

	for (const { regex, extract } of KNOWN_PATTERNS) {
		const match = description.match(regex);
		if (match) {
			return extract(match);
		}
	}

	return undefined;
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
