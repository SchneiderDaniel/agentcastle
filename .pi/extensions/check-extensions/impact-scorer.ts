/**
 * impact-scorer — Compute impact severity per extension from findings
 *
 * Pure function. Aggregates findings into a severity score.
 * Used for cross-extension prioritization (fixes limitation #7).
 *
 * Domain layer — no I/O, no framework deps.
 */

import type { ASTFinding } from "./ast-scanner.ts";

/** Impact severity levels */
export type SeverityLevel = "none" | "low" | "medium" | "high" | "critical";

/** Impact score for an extension */
export interface ImpactScore {
	extensionName: string;
	severity: SeverityLevel;
	/** Number of unique affected APIs */
	uniqueApis: number;
	/** Count of breaking changes */
	breakingCount: number;
	/** Whether the extension has test files */
	hasTests: boolean;
}

/**
 * Compute impact score for an extension from its findings.
 *
 * Scoring rules:
 * - 0 findings → "none"
 * - 1 non-breaking → "low"
 * - 1 breaking → "medium"
 * - 2-5 breaking → "high"
 * - 6+ breaking → "critical"
 * - Mix of breaking + non-breaking with ≥2 breaking → "high"
 * - >=3 non-breaking only → "medium"
 *
 * @param extensionName - Name of the extension
 * @param findings - Array of AST findings for this extension
 * @returns ImpactScore with severity level
 */
export function computeImpactScore(extensionName: string, findings: ASTFinding[]): ImpactScore {
	if (findings.length === 0) {
		return {
			extensionName,
			severity: "none",
			uniqueApis: 0,
			breakingCount: 0,
			hasTests: false,
		};
	}

	// Count unique APIs
	const uniqueApiSet = new Set<string>();
	for (const f of findings) {
		if (f.matchContext === "runtime-call") {
			uniqueApiSet.add(f.apiName);
		}
	}
	const uniqueApis = uniqueApiSet.size;

	// Count breaking changes
	const breakingCount = findings.filter((f) => f.isBreaking).length;

	// Determine if extension has tests
	const hasTests = findings.some((f) => {
		try {
			const testPattern = /\.(test|spec)\.(ts|mts)$/;
			return testPattern.test(f.file);
		} catch {
			return false;
		}
	});

	// Compute severity
	let severity: SeverityLevel;

	if (breakingCount >= 6) {
		severity = "critical";
	} else if (breakingCount >= 2) {
		severity = "high";
	} else if (breakingCount === 1) {
		severity = "medium";
	} else if (uniqueApis >= 3) {
		// Multiple non-breaking changes
		severity = "medium";
	} else if (uniqueApis >= 1) {
		severity = "low";
	} else {
		severity = "none";
	}

	return {
		extensionName,
		severity,
		uniqueApis,
		breakingCount,
		hasTests,
	};
}
