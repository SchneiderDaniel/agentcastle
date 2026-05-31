/**
 * changelog-parser — Parse pi CHANGELOG.md into ChangeEntry[]
 *
 * Pure function: string → ChangeEntry[]. No I/O.
 */

export interface ChangeEntry {
	version: string;
	category: "Added" | "Changed" | "Deprecated" | "Removed" | "Fixed" | "Security" | "New Features";
	description: string;
	apiNames: string[];
	isBreaking: boolean;
}

// Keywords that flag an entry as API-visible
const API_KEYWORDS = [
	"extension",
	"tool",
	"command",
	"event",
	"SDK",
	"sdk",
	"export",
	"registerCommand",
	"registerTool",
	"config option",
	"pi.on",
	"pi.exec",
	"pi.sendUserMessage",
	"ctx.ui",
	"ctx.sessionManager",
	"ctx.abort",
	"pi.registerFlag",
	"pi.registerShortcut",
	"pi.getFlag",
	"pi.setActiveTools",
];

// Terms that mark a "Fixed" entry as internal-only (skipped)
const INTERNAL_TERMS = [
	"provider",
	"TUI",
	"theme",
	"clipboard",
	"Windows",
	"macOS",
	"footer",
	"bash",
	"tool card",
	"tool result card",
	"abbreviat",
	"truncat",
	"shrinkwrap",
	"lockfile",
	"lifecycle",
	"shutdown",
	"dev watch",
	"reference",
	"navigate",
	"breadcrumb",
	"session tree",
	"login",
	"browser",
	"redirect",
	"image resize",
	"resize",
	"worker",
	"async fs",
	"synchronous",
	"off the main",
];

const CATEGORY_RE = /^### (Added|Changed|Deprecated|Removed|Fixed|Security|New Features)/;
const VERSION_RE = /^## \[([^\]]+)\]/;
const BULLET_RE = /^- (.+)/;

/**
 * Parse a CHANGELOG.md string into structured ChangeEntry[].
 * Returns [] for null/undefined/empty input.
 */
export function parseChangelog(md: string): ChangeEntry[] {
	if (!md) return [];

	const lines = md.split("\n");
	const entries: ChangeEntry[] = [];

	let currentVersion = "";
	let currentCategory = "";
	let categoryHasBullet = false;

	for (const line of lines) {
		const versionMatch = line.match(VERSION_RE);
		if (versionMatch) {
			// Flush empty category entry if category had no bullets
			if (currentVersion && currentCategory && !categoryHasBullet) {
				entries.push(makeEntry(currentVersion, currentCategory, ""));
			}
			currentVersion = versionMatch[1]!;
			currentCategory = "";
			categoryHasBullet = false;
			continue;
		}

		const catMatch = line.match(CATEGORY_RE);
		if (catMatch) {
			// Flush previous empty category entry
			if (currentVersion && currentCategory && !categoryHasBullet) {
				entries.push(makeEntry(currentVersion, currentCategory, ""));
			}
			currentCategory = catMatch[1]!;
			categoryHasBullet = false;
			continue;
		}

		const bulletMatch = line.match(BULLET_RE);
		if (bulletMatch && currentVersion && currentCategory) {
			categoryHasBullet = true;
			const description = bulletMatch[1]!;

			const apiNames = extractApiNames(description);

			// Skip "Fixed" entries that are truly internal-only (no API changes)
			if (currentCategory === "Fixed" && apiNames.length === 0 && isInternalEntry(description)) {
				continue;
			}

			entries.push({
				version: currentVersion,
				category: currentCategory as ChangeEntry["category"],
				description,
				apiNames,
				isBreaking: currentCategory === "Deprecated" || currentCategory === "Removed",
			});
		}
	}

	// End of file: flush empty category if needed
	if (currentVersion && currentCategory && !categoryHasBullet) {
		entries.push(makeEntry(currentVersion, currentCategory, ""));
	}

	return entries;
}

function makeEntry(version: string, category: string, description: string): ChangeEntry {
	return {
		version,
		category: category as ChangeEntry["category"],
		description,
		apiNames: [],
		isBreaking: category === "Deprecated" || category === "Removed",
	};
}

/**
 * Check if a "Fixed" entry description contains only internal terms.
 */
function isInternalEntry(description: string): boolean {
	const lower = description.toLowerCase();
	return INTERNAL_TERMS.some((term) => lower.includes(term.toLowerCase()));
}

/**
 * Extract API names from a changelog entry description.
 */
function extractApiNames(description: string): string[] {
	const names: string[] = [];
	const lower = description.toLowerCase();

	for (const kw of API_KEYWORDS) {
		if (lower.includes(kw.toLowerCase())) {
			if (kw === "pi.on") names.push("on");
			else if (kw === "pi.exec") names.push("exec");
			else if (kw === "pi.sendUserMessage") names.push("sendUserMessage");
			else if (kw === "ctx.ui") names.push("ctx.ui");
			else if (kw === "ctx.sessionManager") names.push("sessionManager");
			else if (kw === "ctx.abort") names.push("abort");
			else if (kw === "pi.registerFlag") names.push("registerFlag");
			else if (kw === "pi.registerShortcut") names.push("registerShortcut");
			else if (kw === "pi.getFlag") names.push("getFlag");
			else if (kw === "pi.setActiveTools") names.push("setActiveTools");
			else if (kw === "registerCommand") names.push("registerCommand");
			else if (kw === "registerTool") names.push("registerTool");
			else if (kw === "config option") names.push("config");
			else if (kw === "export") names.push("export");
			else if (kw === "tool") names.push("tool");
			else if (kw === "command") names.push("command");
			else if (kw === "event") names.push("event");
			else if (kw === "SDK" || kw === "sdk") names.push("SDK");
			else names.push(kw);
		}
	}

	// Additionally detect explicit API patterns in description
	const apiPatterns = [
		/pi\.on/i,
		/registerTool/i,
		/registerCommand/i,
		/pi\.exec/i,
		/pi\.sendUserMessage/i,
		/ctx\.ui/i,
	];
	for (const p of apiPatterns) {
		const m = description.match(p);
		if (m && !names.some((n) => n === m[0].toLowerCase())) {
			names.push(m[0]);
		}
	}

	return [...new Set(names)];
}

// ── Structured Change Parsing ──────────────────────────────────────────

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
 * Known patterns for extracting structured change info from description text.
 * Each entry has a regex and a mapping function to StructuredChange.
 */
const STRUCTURED_PATTERNS: Array<{
	regex: RegExp;
	extract: (match: RegExpMatchArray) => StructuredChange;
}> = [
	{
		// Pattern: `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`
		regex: /\`(\w+(?:\.\w+)*)\((\w+)\)\`.*?in\s+favor\s+of\s+\`(\w+(?:\.\w+)*)\((\w+)\)\`/i,
		extract: (m) => ({
			deprecatedSignature: `${m[1]!}("${m[2]!}")`,
			newSignature: `${m[3]!}("${m[4]!}")`,
			affectedEventType: m[2],
			deprecatedMethod: m[1],
			newMethod: m[3],
			affectedArgPosition: 0,
		}),
	},
	{
		// Pattern: `api.method(args)` → `api.method(newArgs)` or similar transformation
		regex: /\`(\w+(?:\.\w+)*)\(([^)]*)\)\`.*?(?:changed|now|to)\s+\`(\w+(?:\.\w+)*)\(([^)]*)\)\`/i,
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
		regex: /(?:Deprecated|deprecated)\s+\`?(\w+(?:\.\w+)*(?:\([^)]*\))?)\`?/i,
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
	{
		// Pattern: \`method(args)\` now requires ... — signature change without replacement method
		// e.g., "\`pi.registerCommand(name, opts)\` now requires \`opts.handler\` to be async"
		regex: /\`(\w+(?:\.\w+)*)\(([^)]*)\)\`.*?now\s+requires/i,
		extract: (m) => {
			// For "now requires" patterns, the method stays the same but args change
			// Try to extract what's required from the rest of the description
			const method = m[1]!;
			const oldArgs = m[2]!;
			return {
				deprecatedSignature: `${method}(${oldArgs})`,
				newSignature: `${method}(...)`,
				deprecatedMethod: method,
				newMethod: method,
				affectedArgPosition: 0,
			};
		},
	},
	{
		// Pattern: \`method()\` args changed from \`X\` to \`Y\`
		// e.g., "\`ctx.ui.select()\` args changed from \`(items, prompt)\` to \`(config)"
		regex:
			/\`(\w+(?:\.\w+)*)\(([^)]*)\)\`.*?(?:args|changed).*?from\s+\`([^`]+)\`.*?to\s+\`([^`]+)\`/i,
		extract: (m) => ({
			deprecatedSignature: `${m[1]}(${m[2]})`,
			newSignature: `${m[1]}(${m[3]!.trim()})`,
			deprecatedMethod: m[1],
			newMethod: m[1],
			affectedEventType: m[2] ? m[2].trim() : undefined,
			affectedArgPosition: 0,
		}),
	},
];

/**
 * Parse a changelog entry description and extract structured change information.
 *
 * Uses regex heuristics on known changelog phrasing patterns.
 * Returns StructuredChange if description matches a known pattern,
 * null otherwise (false negatives → finding still flagged, just without snippet).
 *
 * @param description - Changelog entry description text
 * @returns StructuredChange or null if no pattern matched
 */
export function parseStructuredChange(description: string): StructuredChange | null {
	if (!description) return null;

	for (const { regex, extract } of STRUCTURED_PATTERNS) {
		const match = description.match(regex);
		if (match) {
			return extract(match);
		}
	}

	return null;
}
