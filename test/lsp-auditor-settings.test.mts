/**
 * Phase 3: Settings/config loading tests for LSP Auditor
 *
 * Tests buildServerMappings from lsp-auditor.ts with various
 * settings.json configurations.
 *
 * Functions duplicated from lsp-auditor.ts (pattern from test/session-logger.test.mts,
 * test/supervisor-extensions.test.mts).
 *
 * Run with:
 *   node --experimental-strip-types --test test/lsp-auditor-settings.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Duplicated from lsp-auditor.ts for pure unit testing
// ═══════════════════════════════════════════════════════════════════════

interface ServerMapping {
	extensions: string[];
	command: string;
	args: string[];
	severityThreshold: "error" | "warning" | "info";
}

const DEFAULT_SERVER_MAPPINGS: ServerMapping[] = [
	{ extensions: [".ts", ".tsx", ".js", ".jsx"], command: "typescript-language-server", args: ["--stdio"], severityThreshold: "warning" },
	{ extensions: [".py"], command: "pyright-langserver", args: ["--stdio"], severityThreshold: "warning" },
	{ extensions: [".rs"], command: "rust-analyzer", args: [], severityThreshold: "warning" },
	{ extensions: [".go"], command: "gopls", args: [], severityThreshold: "warning" },
];

function buildServerMappings(configRaw: unknown): ServerMapping[] {
	if (!configRaw || typeof configRaw !== "object") return [...DEFAULT_SERVER_MAPPINGS];

	const config = configRaw as { servers?: Array<{ extensions: string[]; command: string; args?: string[]; severityThreshold?: string }> };
	if (!config.servers || !Array.isArray(config.servers) || config.servers.length === 0) return [...DEFAULT_SERVER_MAPPINGS];

	const merged = [...DEFAULT_SERVER_MAPPINGS];

	for (const srv of config.servers) {
		if (!srv.extensions || !Array.isArray(srv.extensions) || srv.extensions.length === 0) continue;
		if (!srv.command || typeof srv.command !== "string" || !srv.command.trim()) continue;

		const exts = [...new Set(srv.extensions.map(e => e.toLowerCase()))];

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

		const overlapExts = new Set(exts);
		for (let i = merged.length - 1; i >= 0; i--) {
			if (merged[i]!.extensions.some(e => overlapExts.has(e.toLowerCase()))) {
				merged.splice(i, 1);
			}
		}

		merged.push(newMapping);
	}

	return merged;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("buildServerMappings — config integration", () => {
	it("no lspAuditor key → returns default server mappings", () => {
		const result = buildServerMappings(undefined);
		assert.strictEqual(result.length, 4);
		assert.ok(result.some((m) => m.extensions.includes(".ts")));
		assert.ok(result.some((m) => m.extensions.includes(".py")));
		assert.ok(result.some((m) => m.extensions.includes(".rs")));
		assert.ok(result.some((m) => m.extensions.includes(".go")));
	});

	it("partial server override — replaces .ts with custom, keeps .py/.rs/.go", () => {
		const config = {
			servers: [{ extensions: [".ts", ".tsx"], command: "custom-ts-server", args: ["--stdio"] }],
		};
		const result = buildServerMappings(config);
		assert.ok(result.some((m) => m.command === "custom-ts-server"));
		assert.ok(result.some((m) => m.command === "pyright-langserver"));
		assert.ok(result.some((m) => m.command === "rust-analyzer"));
		assert.ok(result.some((m) => m.command === "gopls"));
	});

	it("adds new language without removing defaults", () => {
		const config = {
			servers: [{ extensions: [".kt"], command: "kotlin-ls" }],
		};
		const result = buildServerMappings(config);
		assert.strictEqual(result.length, 5);
		assert.ok(result.some((m) => m.extensions.includes(".kt")));
	});

	it("invalid severityThreshold → falls back to 'warning'", () => {
		const config = {
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "CRITICAL" }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.severityThreshold, "warning");
	});

	it("valid severityThreshold 'error' honored", () => {
		const config = {
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "error" }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.severityThreshold, "error");
	});

	it("empty servers array → returns defaults only", () => {
		const config = { servers: [] };
		const result = buildServerMappings(config);
		assert.strictEqual(result.length, 4);
	});

	it("command string empty → entry skipped, defaults kept", () => {
		const config = {
			servers: [{ extensions: [".ts"], command: "" }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.command, "typescript-language-server");
	});

	it("malformed config (null) → defaults", () => {
		const result = buildServerMappings(null);
		assert.strictEqual(result.length, 4);
	});

	it("extensions array contains duplicates → deduplicated", () => {
		const config = {
			servers: [{ extensions: [".ts", ".TS", ".tsx", ".tsx"], command: "ts-ls" }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.extensions.length, 2);
	});

	it("multiple servers in config → all honored", () => {
		const config = {
			servers: [
				{ extensions: [".kt"], command: "kotlin-ls" },
				{ extensions: [".swift"], command: "sourcekit-lsp" },
			],
		};
		const result = buildServerMappings(config);
		assert.ok(result.length >= 6);
		assert.ok(result.some((m) => m.command === "kotlin-ls"));
		assert.ok(result.some((m) => m.command === "sourcekit-lsp"));
	});

	it("severityThreshold with mixed case → normalized", () => {
		const config = {
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "Warning" }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.severityThreshold, "warning");
	});

	it("severityThreshold 'info' honored", () => {
		const config = {
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "info" }],
		};
		const result = buildServerMappings(config);
		const tsMapping = result.find((m) => m.extensions.includes(".ts"))!;
		assert.strictEqual(tsMapping.severityThreshold, "info");
	});
});
