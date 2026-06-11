/**
 * tsc-checkpoint — Incremental type-checking with watch mode
 *
 * Wraps TypeScript's watch compiler API to provide incremental re-checks,
 * cached diagnostics, file-path resolution, and diagnostic trending.
 * Trigger manually with /check.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import ts from "typescript";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

export interface TscDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error";
	message: string;
	code?: string;
	/** Absolute path to the file (resolved from tsconfig dir) */
	filePath: string;
}

export interface TscWatchOptions {
	/** Polling interval in ms (reserved for future polling mode) */
	pollInterval?: number;
}

export interface DiagnosticTrend {
	current: number;
	previous: number;
	direction: "improved" | "regressed" | "stable";
	delta: number;
}

export interface TscCheckpointResult {
	diagnostics: TscDiagnostic[];
	hasErrors: boolean;
	trend?: DiagnosticTrend;
}

// ═══════════════════════════════════════════════════════════════════════
// Adapter Interface
// ═══════════════════════════════════════════════════════════════════════

export interface TscWatchAdapter {
	/** Start watching a tsconfig. Returns true if started, false if already running. */
	start(tsconfigPath: string): boolean;
	/** Stop the watch process. */
	stop(): void;
	/** Whether the watcher is currently running. */
	isRunning(): boolean;
	/** Get the latest cached diagnostics. */
	getDiagnostics(): TscDiagnostic[];
	/** Register a callback for when diagnostics change. */
	onDiagnosticsChange(callback: (diagnostics: TscDiagnostic[]) => void): void;
}

// ═══════════════════════════════════════════════════════════════════════
// Real Adapter: TypeScript Watch Compiler API
// ═══════════════════════════════════════════════════════════════════════

class TypeScriptWatchAdapter implements TscWatchAdapter {
	private watchProgram: ts.WatchOfConfigFile<ts.BuilderProgram> | undefined;
	private diagnostics: TscDiagnostic[] = [];
	private running = false;
	private listeners: Array<(diagnostics: TscDiagnostic[]) => void> = [];
	private tsconfigDir = "";

	start(tsconfigPath: string): boolean {
		if (this.running) return false;
		this.tsconfigDir = dirname(tsconfigPath);
		this.diagnostics = [];

		const host = ts.createWatchCompilerHost(
			tsconfigPath,
			{ noEmit: true },
			ts.sys,
			ts.createEmitAndSemanticDiagnosticsBuilderProgram,
			(diagnostic: ts.Diagnostic) => {
				if (diagnostic.category !== ts.DiagnosticCategory.Error) return;
				this.handleDiagnostic(diagnostic);
			},
			(
				diagnostic: ts.Diagnostic,
				newLine: string,
				options: ts.CompilerOptions,
				errorCount?: number,
			) => {
				if (errorCount === undefined) {
					// New compilation cycle starting — clear previous diagnostics
					this.diagnostics = [];
				} else {
					// Compilation complete — notify listeners
					this.notifyListeners();
				}
			},
		);

		this.watchProgram = ts.createWatchProgram(host);
		this.running = true;
		return true;
	}

	private handleDiagnostic(diagnostic: ts.Diagnostic): void {
		const diag = diagnosticToTscDiagnostic(diagnostic, this.tsconfigDir);
		if (diag) {
			this.diagnostics.push(diag);
		}
	}

	private notifyListeners(): void {
		const snapshot = [...this.diagnostics];
		for (const listener of this.listeners) {
			listener(snapshot);
		}
	}

	stop(): void {
		this.watchProgram?.close();
		this.running = false;
		this.watchProgram = undefined;
	}

	isRunning(): boolean {
		return this.running;
	}

	getDiagnostics(): TscDiagnostic[] {
		return [...this.diagnostics];
	}

	onDiagnosticsChange(callback: (diagnostics: TscDiagnostic[]) => void): void {
		this.listeners.push(callback);
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Default Adapter Factory
// ═══════════════════════════════════════════════════════════════════════

export function createDefaultAdapter(): TscWatchAdapter {
	return new TypeScriptWatchAdapter();
}

// ═══════════════════════════════════════════════════════════════════════
// DiagnosticsWatcher
// ═══════════════════════════════════════════════════════════════════════

export class DiagnosticsWatcher {
	private adapter: TscWatchAdapter;
	private cachedDiagnostics: TscDiagnostic[] = [];
	private running = false;
	private trendHistory: number[] = [];
	private diagnosticListeners: Array<(d: TscDiagnostic[]) => void> = [];
	private tsconfigPath: string;
	private watchOptions: TscWatchOptions;

	constructor(tsconfigPath: string, watchOptions?: TscWatchOptions, adapter?: TscWatchAdapter) {
		this.tsconfigPath = tsconfigPath;
		this.watchOptions = watchOptions ?? {};
		this.adapter = adapter ?? createDefaultAdapter();

		// Forward adapter diagnostic events
		this.adapter.onDiagnosticsChange((diags: TscDiagnostic[]) => {
			this.cachedDiagnostics = diags;
			const errorCount = diags.filter((d) => d.severity === "Error").length;
			this.trendHistory.push(errorCount);
			for (const listener of this.diagnosticListeners) {
				listener(diags);
			}
		});
	}

	get tsconfigPathValue(): string {
		return this.tsconfigPath;
	}

	get watchOptionsValue(): TscWatchOptions {
		return { ...this.watchOptions };
	}

	/**
	 * Start the watcher. Returns true if started, false if already running.
	 * Throws if tsconfig does not exist.
	 */
	start(): boolean {
		if (this.running) return false;
		if (!existsSync(this.tsconfigPath)) {
			throw new Error(`tsconfig not found: ${this.tsconfigPath}`);
		}
		const started = this.adapter.start(this.tsconfigPath);
		this.running = started;
		return started;
	}

	/** Stop the watcher. No-op if not running. */
	stop(): void {
		if (!this.running) return;
		this.adapter.stop();
		this.running = false;
	}

	/** Whether the watcher is currently running. */
	isRunning(): boolean {
		return this.running;
	}

	/** Get the latest cached diagnostics. */
	getDiagnostics(): TscDiagnostic[] {
		return this.cachedDiagnostics;
	}

	/** Register a callback for when diagnostics change. */
	onDiagnosticsChange(listener: (d: TscDiagnostic[]) => void): void {
		this.diagnosticListeners.push(listener);
	}

	/**
	 * Get the diagnostic trend between the last two checks.
	 * Returns undefined if fewer than 2 data points exist.
	 */
	getTrend(): DiagnosticTrend | undefined {
		if (this.trendHistory.length < 2) return undefined;
		const current = this.trendHistory[this.trendHistory.length - 1]!;
		const previous = this.trendHistory[this.trendHistory.length - 2]!;
		const delta = current - previous;
		return {
			current,
			previous,
			direction: delta < 0 ? "improved" : delta > 0 ? "regressed" : "stable",
			delta: Math.abs(delta),
		};
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * Resolve a diagnostic's file path to absolute.
 * If already absolute, return as-is. Otherwise, resolve against tsconfigDir.
 */
export function resolveDiagnosticFilePath(file: string, tsconfigDir: string): string {
	if (file.startsWith("/")) return file;
	if (/^[A-Za-z]:[/\\]/.test(file)) return file; // Windows absolute
	return resolve(tsconfigDir, file);
}

/**
 * Format a diagnostic trend for display.
 */
export function formatTrend(trend: DiagnosticTrend): string {
	const arrow = trend.direction === "regressed" ? "↑" : trend.direction === "improved" ? "↓" : "→";
	return `${trend.current} errors (${arrow} ${trend.delta}, was ${trend.previous})`;
}

/**
 * Format diagnostics as clickable file paths with line numbers.
 */
export function formatDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (diagnostics.length === 0) return "";
	return diagnostics
		.map((d) => {
			const codePart = d.code ? ` (${d.code})` : "";
			return `${d.filePath}, Line ${d.line}: [${d.severity}] ${d.message}${codePart}`;
		})
		.join("\n");
}

/**
 * Format diagnostics as structured JSON output for programmatic consumers.
 * Used in JSON, RPC, and print modes.
 */
export function formatDiagnosticsJson(
	diagnostics: TscDiagnostic[],
	trend?: DiagnosticTrend,
): {
	diagnostics: TscDiagnostic[];
	summary: string;
	fileCount: number;
} {
	let summary: string;
	if (diagnostics.length === 0) {
		summary = "No type errors detected";
	} else {
		const baseSummary = `${diagnostics.length} type error(s) found`;
		if (trend) {
			const directionLabel =
				trend.direction === "regressed"
					? "regressed ↑"
					: trend.direction === "improved"
						? "improved ↓"
						: "stable →";
			summary = `${baseSummary} (${directionLabel} ${trend.delta}, was ${trend.previous})`;
		} else {
			summary = baseSummary;
		}
	}
	return {
		diagnostics,
		summary,
		fileCount: new Set(diagnostics.map((d) => d.filePath)).size,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Backward-Compatible Exports
// ═══════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use `formatDiagnostics` instead.
 * Kept for backward compatibility with supervisor pipeline.
 * Uses the old format: grouped by file, sorted by line, with relative paths.
 */
export function formatTscDiagnostics(diagnostics: TscDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	// Group by file (use `file` field for backward compat)
	const byFile = new Map<string, TscDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		diags.sort((a, b) => (a.line !== b.line ? a.line - b.line : a.column - b.column));

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const codePart = d.code ? ` (${d.code})` : "";
			lines.push(`${d.file}, Line ${d.line}: [${d.severity}] ${msg}${codePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

/**
 * Map a TypeScript diagnostic to the TscDiagnostic shape.
 * Returns undefined if the diagnostic has no source file (e.g. global errors).
 */
export function diagnosticToTscDiagnostic(
	diagnostic: ts.Diagnostic,
	configDir: string,
): TscDiagnostic | undefined {
	const file = diagnostic.file;
	if (!file) return undefined;

	const start = diagnostic.start ?? 0;
	const { line, character } = file.getLineAndCharacterOfPosition(start);
	const message =
		typeof diagnostic.messageText === "string"
			? diagnostic.messageText
			: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");

	return {
		file: file.fileName,
		line: line + 1,
		column: character + 1,
		severity: "Error",
		message,
		code: `TS${diagnostic.code}`,
		filePath: resolveDiagnosticFilePath(file.fileName, configDir),
	};
}

/**
 * Runs a one-shot tsc check using the TypeScript compiler API.
 * Uses ts.createProgram() instead of watch mode — no file watchers,
 * no incremental state, no lingering callbacks.
 */
export async function runTscCheckpoint(worktreePath: string): Promise<TscCheckpointResult> {
	const configPath = resolve(worktreePath, "tsconfig.json");

	if (!existsSync(configPath)) {
		return { diagnostics: [], hasErrors: false };
	}

	// Parse tsconfig — fallback gracefully on parse failure
	const parsedConfig = ts.getParsedCommandLineOfConfigFile(
		configPath,
		{ noEmit: true },
		ts.sys as unknown as ts.ParseConfigFileHost,
	);

	if (!parsedConfig) {
		return { diagnostics: [], hasErrors: false };
	}

	const configDir = dirname(configPath);
	const program = ts.createProgram({
		rootNames: parsedConfig.fileNames,
		options: parsedConfig.options,
	});

	const allDiagnostics = ts.getPreEmitDiagnostics(program);
	const hasErrors = allDiagnostics.some((d) => d.category === ts.DiagnosticCategory.Error);

	const mapped: TscDiagnostic[] = hasErrors
		? allDiagnostics
				.filter((d) => d.category === ts.DiagnosticCategory.Error)
				.map((d) => diagnosticToTscDiagnostic(d, configDir))
				.filter((d): d is TscDiagnostic => d !== undefined)
		: [];

	return { diagnostics: mapped, hasErrors };
}

// ═══════════════════════════════════════════════════════════════════════
// Extension Entry Point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Register /check command for incremental tsc type-check.
 *
 * The first /check call spawns a TypeScript watch compiler that
 * incrementally re-checks on file changes. Subsequent /check calls
 * return the cached diagnostics from the last compilation.
 */
export default function tscCheckpoint(pi: ExtensionAPI): void {
	let watcher: DiagnosticsWatcher | null = null;

	// Clean up watcher when the session ends to prevent file watcher leaks
	pi.on?.("session_shutdown", () => {
		if (watcher) {
			watcher.stop();
			watcher = null;
		}
	});

	pi.registerCommand?.("check", {
		description: "Run tsc --noEmit type-check on the current worktree (incremental watch mode)",
		handler: async (_args, ctx) => {
			const worktreePath = ctx.cwd;
			const tsconfigPath = resolve(worktreePath, "tsconfig.json");

			if (!existsSync(tsconfigPath)) {
				pi.sendUserMessage?.(
					"## TSC Checkpoint\n\nNo `tsconfig.json` found in worktree root. Skipping type-check.",
					{ deliverAs: "followUp" },
				);
				return;
			}

			// ── Trust Gate ──────────────────────────────────────────────
			// Guard against unsafe project-local tsconfig before starting
			// the watch compiler. Use optional chaining for backward compat
			// with older pi-coding-agent versions where isProjectTrusted may
			// not be present in the type definitions.
			const isTrusted = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.();
			if (isTrusted === false) {
				pi.sendUserMessage?.(
					"## TSC Checkpoint — Project not trusted\n\nProject not trusted. Skipping type-check to avoid running `tsc` against potentially unsafe project-local configurations.",
					{ deliverAs: "followUp" },
				);
				return;
			}

			// Create watcher lazily on first /check
			if (!watcher) {
				watcher = new DiagnosticsWatcher(tsconfigPath);
			}

			if (!watcher.isRunning()) {
				try {
					watcher.start();
					pi.sendUserMessage?.("## TSC Checkpoint\n\nRunning `tsc` in incremental watch mode...", {
						deliverAs: "followUp",
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					pi.sendUserMessage?.(`## TSC Checkpoint — Error\n\nFailed to start watcher: ${msg}`, {
						deliverAs: "followUp",
					});
					return;
				}
			}

			const diagnostics = watcher.getDiagnostics();
			const trend = watcher.getTrend();

			// ── Mode-Adapted Output ─────────────────────────────────────
			// TUI mode: markdown with clickable file paths.
			// JSON/RPC/Print mode: structured JSON for programmatic consumers.
			if (ctx.mode === "tui") {
				if (diagnostics.length > 0) {
					const formatted = formatDiagnostics(diagnostics);
					const errorCount = diagnostics.length;
					let msg = `## TSC Checkpoint — ${errorCount} Type Error(s) Found`;
					if (trend) {
						const directionLabel =
							trend.direction === "regressed"
								? "⚠️ regression"
								: trend.direction === "improved"
									? "✓ improved"
									: "→ stable";
						msg += ` (${directionLabel})`;
					}
					msg += `\n\n${formatted}`;
					pi.sendUserMessage?.(msg, { deliverAs: "followUp" });
				} else {
					let msg = "## TSC Checkpoint — ✓ No type errors detected";
					if (trend && trend.current === 0 && trend.previous > 0) {
						msg += " (✓ all errors resolved)";
					}
					pi.sendUserMessage?.(msg, { deliverAs: "followUp" });
				}
			} else {
				// JSON/RPC/Print mode: structured JSON
				const jsonOutput = formatDiagnosticsJson(diagnostics, trend ?? undefined);
				const message = JSON.stringify({
					type: "tsc-checkpoint",
					...jsonOutput,
					...(trend ? { trend } : {}),
				});
				pi.sendUserMessage?.(message, { deliverAs: "followUp" });
			}
		},
	});
}
