/**
 * Phase 1: Core pure functions — lsp-auditor formatter, filter, config, retry
 *
 * Tests pure functions in isolation. No I/O, no Pi API, instant.
 *
 * Run with:
 *   node --experimental-strip-types --test test/lsp-auditor.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ── Duplicated pure functions from lsp-auditor.ts (test-first: tests exist before implementation) ──

interface LspDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning" | "Information" | "Hint";
	message: string;
}

interface ServerMapping {
	extensions: string[];
	command: string;
	args: string[];
	severityThreshold: "error" | "warning" | "info";
}

interface AuditResult {
	diagnostics: LspDiagnostic[];
	errors: string[];
	note: string;
}

interface PreAuditResult {
	proceed: boolean;
	note: string;
}

// ─── Severity to numeric mapping ─────────────────────────────────────

function severityValue(severity: string): number {
	switch (severity.toLowerCase()) {
		case "error": return 1;
		case "warning": return 2;
		case "information": case "info": return 3;
		case "hint": return 4;
		default: return 99;
	}
}

function thresholdValue(threshold: string): number {
	switch (threshold.toLowerCase()) {
		case "error": return 1;
		case "warning": return 2;
		case "info": case "information": return 4; // "info" = show all including hints
		default: return 2; // default to warning
	}
}

// ─── formatDiagnostics ───────────────────────────────────────────────

function formatDiagnostics(diagnostics: LspDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Group by file
	const byFile = new Map<string, LspDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		// Sort by line, then column
		diags.sort((a, b) => a.line !== b.line ? a.line - b.line : a.column - b.column);

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			lines.push(`${file}, Line ${d.line}: [${d.severity}] ${msg}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

// ─── filterBySeverity ────────────────────────────────────────────────

function filterBySeverity(
	diagnostics: LspDiagnostic[],
	threshold: string,
): LspDiagnostic[] {
	if (!diagnostics || !Array.isArray(diagnostics)) return [];
	const maxVal = thresholdValue(threshold || "warning");
	return diagnostics.filter((d) => severityValue(d.severity) <= maxVal);
}

// ─── mergeResults ────────────────────────────────────────────────────

function mergeResults(results: AuditResult[]): AuditResult {
	const allDiags: LspDiagnostic[] = [];
	const allErrors: string[] = [];

	for (const r of results) {
		if (r.diagnostics) allDiags.push(...r.diagnostics);
		if (r.errors) allErrors.push(...r.errors);
	}

	let note = "";
	if (allErrors.length > 0) {
		note = `Warnings: ${allErrors.join("; ")}`;
	}

	return { diagnostics: allDiags, errors: allErrors, note };
}

// ─── buildServerMappings ─────────────────────────────────────────────

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

	// Merge user config with defaults. User config overrides same file extensions.
	const merged = [...DEFAULT_SERVER_MAPPINGS];

	for (const srv of config.servers) {
		if (!srv.extensions || !Array.isArray(srv.extensions) || srv.extensions.length === 0) continue;
		if (!srv.command || typeof srv.command !== "string" || !srv.command.trim()) continue;

		// Deduplicate extensions
		const exts = [...new Set(srv.extensions.map(e => e.toLowerCase()))];

		// Validate severityThreshold
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

		// Remove any default mapping that overlaps in extensions
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

// ─── extractModifiedFiles ────────────────────────────────────────────

function extractModifiedFiles(gitDiffOutput: string, worktreePath: string): string[] {
	if (!gitDiffOutput || !gitDiffOutput.trim()) return [];

	const lines = gitDiffOutput.trim().split("\n").filter(l => l.trim());
	const files: string[] = [];

	for (const line of lines) {
		const file = line.trim();
		if (!file) continue;

		// Resolve against worktreePath to check for path traversal
		const resolved = file.replace(/^(\.\/)+/, "");
		const fullPath = `${worktreePath}/${resolved}`;
		// Basic path traversal check - reject paths with ..
		if (resolved.includes("..")) continue;
		// Must not start with /
		if (resolved.startsWith("/")) continue;

		files.push(resolved);
	}

	return files;
}

// ─── countRetryAttempts ──────────────────────────────────────────────

function countRetryAttempts(entries: Array<{ type: string; payload: unknown }>, issueNum: number): number {
	if (!entries || !Array.isArray(entries)) return 0;
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== "lsp-audit-retry") continue;
		const payload = entry.payload as Record<string, unknown> | undefined;
		if (payload?.issueNum === issueNum) count++;
	}
	return count;
}

// ─── shouldRetry ─────────────────────────────────────────────────────

function shouldRetry(attempts: number): boolean {
	const n = typeof attempts !== "number" || Number.isNaN(attempts) || attempts < 0 ? 0 : attempts;
	return n < 3;
}

// ─── groupFilesByServer ──────────────────────────────────────────────

function groupFilesByServer(
	files: string[],
	mappings: ServerMapping[],
): { diagnostics: LspDiagnostic[]; errors: string[]; serverFiles: Map<ServerMapping, string[]> } {
	const serverFiles = new Map<ServerMapping, string[]>();
	const unsupported: string[] = [];

	for (const file of files) {
		const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
		let found = false;
		for (const mapping of mappings) {
			if (mapping.extensions.includes(ext)) {
				const list = serverFiles.get(mapping) || [];
				list.push(file);
				serverFiles.set(mapping, list);
				found = true;
				break;
			}
		}
		if (!found) unsupported.push(file);
	}

	const errors: string[] = [];
	if (unsupported.length > 0) {
		errors.push(`Unsupported file types (no LSP server): ${unsupported.join(", ")}`);
	}

	return { diagnostics: [], errors, serverFiles };
}

// =========================================================================
// Phase 1 Tests
// =========================================================================

describe("formatDiagnostics", () => {
	it("empty array → empty string", () => {
		assert.strictEqual(formatDiagnostics([]), "");
	});

	it("single diagnostic → one line", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "type x" },
		]);
		assert.strictEqual(result, "a.ts, Line 1: [Error] type x");
	});

	it("multiple diagnostics same file → sorted by line, file header once", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 5, column: 1, severity: "Warning", message: "unused" },
			{ file: "a.ts", line: 2, column: 3, severity: "Error", message: "type mismatch" },
		]);
		const lines = result.split("\n");
		assert.strictEqual(lines[0], "a.ts, Line 2: [Error] type mismatch");
		assert.strictEqual(lines[1], "a.ts, Line 5: [Warning] unused");
	});

	it("two files → blocks separated by blank line", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "err1" },
			{ file: "b.py", line: 3, column: 1, severity: "Warning", message: "warn1" },
		]);
		assert.ok(result.includes("\n\n"));
		assert.ok(result.includes("a.ts"));
		assert.ok(result.includes("b.py"));
	});

	it("files sorted alphabetically", () => {
		const result = formatDiagnostics([
			{ file: "z.ts", line: 1, column: 1, severity: "Error", message: "z" },
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "a" },
		]);
		const firstLine = result.split("\n")[0]!;
		assert.ok(firstLine.startsWith("a.ts"));
	});

	it("message >500 chars truncated", () => {
		const longMsg = "x".repeat(1000);
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: longMsg },
		]);
		assert.ok(result.length < 600);
		assert.ok(result.endsWith("..."));
	});

	it("unicode/emoji in message passed through", () => {
		const result = formatDiagnostics([
			{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "🚀 unicode test 世界" },
		]);
		assert.ok(result.includes("🚀 unicode test 世界"));
	});
});

describe("filterBySeverity", () => {
	const diags: LspDiagnostic[] = [
		{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "e" },
		{ file: "b.ts", line: 2, column: 1, severity: "Warning", message: "w" },
		{ file: "c.ts", line: 3, column: 1, severity: "Information", message: "i" },
		{ file: "d.ts", line: 4, column: 1, severity: "Hint", message: "h" },
	];

	it("threshold 'error' → only errors", () => {
		const result = filterBySeverity(diags, "error");
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.severity, "Error");
	});

	it("threshold 'warning' → errors + warnings", () => {
		const result = filterBySeverity(diags, "warning");
		assert.strictEqual(result.length, 2);
	});

	it("threshold 'info' → all severities", () => {
		const result = filterBySeverity(diags, "info");
		assert.strictEqual(result.length, 4);
	});

	it("empty array → empty", () => {
		assert.deepStrictEqual(filterBySeverity([], "warning"), []);
	});

	it("unknown threshold string → defaults to warning (errors + warnings)", () => {
		const result = filterBySeverity(diags, "unknown");
		assert.strictEqual(result.length, 2);
	});

	it("null/undefined input → empty array (no crash)", () => {
		assert.deepStrictEqual(filterBySeverity(null as unknown as LspDiagnostic[], "warning"), []);
		assert.deepStrictEqual(filterBySeverity(undefined as unknown as LspDiagnostic[], "warning"), []);
	});
});

describe("mergeResults", () => {
	it("merges diagnostics and errors", () => {
		const result = mergeResults([
			{ diagnostics: [{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "e1" }], errors: ["srv1 failed"], note: "" },
			{ diagnostics: [{ file: "b.ts", line: 2, column: 1, severity: "Warning", message: "w1" }], errors: [], note: "" },
		]);
		assert.strictEqual(result.diagnostics.length, 2);
		assert.strictEqual(result.errors.length, 1);
		assert.ok(result.note.includes("srv1 failed"));
	});

	it("both empty → empty result", () => {
		const result = mergeResults([]);
		assert.deepStrictEqual(result, { diagnostics: [], errors: [], note: "" });
	});

	it("handles missing arrays", () => {
		const result = mergeResults([
			{ diagnostics: undefined as unknown as LspDiagnostic[], errors: ["e"], note: "" },
			{ diagnostics: [{ file: "a.ts", line: 1, column: 1, severity: "Error", message: "x" }], errors: undefined as unknown as string[], note: "" },
		]);
		assert.strictEqual(result.diagnostics.length, 1);
		assert.strictEqual(result.errors.length, 1);
	});
});

describe("buildServerMappings", () => {
	it("undefined config → returns 4 default mappings", () => {
		const result = buildServerMappings(undefined);
		assert.strictEqual(result.length, 4);
		assert.ok(result.some(m => m.extensions.includes(".ts")));
		assert.ok(result.some(m => m.extensions.includes(".py")));
		assert.ok(result.some(m => m.extensions.includes(".rs")));
		assert.ok(result.some(m => m.extensions.includes(".go")));
	});

	it("TypeScript uses typescript-language-server --stdio", () => {
		const result = buildServerMappings(undefined);
		const ts = result.find(m => m.extensions.includes(".ts"));
		assert.ok(ts);
		assert.strictEqual(ts!.command, "typescript-language-server");
		assert.deepStrictEqual(ts!.args, ["--stdio"]);
	});

	it("Python uses pyright-langserver --stdio", () => {
		const result = buildServerMappings(undefined);
		const py = result.find(m => m.extensions.includes(".py"));
		assert.ok(py);
		assert.strictEqual(py!.command, "pyright-langserver");
	});

	it("user override .ts → replaces default .ts mapping, keeps others", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts"], command: "custom-ts" }],
		});
		// .ts mapping replaced
		const ts = result.find(m => m.extensions.includes(".ts"));
		assert.ok(ts);
		assert.strictEqual(ts!.command, "custom-ts");
		// .py still there
		assert.ok(result.some(m => m.extensions.includes(".py")));
	});

	it("user adds new language .kt → added to defaults", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".kt"], command: "kotlin-ls" }],
		});
		assert.ok(result.some(m => m.extensions.includes(".kt")));
		// Defaults still present
		assert.ok(result.some(m => m.extensions.includes(".ts")));
		assert.strictEqual(result.length, 5);
	});

	it("severityThreshold per-server honored", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "error" }],
		});
		const ts = result.find(m => m.extensions.includes(".ts"));
		assert.strictEqual(ts!.severityThreshold, "error");
	});

	it("invalid severityThreshold → falls back to warning", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts"], command: "ts-ls", severityThreshold: "critical" }],
		});
		const ts = result.find(m => m.extensions.includes(".ts"));
		assert.strictEqual(ts!.severityThreshold, "warning");
	});

	it("empty servers → returns defaults", () => {
		const result = buildServerMappings({ servers: [] });
		assert.strictEqual(result.length, 4);
	});

	it("empty command → entry skipped", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts"], command: "" }],
		});
		// Defaults still intact
		const ts = result.find(m => m.extensions.includes(".ts"));
		assert.strictEqual(ts!.command, "typescript-language-server");
	});

	it("extensions deduplicated", () => {
		const result = buildServerMappings({
			servers: [{ extensions: [".ts", ".TS", ".tsx", ".TSX"], command: "ts-ls" }],
		});
		const ts = result.find(m => m.extensions.includes(".ts"));
		assert.ok(ts);
		assert.strictEqual(ts!.extensions.length, 2); // .ts, .tsx deduplicated
	});
});

describe("extractModifiedFiles", () => {
	it("parses git diff output into file list", () => {
		const output = "src/app.ts\nlib/utils.py\ndocs/readme.md\n";
		const result = extractModifiedFiles(output, "/tmp/worktree");
		assert.deepStrictEqual(result, ["src/app.ts", "lib/utils.py", "docs/readme.md"]);
	});

	it("empty output → []", () => {
		assert.deepStrictEqual(extractModifiedFiles("", "/tmp/worktree"), []);
	});

	it("path with .. → filtered out", () => {
		const result = extractModifiedFiles("src/../etc/passwd\nvalid.ts", "/tmp/worktree");
		assert.deepStrictEqual(result, ["valid.ts"]);
	});

	it("absolute path → filtered out", () => {
		const result = extractModifiedFiles("/etc/passwd\nvalid.ts", "/tmp/worktree");
		assert.deepStrictEqual(result, ["valid.ts"]);
	});

	it("strips leading ./", () => {
		const result = extractModifiedFiles("./src/app.ts\n./lib.py", "/tmp/worktree");
		assert.deepStrictEqual(result, ["src/app.ts", "lib.py"]);
	});
});

describe("countRetryAttempts", () => {
	it("counts matching entries", () => {
		const entries = [
			{ type: "lsp-audit-retry", payload: { issueNum: 35 } },
			{ type: "lsp-audit-retry", payload: { issueNum: 35 } },
			{ type: "other", payload: {} },
		];
		assert.strictEqual(countRetryAttempts(entries, 35), 2);
	});

	it("no matching entries → 0", () => {
		const entries = [
			{ type: "other", payload: {} },
		];
		assert.strictEqual(countRetryAttempts(entries, 35), 0);
	});

	it("different issue → 0", () => {
		const entries = [
			{ type: "lsp-audit-retry", payload: { issueNum: 99 } },
		];
		assert.strictEqual(countRetryAttempts(entries, 35), 0);
	});

	it("null/undefined entries → 0", () => {
		assert.strictEqual(countRetryAttempts(null as unknown as [], 35), 0);
		assert.strictEqual(countRetryAttempts(undefined as unknown as [], 35), 0);
	});
});

describe("shouldRetry", () => {
	it("0 attempts → true", () => assert.strictEqual(shouldRetry(0), true));
	it("2 attempts → true", () => assert.strictEqual(shouldRetry(2), true));
	it("3 attempts → false", () => assert.strictEqual(shouldRetry(3), false));
	it("negative → treated as 0 → true", () => assert.strictEqual(shouldRetry(-1), true));
	it("NaN → treated as 0 → true", () => assert.strictEqual(shouldRetry(NaN), true));
});

describe("groupFilesByServer", () => {
	const mappings: ServerMapping[] = [
		{ extensions: [".ts"], command: "ts-ls", args: ["--stdio"], severityThreshold: "warning" },
		{ extensions: [".py"], command: "pyright-langserver", args: ["--stdio"], severityThreshold: "warning" },
	];

	it("groups files under matching server", () => {
		const { serverFiles, errors } = groupFilesByServer(["a.ts", "b.py"], mappings);
		assert.strictEqual(serverFiles.size, 2);
		const tsEntry = [...serverFiles.entries()].find(([m]) => m.command === "ts-ls");
		assert.deepStrictEqual(tsEntry![1], ["a.ts"]);
	});

	it("flags unsupported file types", () => {
		const { errors } = groupFilesByServer(["a.ts", "script.sh"], mappings);
		assert.strictEqual(errors.length, 1);
		assert.ok(errors[0]!.includes("script.sh"));
	});

	it("all unsupported → errors with no server files", () => {
		const { serverFiles, errors } = groupFilesByServer(["script.sh"], mappings);
		assert.strictEqual(serverFiles.size, 0);
		assert.strictEqual(errors.length, 1);
	});
});
