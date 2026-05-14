/**
 * LSP Auditor Extension — Pre-review code diagnostics
 *
 * Runs Language Server Protocol diagnostics on files modified by the Developer
 * agent, triggered when the supervisor transitions from Implementation to Audit.
 * Auto-retries the Developer up to 3 times if errors are found.
 *
 * Design:
 * - Pure functions (formatDiagnostics, filterBySeverity, etc.) are exported
 *   for unit testing. They do NOT depend on Pi or Node I/O.
 * - runPreAudit() is the hook called by supervisor. It orchestrates:
 *   git diff → file grouping → LSP spawn per group → collect → format → decide.
 * - LspClient is a private class that manages one LSP server lifecycle.
 * - Session entries ("lsp-audit-retry") track retry count across sessions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface LspDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning" | "Information" | "Hint";
	message: string;
}

export interface ServerMapping {
	extensions: string[];
	command: string;
	args: string[];
	severityThreshold: "error" | "warning" | "info";
}

export interface AuditResult {
	diagnostics: LspDiagnostic[];
	errors: string[];
	note: string;
}

export interface PreAuditOptions {
	issueNum: number;
	worktreePath: string;
	defaultBranch: string;
	repo: string;
}

export interface PreAuditResult {
	proceed: boolean;
	note: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Pure Functions (exported for unit testing)
// ═══════════════════════════════════════════════════════════════════════

/** Severity name → LSP diagnostic severity number (1=Error, 2=Warning, 3=Information, 4=Hint) */
export function severityValue(severity: string): number {
	switch (severity.toLowerCase()) {
		case "error": return 1;
		case "warning": return 2;
		case "information": case "info": return 3;
		case "hint": return 4;
		default: return 99;
	}
}

/** Threshold string → max severity value to include */
export function thresholdValue(threshold: string): number {
	switch (threshold.toLowerCase()) {
		case "error": return 1;
		case "warning": return 2;
		case "info": case "information": return 4; // "info" = show all including hints
		default: return 2; // default to error+warning
	}
}

/**
 * Format diagnostics into a compact, human-readable message.
 * Grouped by file, sorted by line.
 */
export function formatDiagnostics(diagnostics: LspDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

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

/**
 * Filter diagnostics by severity threshold string.
 * "error" → only errors, "warning" → errors+warnings, "info" → all.
 */
export function filterBySeverity(
	diagnostics: LspDiagnostic[],
	threshold: string,
): LspDiagnostic[] {
	if (!diagnostics || !Array.isArray(diagnostics)) return [];
	const maxVal = thresholdValue(threshold || "warning");
	return diagnostics.filter((d) => severityValue(d.severity) <= maxVal);
}

/**
 * Merge multiple audit results (one per LSP server) into a single result.
 */
export function mergeResults(results: AuditResult[]): AuditResult {
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

// ═══════════════════════════════════════════════════════════════════════
// Server Mappings
// ═══════════════════════════════════════════════════════════════════════

/** Default LSP server mappings baked into the extension.
 *  NOTE: TypeScript/JavaScript use `typescript-language-server --stdio`,
 *  NOT raw `tsserver` (which speaks a custom protocol, not LSP).
 */
export const DEFAULT_SERVER_MAPPINGS: ServerMapping[] = [
	{ extensions: [".ts", ".tsx", ".js", ".jsx"], command: "typescript-language-server", args: ["--stdio"], severityThreshold: "warning" },
	{ extensions: [".py"], command: "pyright-langserver", args: ["--stdio"], severityThreshold: "warning" },
	{ extensions: [".rs"], command: "rust-analyzer", args: [], severityThreshold: "warning" },
	{ extensions: [".go"], command: "gopls", args: [], severityThreshold: "warning" },
];

/**
 * Build the final server mapping list from user settings merged with defaults.
 * User config overrides/extends defaults.
 */
export function buildServerMappings(configRaw: unknown): ServerMapping[] {
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

		// Remove overlapping defaults
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
// File Discovery
// ═══════════════════════════════════════════════════════════════════════

/**
 * Extract list of modified files from `git diff <branch> --name-only` output.
 * Path validation restricts to worktree and blocks traversal.
 */
export function extractModifiedFiles(gitDiffOutput: string, worktreePath: string): string[] {
	if (!gitDiffOutput || !gitDiffOutput.trim()) return [];

	const lines = gitDiffOutput.trim().split("\n").filter(l => l.trim());
	const files: string[] = [];

	for (const line of lines) {
		const file = line.trim();
		if (!file) continue;

		const resolved = file.replace(/^(\.\/)+/, "");
		// Path traversal prevention
		if (resolved.includes("..")) continue;
		if (resolved.startsWith("/")) continue;

		files.push(resolved);
	}

	return files;
}

// ═══════════════════════════════════════════════════════════════════════
// Retry Logic
// ═══════════════════════════════════════════════════════════════════════

/** Maximum retry attempts before forcing through to Auditor. */
export const MAX_RETRIES = 3;

/** Session entry type for retry tracking. */
const RETRY_ENTRY_TYPE = "lsp-audit-retry";

/**
 * Count how many LSP audit retries have been attempted for a given issue.
 */
export function countRetryAttempts(
	entries: Array<{ type: string; payload: unknown }>,
	issueNum: number,
): number {
	if (!entries || !Array.isArray(entries)) return 0;
	let count = 0;
	for (const entry of entries) {
		if (entry.type !== RETRY_ENTRY_TYPE) continue;
		const payload = entry.payload as Record<string, unknown> | undefined;
		if (payload?.issueNum === issueNum) count++;
	}
	return count;
}

/**
 * Should we retry (keep in Implementation) or proceed to Audit?
 */
export function shouldRetry(attempts: number): boolean {
	const n = typeof attempts !== "number" || Number.isNaN(attempts) || attempts < 0 ? 0 : attempts;
	return n < MAX_RETRIES;
}

// ═══════════════════════════════════════════════════════════════════════
// File Grouping
// ═══════════════════════════════════════════════════════════════════════

/**
 * Group modified files by their matching LSP server mapping.
 * Unsupported files are noted in errors.
 */
export function groupFilesByServer(
	files: string[],
	mappings: ServerMapping[],
): { serverFiles: Map<ServerMapping, string[]>; errors: string[] } {
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
		errors.push(`Unsupported file types (no LSP server configured): ${unsupported.join(", ")}`);
	}

	return { serverFiles, errors };
}

// ═══════════════════════════════════════════════════════════════════════
// LSP Client (private — manages one server lifecycle)
// ═══════════════════════════════════════════════════════════════════════

/** Per-file timeout in milliseconds */
const FILE_TIMEOUT_MS = 30_000;

/** vscode-jsonrpc imports (lazy — only loaded when LSP client runs) */
let StreamMessageReader: any;
let StreamMessageWriter: any;
let createMessageConnection: any;

function loadJsonRpc(): boolean {
	if (createMessageConnection) return true;
	try {
		const jsonrpc = require("vscode-jsonrpc");
		StreamMessageReader = jsonrpc.StreamMessageReader;
		StreamMessageWriter = jsonrpc.StreamMessageWriter;
		createMessageConnection = jsonrpc.createMessageConnection;
		return true;
	} catch {
		return false;
	}
}

/**
 * Map file extension to LSP language ID.
 */
function languageIdForExtension(ext: string): string {
	switch (ext) {
		case ".ts": return "typescript";
		case ".tsx": return "typescriptreact";
		case ".js": return "javascript";
		case ".jsx": return "javascriptreact";
		case ".py": return "python";
		case ".rs": return "rust";
		case ".go": return "go";
		default: return ext.slice(1);
	}
}

/**
 * Audit a group of files using a single LSP server instance.
 * Spawns the server, sends didOpen for each file, collects publishDiagnostics,
 * then shuts down.
 */
/** Audit a group of files using a single LSP server instance. Exported for testing. */
export async function auditFileGroup(
	mapping: ServerMapping,
	files: string[],
	worktreePath: string,
): Promise<AuditResult> {
	const errors: string[] = [];
	const allDiagnostics: LspDiagnostic[] = [];

	if (!loadJsonRpc()) {
		return { diagnostics: [], errors: [`vscode-jsonrpc not installed — cannot audit ${mapping.command}`], note: "" };
	}

	let child: ChildProcess | null = null;
	let connection: any = null;

	try {
		// Quick pre-check: is the LSP binary available?
		// This avoids vscode-jsonrpc internals emitting ERR_STREAM_DESTROYED
		// when spawn fails with ENOENT.
		try {
			const { execFileSync } = await import("node:child_process");
			execFileSync("which", [mapping.command], { stdio: "ignore", timeout: 5_000 });
		} catch {
			errors.push(`LSP server ${mapping.command} not found on PATH`);
			return { diagnostics: [], errors, note: "" };
		}

		// Spawn LSP server
		child = spawn(mapping.command, mapping.args, {
			cwd: worktreePath,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		child.on("error", (err) => {
			// child error tracked via errors[] array
		});

		// If spawn immediately failed (e.g. binary not found), handle early
		if (child.exitCode !== null && child.exitCode !== 0) {
			errors.push(`LSP server ${mapping.command} failed to start (exit ${child.exitCode})`);
			return { diagnostics: [], errors, note: "" };
		}

		// Handle destroyed streams from spawn failure
		if (child.stdin?.destroyed || child.stdout?.destroyed) {
			errors.push(`LSP server ${mapping.command} failed to start (streams destroyed)`);
			return { diagnostics: [], errors, note: "" };
		}

		const reader = new StreamMessageReader(child.stdout!);
		const writer = new StreamMessageWriter(child.stdin!);
		connection = createMessageConnection(reader, writer);

		// Capture connection-level errors (e.g. write to destroyed stream)
		connection.onError((err: Error) => {
			// connection error tracked via errors[] array
		});

		// Collect diagnostics
		const diagnosticsMap = new Map<string, LspDiagnostic[]>();
		const openedUris = new Set<string>();
		const diagnosedUris = new Set<string>();

		connection.onNotification((method: string, params: any) => {
			if (method === "textDocument/publishDiagnostics") {
				const uri: string = params?.uri || "";
				let filePath: string;
				try {
					filePath = decodeURIComponent(uri.replace(/^file:\/\//, ""));
				} catch {
					filePath = uri.replace(/^file:\/\//, "");
				}
				diagnosedUris.add(uri);
				const diags: any[] = params?.diagnostics || [];
				const mapped: LspDiagnostic[] = diags.map((d: any) => ({
					file: filePath,
					line: (d.range?.start?.line ?? 0) + 1, // LSP lines are 0-based
					column: (d.range?.start?.character ?? 0) + 1,
					severity: lspSeverityToLabel(d.severity ?? 1),
					message: d.message || "",
				}));
				diagnosticsMap.set(filePath, mapped);
			}
		});

		connection.listen();

		// Initialize
		const initResult = await withTimeout(
			connection.sendRequest("initialize", {
				processId: process.pid,
				rootUri: `file://${worktreePath}`,
				capabilities: {},
			}),
			FILE_TIMEOUT_MS,
		);

		if (!initResult) {
			errors.push(`LSP server ${mapping.command} timed out during initialize`);
			return { diagnostics: [], errors, note: "" };
		}

		// Send initialized notification
		connection.sendNotification("initialized", {});

		// Open each file with didOpen
		for (const file of files) {
			const fullPath = resolvePath(worktreePath, file);
			if (!existsSync(fullPath)) {
				errors.push(`File not found in worktree: ${file}`);
				continue;
			}

			const content = readFileSync(fullPath, "utf-8");
			const langId = languageIdForExtension(file.slice(file.lastIndexOf(".")).toLowerCase());
			const uri = `file://${fullPath}`;
			openedUris.add(uri);

			connection.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: langId,
					version: 1,
					text: content,
				},
			});
		}

		// Wait for publishDiagnostics notifications for all opened files (30s total timeout)
		const diagStartTime = Date.now();
		const DIAG_WAIT_TIMEOUT_MS = 30_000;
		while (Date.now() - diagStartTime < DIAG_WAIT_TIMEOUT_MS) {
			if (openedUris.size === 0) break;
			const allDiagnosed = [...openedUris].every(uri => diagnosedUris.has(uri));
			if (allDiagnosed) break;
			await sleep(200);
		}

		// Collect all diagnostics and filter by severity threshold
		for (const [, diags] of diagnosticsMap) {
			allDiagnostics.push(...diags);
		}

		// Apply per-server severity threshold (R3 AC3)
		const filtered = filterBySeverity(allDiagnostics, mapping.severityThreshold);

		// Shutdown
		await withTimeout(connection.sendRequest("shutdown", null), 10_000);
		connection.sendNotification("exit", null);
		connection.dispose();

		return { diagnostics: filtered, errors, note: "" };
	} catch (err: any) {
		// Server crash or protocol error
		errors.push(`LSP server ${mapping.command} error: ${err.message || String(err)}`);
		return { diagnostics: allDiagnostics, errors, note: "" };
	} finally {
		try {
			if (connection) connection.dispose();
		} catch { /* ignore */ }
		try {
			if (child) {
				// Remove all error listeners to prevent async errors after cleanup
				child.removeAllListeners("error");
				child.stdin?.removeAllListeners?.("error");
				child.stdout?.removeAllListeners?.("error");
				child.stderr?.removeAllListeners?.("error");
				if (child.exitCode === null) {
					child.kill("SIGTERM");
					setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* ignore */ } }, 5000);
				}
			}
		} catch { /* ignore */ }
	}
}

/** Map LSP diagnostic severity number to label string */
function lspSeverityToLabel(severity: number): "Error" | "Warning" | "Information" | "Hint" {
	switch (severity) {
		case 1: return "Error";
		case 2: return "Warning";
		case 3: return "Information";
		case 4: return "Hint";
		default: return "Information";
	}
}

/** Promise with timeout */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([
		promise,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
	]);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════
// runPreAudit — main hook called by supervisor
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run pre-audit LSP diagnostics on modified files.
 *
 * Called by supervisor before transitioning Implementation → Audit.
 * Returns { proceed: true } if audit passes (no errors) or retries exhausted.
 * Returns { proceed: false } if errors found and retries remain (Developer should fix).
 */
export async function runPreAudit(
	options: PreAuditOptions,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<PreAuditResult> {
	const { issueNum, worktreePath, defaultBranch } = options;

	// 1. Get modified files via git diff
	let gitOutput: string;
	try {
		const { execFileSync } = await import("node:child_process");
		const worktreeAbs = resolvePath(worktreePath);
		gitOutput = execFileSync("git", ["diff", defaultBranch, "--name-only"], {
			cwd: worktreeAbs,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 10_000,
		}).trim();
	} catch (err: any) {
		const msg = err.stderr?.toString() || err.message || String(err);
		pi.sendUserMessage?.(`LSP audit skipped: git diff failed (${msg})`, { deliverAs: "followUp" });
		return { proceed: true, note: `LSP audit skipped: git diff failed` };
	}

	const modifiedFiles = extractModifiedFiles(gitOutput, resolvePath(worktreePath));

	// AC3: No modified files → skip
	if (modifiedFiles.length === 0) {
		return { proceed: true, note: "LSP audit skipped: no modified files in Developer session" };
	}

	// 2. Load server mappings from settings (resolved relative to worktree)
	const settings = readSettings(resolvePath(worktreePath));
	const mappings = buildServerMappings(settings?.lspAuditor);

	// 3. Group files by server
	const { serverFiles, errors: groupingErrors } = groupFilesByServer(modifiedFiles, mappings);

	// 4. Audit each server group
	const results: AuditResult[] = [];
	for (const [mapping, files] of serverFiles) {
		if (files.length === 0) continue;

		const result = await auditFileGroup(mapping, files, resolvePath(worktreePath));
		results.push(result);
	}

	// Add unsupported note from grouping
	if (groupingErrors.length > 0) {
		results.push({ diagnostics: [], errors: groupingErrors, note: "" });
	}

	const merged = mergeResults(results);

	// If all LSP servers failed (no diagnostics collected, only errors)
	const hasServerErrors = merged.errors.length > 0;
	const hasNoDiagnostics = merged.diagnostics.length === 0;

	if (hasServerErrors && hasNoDiagnostics) {
		// All servers failed — skip audit, proceed with warning
		const note = `LSP audit skipped: all configured servers failed — ${merged.errors.join("; ")}`;
		return { proceed: true, note };
	}

	// 5. Diagnostics already filtered per-server by auditFileGroup (R3 AC3).
	// Filter by severity threshold is applied inside auditFileGroup based on
	// mapping.severityThreshold. Merged diagnostics here are already filtered.
	const filteredDiags: LspDiagnostic[] = merged.diagnostics;

	if (filteredDiags.length === 0) {
		// AC4: Zero errors/warnings → proceed to Audit with success note
		let note = "LSP audit: ✓ no errors or warnings detected";
		if (merged.errors.length > 0) {
			note += ` (server warnings: ${merged.errors.join("; ")})`;
		}
		return { proceed: true, note };
	}

	// 6. Check retry count
	const sessionManager = ctx.sessionManager;
	const entries = sessionManager.getEntries();
	const retryCount = countRetryAttempts(entries, issueNum);

	if (!shouldRetry(retryCount)) {
		// AC2: Retries exhausted → proceed to Audit with errors documented
		const formatted = formatDiagnostics(filteredDiags);
		const note = `LSP audit exhausted (${retryCount}/${MAX_RETRIES} retries). Remaining issues:\n${formatted}`;
		return { proceed: true, note };
	}

	// R2: Inject follow-up message to Developer, keep in Implementation
	const formatted = formatDiagnostics(filteredDiags);
	const attemptNum = retryCount + 1;
	const followUpMsg = [
		`## LSP Audit — Pre-Review Diagnostics (attempt ${attemptNum}/${MAX_RETRIES})`,
		``,
		`The following diagnostics were detected in your changes. Please fix them before the human Auditor reviews.`,
		``,
		formatted,
		(merged.errors.length > 0 ? `\nServer notes: ${merged.errors.join("; ")}` : ""),
	].join("\n");

	pi.sendUserMessage?.(followUpMsg, { deliverAs: "followUp" });

	// Record retry attempt
	pi.appendEntry?.(RETRY_ENTRY_TYPE, { issueNum, attempt: attemptNum, timestamp: new Date().toISOString() });

	return { proceed: false, note: `LSP audit: ${filteredDiags.length} issue(s) found — retry ${attemptNum}/${MAX_RETRIES}` };
}

// ═══════════════════════════════════════════════════════════════════════
// Settings helper
// ═══════════════════════════════════════════════════════════════════════

interface LspAuditorSettings {
	servers?: Array<{
		extensions: string[];
		command: string;
		args?: string[];
		severityThreshold?: string;
	}>;
}

interface PiSettings {
	supervisor?: unknown;
	lspAuditor?: LspAuditorSettings;
}

function readSettings(worktreePath: string): PiSettings | null {
	try {
		const settingsPath = resolvePath(worktreePath, ".pi/settings.json");
		if (!existsSync(settingsPath)) return null;
		return JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════

export default function lspAuditor(pi: ExtensionAPI) {
	// The extension is passive — it's called by supervisor directly via runPreAudit().
	// No lifecycle hooks needed at this time.
	// Register a command for manual triggering if desired:
	pi.registerCommand?.("lsp-auditor", {
		description: "Run LSP diagnostics on modified files (manual trigger)",
		handler: async (_args, ctx) => {
			const sm = ctx.sessionManager;
			const cwd = sm.getCwd();
			// Extract issue number from branch name or use default
			const result = await runPreAudit(
				{ issueNum: 0, worktreePath: cwd, defaultBranch: "main", repo: "" },
				pi,
				ctx,
			);
			pi.sendMessage?.({ content: `LSP Audit result: ${result.note}`, display: true });
		},
	});
}
