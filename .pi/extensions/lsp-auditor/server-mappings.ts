/**
 * Server mapping configuration for LSP Auditor.
 *
 * Pure config logic — zero I/O. Defines default LSP server mappings
 * and merges user settings with defaults.
 */

import type { ServerMapping } from "./types.ts";

// ─── Defaults ────────────────────────────────────────────────────────

/** Default LSP server mappings baked into the extension.
 *  NOTE: TypeScript/JavaScript use `typescript-language-server --stdio`,
 *  NOT raw `tsserver` (which speaks a custom protocol, not LSP).
 */
export const DEFAULT_SERVER_MAPPINGS: ServerMapping[] = [
	{
		extensions: [".ts", ".tsx", ".js", ".jsx"],
		command: "typescript-language-server",
		args: ["--stdio"],
		severityThreshold: "warning",
	},
	{
		extensions: [".py"],
		command: "pyright-langserver",
		args: ["--stdio"],
		severityThreshold: "warning",
	},
	{ extensions: [".rs"], command: "rust-analyzer", args: [], severityThreshold: "warning" },
	{ extensions: [".go"], command: "gopls", args: [], severityThreshold: "warning" },
];

// ─── Builder ─────────────────────────────────────────────────────────

/**
 * Build the final server mapping list from user settings merged with defaults.
 * User config overrides/extends defaults.
 */
export function buildServerMappings(configRaw: unknown): ServerMapping[] {
	if (!configRaw || typeof configRaw !== "object") return [...DEFAULT_SERVER_MAPPINGS];

	const config = configRaw as {
		servers?: Array<{
			extensions: string[];
			command: string;
			args?: string[];
			severityThreshold?: string;
		}>;
	};
	if (!config.servers || !Array.isArray(config.servers) || config.servers.length === 0)
		return [...DEFAULT_SERVER_MAPPINGS];

	const merged = [...DEFAULT_SERVER_MAPPINGS];

	for (const srv of config.servers) {
		if (!srv.extensions || !Array.isArray(srv.extensions) || srv.extensions.length === 0) continue;
		if (!srv.command || typeof srv.command !== "string" || !srv.command.trim()) continue;

		const exts = [...new Set(srv.extensions.map((e) => e.toLowerCase()))];

		let threshold: "error" | "warning" | "info" = "warning";
		if (srv.severityThreshold) {
			const t = srv.severityThreshold.toLowerCase();
			if (t === "error" || t === "warning" || t === "info") threshold = t;
		}

		const newMapping: ServerMapping = {
			extensions: exts,
			command: srv.command.trim(),
			args: srv.args || [],
			severityThreshold: threshold,
		};

		// Remove overlapping defaults
		const overlapExts = new Set(exts);
		for (let i = merged.length - 1; i >= 0; i--) {
			if (merged[i]!.extensions.some((e) => overlapExts.has(e.toLowerCase()))) {
				merged.splice(i, 1);
			}
		}

		merged.push(newMapping);
	}

	return merged;
}
