/**
 * session-logger — Session report & enriched metadata
 *
 * Generates .md reports alongside .jsonl session files, tracks tool
 * execution lifecycle, per-turn token breakdown, file access, and errors.
 *
 * Toggle with /session-logger.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionStats, computeToolStats } from "./stats.ts";
import type { StatsSnapshot } from "./stats.ts";
import { createFileOps } from "./files.ts";
import { renderSessionToMarkdown, parseSessionStats } from "./renderer.ts";
import type { ParsedSessionStats } from "./renderer.ts";
import type { Metadata } from "./types.ts";

export interface SessionLoggerGate {
	enabledForNextSession: boolean;
	sessionEnabled: boolean;
}

export function createSessionLoggerGate(initiallyEnabled = true): SessionLoggerGate {
	return {
		enabledForNextSession: initiallyEnabled,
		sessionEnabled: initiallyEnabled,
	};
}

export function toggleSessionLoggerGate(gate: SessionLoggerGate, args?: string): boolean {
	const normalized = args?.toLowerCase();
	if (normalized === "on") gate.enabledForNextSession = true;
	else if (normalized === "off") gate.enabledForNextSession = false;
	else gate.enabledForNextSession = !gate.enabledForNextSession;
	return gate.enabledForNextSession;
}

export function beginSessionLoggerSession(gate: SessionLoggerGate): boolean {
	gate.sessionEnabled = gate.enabledForNextSession;
	return gate.sessionEnabled;
}

export default function (pi: ExtensionAPI): void {
	const gate = createSessionLoggerGate();

	pi.registerCommand("session-logger", {
		description: "Toggle session report on/off (takes effect next session)",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase();
			const enabled = toggleSessionLoggerGate(gate, cmd);
			ctx.ui.notify(`Session logger: ${enabled ? "ON" : "OFF"} (applies to next session)`, "info");
		},
	});

	const stats = createSessionStats();
	const files = createFileOps();
	let sessionFile: string | undefined;
	let sessionsDir: string | undefined;

	// ── Session lifecycle ──

	pi.on("session_start", async (event, ctx) => {
		if (!beginSessionLoggerSession(gate)) return;

		const sm = ctx.sessionManager;
		sessionFile = sm.getSessionFile();
		if (!sessionFile) return;

		stats.reset();
		stats.seedStats(sm);

		sessionsDir = path.resolve(sm.getCwd(), ".pi", "sessions");
		await files.ensureSymlink(sessionFile!, sessionsDir!);

		// Recovery: scan all .jsonl files in sessions dir for missing .md/.metadata.json.
		// If session_shutdown didn't fire (crash, kill, race), we catch up now.
		if (sessionsDir && fs.existsSync(sessionsDir)) {
			let jsonlFiles: string[] = [];
			try {
				jsonlFiles = fs
					.readdirSync(sessionsDir)
					.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));
			} catch {
				// Can't read sessions dir — skip recovery
			}

			for (const file of jsonlFiles) {
				const jsonlPath = path.join(sessionsDir, file);

				// Skip current in-progress session — file may be incomplete
				if (sessionFile && jsonlPath === sessionFile) continue;

				// Defer to next tick — don't block session start
				Promise.resolve().then(() =>
					generateMissingReports(jsonlPath, files).catch((err) => {
						console.error(
							`[session-logger] Recovery failed for ${file}: ${(err as Error).message}`,
						);
					}),
				);
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!gate.sessionEnabled) return;

		const sm = ctx.sessionManager;
		const sf = sm.getSessionFile();
		if (!sf) return;

		// Capture in-memory tool execution timing before shutdown.
		// This bridges accurate start/end times into metadata.
		const snapshot = stats.getSnapshot();

		// Wrap everything so one failure doesn't block the rest.
		// Pi's extension runner catches errors silently per-handler —
		// an uncaught throw stops execution of this handler entirely.
		try {
			await generateMissingReports(sf, files, snapshot);
		} catch (err) {
			console.error(`[session-logger] Shutdown handler failed: ${(err as Error).message}`);
		}
	});

	pi.on("session_compact", async (_event, _ctx) => {
		if (!gate.sessionEnabled) return;
		stats.incrementCompaction();
	});

	// ── Model / thinking changes ──

	pi.on("model_select", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;
		stats.modelChange(event.model.provider, event.model.id);
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;
		stats.thinkingChange(event.level);
	});

	// ── Turn lifecycle ──

	pi.on("turn_start", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;
		stats.recordTurnStart(event.turnIndex);
	});

	pi.on("turn_end", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;
		stats.recordTurnEnd();
	});

	// ── Message tracking ──

	pi.on("message_end", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;
		if (event.message.role === "assistant") stats.addUsage(event.message.usage);
	});

	// ── Tool execution lifecycle ──

	pi.on("tool_execution_start", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;
		stats.recordToolStart(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;
		// Calculate result size from content
		const content = event.result?.content ?? [];
		let size = 0;
		for (const c of content) {
			if (c.type === "text") size += c.text?.length ?? 0;
		}
		stats.recordToolEnd(event.toolCallId, event.isError ?? false, size);
	});

	// ── File modification tracking via tool_call interception ──

	pi.on("tool_call", async (event, _ctx) => {
		if (!gate.sessionEnabled) return;

		if (isToolCallEventType("read", event)) {
			stats.recordFileModification("read", event.input.path);
		} else if (isToolCallEventType("write", event)) {
			stats.recordFileModification("write", event.input.path, event.input.content?.length ?? 0);
		} else if (isToolCallEventType("edit", event)) {
			stats.recordFileModification("edit", event.input.path);
		}
	});
}

/**
 * Generate metadata.json and .md report for a session file if they're missing.
 * Called from session_shutdown (primary) and session_start (recovery).
 */
/**
 * Scan sessions directory for .jsonl files missing .md reports and generate them.
 * Called on session_start to catch sessions that missed shutdown handler.
 */
export function recoverMissingReports(
	sessionsDir: string,
	currentSessionFile: string,
	files: ReturnType<typeof createFileOps>,
): void {
	if (!fs.existsSync(sessionsDir)) return;

	const entries = fs.readdirSync(sessionsDir);
	const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));

	for (const entry of jsonlFiles) {
		const jsonlPath = path.resolve(sessionsDir, entry);
		// Resolve symlink to real path if needed
		let realPath: string;
		try {
			realPath = fs.realpathSync(jsonlPath);
		} catch {
			realPath = jsonlPath;
		}

		// Skip current session — its report is generated on shutdown
		if (realPath === currentSessionFile) continue;

		const prefix = path.basename(entry, ".jsonl");
		const mdPath = path.join(sessionsDir, `${prefix}.md`);
		if (fs.existsSync(mdPath)) continue;

		// Generate missing report synchronously (already in async handler)
		generateMissingReports(realPath, files).catch((err) =>
			console.error(`[session-logger] Recovery failed for ${realPath}: ${(err as Error).message}`),
		);
	}
}

export async function generateMissingReports(
	sessionFilePath: string,
	files: ReturnType<typeof createFileOps>,
	snapshot?: StatsSnapshot,
): Promise<void> {
	// Check if the JSONL file still exists (might have been cleaned up)
	if (!fs.existsSync(sessionFilePath)) return;

	const sessionDir = path.dirname(sessionFilePath);
	const sessionPrefix = path.basename(sessionFilePath, ".jsonl");

	// Skip if both metadata and MD already exist
	const metaPath = path.join(sessionDir, `${sessionPrefix}.metadata.json`);
	const mdPath = path.join(sessionDir, `${sessionPrefix}.md`);
	if (fs.existsSync(metaPath) && fs.existsSync(mdPath)) return;

	// Parse stats from JSONL — source of truth
	let parsed: ParsedSessionStats | null = null;
	try {
		parsed = parseSessionStats(sessionFilePath);
	} catch (err) {
		console.error(`[session-logger] Failed to parse ${sessionFilePath}: ${(err as Error).message}`);
		return;
	}

	if (!parsed) return;

	// Build tool stats — prefer in-memory timing when snapshot is available.
	// Parsed stats are source of truth for call/error counts (message replay).
	// In-memory stats provide accurate totalDurationMs.
	let toolStats = parsed.toolStats;
	if (snapshot) {
		const computedStats = computeToolStats(snapshot.toolExecutions);
		const merged = { ...parsed.toolStats };
		for (const [toolName, stats] of Object.entries(computedStats)) {
			if (merged[toolName]) {
				// Keep parsed call/error counts, override duration from memory
				merged[toolName].totalDurationMs = stats.totalDurationMs;
			} else {
				// Tool exists in memory but not in JSONL — add it
				merged[toolName] = stats;
			}
		}
		toolStats = merged;
	}

	const meta: Metadata = {
		sessionId: parsed.sessionId,
		name: undefined,
		messages: parsed.entryCount,
		tokens: parsed.tokens,
		cost: parsed.cost,
		compactions: parsed.compactions,
		modelChanges: parsed.models.map((m) => ({
			time: parsed!.timestamp,
			model: m,
		})),
		thinkingChanges: parsed.thinkingLevels.map((l) => ({
			time: parsed!.timestamp,
			level: l,
		})),
		perTurnTokens: parsed.perTurnTokens,
		toolStats,
		fileModifications: parsed.fileModifications,
	};

	// Write metadata if missing
	if (!fs.existsSync(metaPath)) {
		try {
			fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
			await files.ensureLatestMetadataSymlink(sessionDir, metaPath);
		} catch (err) {
			console.error(`[session-logger] Failed to write metadata: ${(err as Error).message}`);
		}
	}

	// Generate .md report if missing
	if (!fs.existsSync(mdPath)) {
		try {
			const md = renderSessionToMarkdown(sessionFilePath);
			fs.writeFileSync(mdPath, md, "utf-8");
			await files.ensureMdSymlink(sessionDir, mdPath);
		} catch (err) {
			console.error(`[session-logger] Failed to write report: ${(err as Error).message}`);
		}
	}
}
