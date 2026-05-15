// ─── Extension Resolution Module ──────────────────────────────────
// Resolve --extension CLI flags from agent frontmatter.
// Discover tools from registered extensions.

import { readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────

export const CONTEXT_INFO_EXTENSION = ".pi/extensions/context-info.ts";

// ─── Extension flag resolution ──────────────────────────────────────

/**
 * Resolve the extensions CLI flags for a given agent frontmatter.
 * - If extensions field is present and non-empty, split, trim, filter out
 *   "supervisor" (case-insensitive), and return `--extension <path>` flags.
 * - If nothing remains after filtering, fall back to context-info only.
 * - If extensions field is missing or empty, return context-info only.
 * - Context-info is always auto-injected (deduplicated).
 */
export function resolveExtensions(extensionsRaw: string | undefined): string[] {
	if (!extensionsRaw || !extensionsRaw.trim()) {
		return ["--extension", CONTEXT_INFO_EXTENSION];
	}

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	const result: string[] = [];
	for (const ext of extensions) {
		result.push("--extension", `.pi/extensions/${ext}.ts`);
	}

	const hasContextInfo = result.some(
		(r) => r === CONTEXT_INFO_EXTENSION || r.endsWith("/context-info.ts"),
	);
	if (!hasContextInfo) {
		result.push("--extension", CONTEXT_INFO_EXTENSION);
	}

	return result;
}

// ─── Tool discovery ────────────────────────────────────────────────

let _extToolsCache: Map<string, string[]> | null = null;

export function discoverExtensionTools(): Map<string, string[]> {
	if (_extToolsCache) return _extToolsCache;

	const map = new Map<string, string[]>();
	const extDir = resolvePath(process.cwd(), ".pi/extensions");

	let files: string[];
	try {
		files = readdirSync(extDir);
	} catch {
		_extToolsCache = map;
		return map;
	}

	for (const file of files) {
		if (!file.endsWith(".ts")) continue;
		const basename = file.replace(/\.ts$/, "");
		const filePath = resolvePath(extDir, file);

		let content: string;
		try {
			content = readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const toolRe = /\.registerTool\(\s*\{[^}]*?\bname:\s*["']([^"']+)["']/gs;
		const tools: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = toolRe.exec(content)) !== null) {
			tools.push(m[1]!);
		}
		if (tools.length > 0) {
			map.set(basename, tools);
		}
	}

	_extToolsCache = map;
	return map;
}

// ─── Tool merging ──────────────────────────────────────────────────

/**
 * Merge agent-declared tools with tools from agent's extensions.
 * Returns a comma-separated string for --tools flag.
 */
export function resolveTools(agentTools: string, extNamesRaw: string | undefined): string {
	const toolSet = new Set(
		agentTools
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	if (extNamesRaw && extNamesRaw.trim()) {
		const extToolsMap = discoverExtensionTools();
		const extNames = extNamesRaw
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0 && s.toLowerCase() !== "supervisor");

		for (const extName of extNames) {
			const extTools = extToolsMap.get(extName);
			if (extTools) {
				for (const t of extTools) toolSet.add(t);
			}
		}
	}

	return [...toolSet].join(",");
}
