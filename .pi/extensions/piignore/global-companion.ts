/**
 * piignore-trust-check — Global companion extension for piignore.
 *
 * Participates in project_trust events to warn about restrictive .piignore
 * patterns BEFORE trust is granted. This file is self-contained (no imports
 * from piignore) because it loads as a global extension before project-local
 * extensions are available.
 *
 * Install: copy to ~/.pi/agent/extensions/piignore-trust-check.ts
 *
 * Requirements: Pi v0.79.0+ (project_trust event)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Pattern parsing (self-contained — same logic as piignore/index.ts)
// ---------------------------------------------------------------------------

interface Pattern {
	regex: RegExp;
	negate: boolean;
}

/**
 * Check if a raw .piignore line is a restrictive pattern that would
 * block most or all paths. These are patterns like `*`, `**`, `/`,
 * `/*`, `/**` that match broadly and may cause unexpected blocking.
 */
function isRestrictiveRaw(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("#")) return false;
	// Strip negation prefix to check the actual pattern
	const pattern = trimmed.startsWith("!") ? trimmed.slice(1).trim() : trimmed;
	return (
		pattern === "*" || pattern === "**" || pattern === "/" || pattern === "/*" || pattern === "/**"
	);
}

/**
 * Parse a .piignore file content and return raw non-empty, non-comment lines.
 * Used by the companion to scan for restrictive patterns.
 */
function parseIgnoreRaw(content: string): string[] {
	const lines: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		lines.push(trimmed);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * piignore-trust-check extension.
 *
 * Registers a project_trust handler that:
 * - Scans the project's .piignore for restrictive patterns
 * - Warns the user if restrictive patterns are found
 * - Always returns { trusted: "undecided" } — does NOT make trust decisions
 * - Never throws (all errors caught internally)
 */
export default function (pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}): void {
	pi.on("project_trust", (_event: unknown, ctx: unknown) => {
		try {
			const extCtx = ctx as {
				cwd?: string;
				hasUI?: boolean;
				ui?: { notify: (message: string, type: string) => void };
			};

			if (!extCtx.cwd) return { trusted: "undecided" as const };

			const ignorePath = path.join(extCtx.cwd, ".piignore");
			let content: string;
			try {
				content = fs.readFileSync(ignorePath, "utf-8");
			} catch {
				// No .piignore or can't read — not a concern
				return { trusted: "undecided" as const };
			}

			const lines = parseIgnoreRaw(content);
			const restrictivePatterns = lines.filter(isRestrictiveRaw);

			if (restrictivePatterns.length > 0 && extCtx.hasUI && extCtx.ui) {
				extCtx.ui.notify(
					`⚠️ piignore: .piignore contains restrictive patterns (${restrictivePatterns.join(", ")}) that may block most files. Review before granting trust.`,
					"warning",
				);
			}

			return { trusted: "undecided" as const };
		} catch {
			// Never crash — fail silently, return undecided
			return { trusted: "undecided" as const };
		}
	});
}
