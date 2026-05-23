/**
 * migration-generator — Generate before/after code snippets from changelog entries
 *
 * Pure function. Maps known changelog descriptions to migration snippets.
 * Fallback: generic template based on API name.
 *
 * Domain layer — no I/O, no framework deps.
 */

/** Before/after code snippet for migration */
export interface MigrationSnippet {
	apiName: string;
	/** Code before migration */
	before: string;
	/** Code after migration */
	after: string;
	/** Confidence level (0-1). 0 = generic fallback, 1 = exact known pattern */
	confidence: number;
}

// Known migration patterns mapped from changelog descriptions
interface KnownPattern {
	/** Regex matching the changelog description */
	descriptionPattern: RegExp;
	/** Template for before code — use {{apiName}} and captured groups */
	beforeTemplate: string;
	/** Template for after code */
	afterTemplate: string;
	/** Mapping from description match groups to template variables */
	confidence: number;
}

const KNOWN_MIGRATIONS: Array<{
	apiNameMatch: RegExp;
	descriptionPattern: RegExp;
	generateBefore: (match: RegExpMatchArray, apiName: string) => string;
	generateAfter: (match: RegExpMatchArray, apiName: string) => string;
	confidence: number;
}> = [
	{
		// pi.on("tool_call") → pi.on("tool_before_call")
		apiNameMatch: /^pi\.on$/,
		descriptionPattern: /\`pi\.on\((\w+)\)\`.*?in\s+favor\s+of\s+\`pi\.on\((\w+)\)\`/i,
		generateBefore: (m) => `pi.on("${m[1]}", handler)`,
		generateAfter: (m) => `pi.on("${m[2]}", handler)`,
		confidence: 0.9,
	},
	{
		// pi.on event change — generic
		apiNameMatch: /^pi\.on$/,
		descriptionPattern: /pi\.on\b.*?\b(\w+)\b.*?(\w+(?:\s*\([^)]*\))?)/i,
		generateBefore: (m) => `pi.on("${m[1]}", handler)`,
		generateAfter: (m) => `pi.on("${m[2]}", handler)`,
		confidence: 0.5,
	},
	{
		// RegisterTool — old run → new execute
		apiNameMatch: /^pi\.registerTool$/,
		descriptionPattern: /(?:run|execute)/i,
		generateBefore: () => `registerTool({ run: handler })`,
		generateAfter: () => `registerTool({ execute: handler })`,
		confidence: 0.7,
	},
	{
		// registerCommand — now requires handler
		apiNameMatch: /^pi\.registerCommand$/,
		descriptionPattern: /handler/i,
		generateBefore: () => `pi.registerCommand("cmd-name", { description: "..." })`,
		generateAfter: () =>
			`pi.registerCommand("cmd-name", { description: "...", handler: async () => {} })`,
		confidence: 0.6,
	},
	{
		// registerCommand — generic changes
		apiNameMatch: /^pi\.registerCommand$/,
		descriptionPattern: /registerCommand/i,
		generateBefore: () => `pi.registerCommand("old-cmd", { /* old config */ })`,
		generateAfter: () => `pi.registerCommand("new-cmd", { /* updated config */ })`,
		confidence: 0.4,
	},
	{
		// Context UI changes
		apiNameMatch: /^ctx\.ui$/,
		descriptionPattern: /ctx\.ui/i,
		generateBefore: () => `ctx.ui.oldMethod(args)`,
		generateAfter: () => `ctx.ui.newMethod(args)`,
		confidence: 0.3,
	},
	{
		// exec changes
		apiNameMatch: /^pi\.exec$/,
		descriptionPattern: /exec/i,
		generateBefore: () => `pi.exec("command", args, opts)`,
		generateAfter: () => `pi.exec("command", args, { ...opts, /* updated */ })`,
		confidence: 0.3,
	},
	{
		// Tool registration generic
		apiNameMatch: /^pi\.registerTool$/,
		descriptionPattern: /registerTool|tool/i,
		generateBefore: () => `registerTool({ name: "tool-name", execute: async () => {} })`,
		generateAfter: () =>
			`registerTool({ name: "tool-name", execute: async () => { /* updated */ } })`,
		confidence: 0.4,
	},
];

/**
 * Generate a migration snippet from a changelog description and API name.
 *
 * @param description - Changelog entry description text
 * @param apiName - Affected API name (e.g., "pi.on", "pi.registerTool")
 * @returns MigrationSnippet or null if description is empty
 */
export function generateMigrationSnippet(
	description: string,
	apiName: string,
): MigrationSnippet | null {
	if (!description || !description.trim()) return null;

	// Check known migration patterns
	for (const migration of KNOWN_MIGRATIONS) {
		if (!migration.apiNameMatch.test(apiName)) continue;

		const match = description.match(migration.descriptionPattern);
		if (match) {
			return {
				apiName,
				before: migration.generateBefore(match, apiName),
				after: migration.generateAfter(match, apiName),
				confidence: migration.confidence,
			};
		}
	}

	// Generic fallback — no specific pattern matched
	return {
		apiName,
		before: `// Update ${apiName} calls to match new API pattern`,
		after: `// Review changelog and update ${apiName} usage accordingly`,
		confidence: 0,
	};
}
