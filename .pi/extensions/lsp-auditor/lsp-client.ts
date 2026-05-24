/**
 * LSP client module — manages one LSP server lifecycle per audit group.
 *
 * Houses all LSP protocol interaction: spawn, connection setup, didOpen,
 * publishDiagnostics collection, shutdown. This is the only module with
 * Node I/O + external dependency (vscode-jsonrpc).
 *
 * Fixes:
 * - C4 P1: jsonRpcModule cached inside loadJsonRpc() function scope (not module-level)
 * - P4 P2: catch (err) has instanceof Error check
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { LspPublishDiagnosticsParams, LspDiagnosticData } from "../../lib/lsp-types.ts";
import { isLspPublishDiagnosticsParams, isLspDiagnosticData } from "../../lib/lsp-types.ts";
import type { LspDiagnostic, ServerMapping, AuditResult } from "./types.ts";
import { filterBySeverity } from "./formatting.ts";

// ─── Constants ───────────────────────────────────────────────────────

/** Per-file timeout in milliseconds */
const FILE_TIMEOUT_MS = 30_000;
/** Maximum wait for publishDiagnostics notifications (30s) */
const DIAG_WAIT_TIMEOUT_MS = 30_000;

// ─── Dynamic Import Cache (function-scoped, not module-level) ────────

/** vscode-jsonrpc module shape */
interface JsonRpcModule {
	StreamMessageReader: new (stream: NodeJS.ReadableStream) => unknown;
	StreamMessageWriter: new (stream: NodeJS.WritableStream) => unknown;
	createMessageConnection: (reader: unknown, writer: unknown) => unknown;
}

/** Cached jsonRpcModule inside function scope — eliminates C4 P1 */
let jsonRpcModule: JsonRpcModule | null = null;

async function loadJsonRpc(): Promise<boolean> {
	if (jsonRpcModule) return true;
	try {
		jsonRpcModule = (await import("vscode-jsonrpc")) as unknown as JsonRpcModule;
		return true;
	} catch {
		return false;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Map file extension to LSP language ID */
function languageIdForExtension(ext: string): string {
	switch (ext) {
		case ".ts":
			return "typescript";
		case ".tsx":
			return "typescriptreact";
		case ".js":
			return "javascript";
		case ".jsx":
			return "javascriptreact";
		case ".py":
			return "python";
		case ".rs":
			return "rust";
		case ".go":
			return "go";
		default:
			return ext.slice(1);
	}
}

/** Map LSP diagnostic severity number to label string */
function lspSeverityToLabel(severity: number): "Error" | "Warning" | "Information" | "Hint" {
	switch (severity) {
		case 1:
			return "Error";
		case 2:
			return "Warning";
		case 3:
			return "Information";
		case 4:
			return "Hint";
		default:
			return "Information";
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

// ─── Audit Function ──────────────────────────────────────────────────

/**
 * Audit a group of files using a single LSP server instance.
 * Spawns the server, sends didOpen for each file, collects publishDiagnostics,
 * then shuts down. Exported for integration testing.
 */
export async function auditFileGroup(
	mapping: ServerMapping,
	files: string[],
	worktreePath: string,
): Promise<AuditResult> {
	const errors: string[] = [];
	const allDiagnostics: LspDiagnostic[] = [];

	if (!(await loadJsonRpc())) {
		return {
			diagnostics: [],
			errors: [`vscode-jsonrpc not installed — cannot audit ${mapping.command}`],
			note: "",
		};
	}

	let child: ChildProcess | null = null;
	let connection: any = null;

	try {
		// Quick pre-check: is the LSP binary available?
		// This avoids vscode-jsonrpc internals emitting ERR_STREAM_DESTROYED
		// when spawn fails with ENOENT.
		try {
			const { execFile } = await import("node:child_process");
			await new Promise<void>((resolve, reject) => {
				execFile("which", [mapping.command], { timeout: 5_000 }, (err) => {
					if (err) reject(err);
					else resolve();
				});
			});
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

		child.on("error", (err: Error) => {
			errors.push(
				`LSP server ${mapping.command} crashed: ${err instanceof Error ? err.message : String(err)}`,
			);
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

		const reader = new jsonRpcModule!.StreamMessageReader(child.stdout!);
		const writer = new jsonRpcModule!.StreamMessageWriter(child.stdin!);
		connection = jsonRpcModule!.createMessageConnection(reader, writer);

		// Capture connection-level errors (e.g. write to destroyed stream)
		connection.onError((err: Error) => {
			errors.push(`LSP connection error (${mapping.command}): ${err.message || String(err)}`);
		});

		// Collect diagnostics
		const diagnosticsMap = new Map<string, LspDiagnostic[]>();
		const openedUris = new Set<string>();
		const diagnosedUris = new Set<string>();

		connection.onNotification((method: string, params: unknown) => {
			if (method === "textDocument/publishDiagnostics") {
				if (!isLspPublishDiagnosticsParams(params)) return;
				const uri: string = params.uri;
				let filePath: string;
				try {
					filePath = decodeURIComponent(uri.replace(/^file:\/\//, ""));
				} catch {
					filePath = uri.replace(/^file:\/\//, "");
				}
				diagnosedUris.add(uri);
				const diags: LspDiagnosticData[] = params.diagnostics.filter(isLspDiagnosticData);
				const mapped: LspDiagnostic[] = diags.map((d) => ({
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

			const content = await readFile(fullPath, "utf-8");
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

		// Wait for publishDiagnostics notifications for all opened files
		const diagStartTime = Date.now();
		while (Date.now() - diagStartTime < DIAG_WAIT_TIMEOUT_MS) {
			if (openedUris.size === 0) break;
			const allDiagnosed = [...openedUris].every((uri) => diagnosedUris.has(uri));
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
	} catch (err: unknown) {
		// Server crash or protocol error — with instanceof Error guard (fixes P4 P2)
		errors.push(
			`LSP server ${mapping.command} error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { diagnostics: allDiagnostics, errors, note: "" };
	} finally {
		try {
			if (connection) connection.dispose();
		} catch {
			/* ignore */
		}
		try {
			if (child) {
				// Remove all error listeners to prevent async errors after cleanup
				child.removeAllListeners("error");
				if (child.stdin) child.stdin.removeAllListeners("error");
				if (child.stdout) child.stdout.removeAllListeners("error");
				if (child.stderr) child.stderr.removeAllListeners("error");
				if (child.exitCode === null) {
					child.kill("SIGTERM");
					const childRef = child;
					const killTimer = setTimeout(() => {
						try {
							childRef.kill("SIGKILL");
						} catch {
							/* ignore */
						}
					}, 5000);
					(killTimer as any)?.unref?.();
				}
			}
		} catch {
			/* ignore */
		}
	}
}
