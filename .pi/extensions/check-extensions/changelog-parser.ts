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

			// Skip "Fixed" entries with internal-only terms
			if (currentCategory === "Fixed" && isInternalEntry(description)) {
				continue;
			}

			const apiNames = extractApiNames(description);
			const isApiVisible = currentCategory !== "Fixed" || apiNames.length > 0;

			if (currentCategory === "Fixed" && !isApiVisible) {
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
