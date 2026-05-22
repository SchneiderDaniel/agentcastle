/**
 * session-logger — Session report & enriched metadata
 *
 * Generates .md reports alongside .jsonl session files, tracks tool
 * execution lifecycle, per-turn token breakdown, file access, and errors.
 *
 * Toggle with /session-logger.
 */

import * as path from "node:path";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionStats } from "./stats.js";
import { createFileOps } from "./files.js";
import { renderSessionToMarkdown } from "./renderer.js";
import type { Metadata } from "./types.js";

export default function (pi: ExtensionAPI): void {
	let enabled = true;

	pi.registerCommand("session-logger", {
		description: "Toggle session report on/off (takes effect next session)",
		handler: async (args, ctx) => {
			if (args === "on") enabled = true;
			else if (args === "off") enabled = false;
			else enabled = !enabled;
			ctx.ui.notify(`Session logger: ${enabled ? "ON" : "OFF"} (applies to next session)`, "info");
		},
	});

	const stats = createSessionStats();
	const files = createFileOps();
	let sessionFile: string | undefined;
	let sessionsDir: string | undefined;

	// ── Session lifecycle ──

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) return;

		const sm = ctx.sessionManager;
		sessionFile = sm.getSessionFile();
		if (!sessionFile) return;

		stats.reset();
		stats.seedStats(sm);

		sessionsDir = path.resolve(sm.getCwd(), ".pi", "sessions");
		await files.ensureSymlink(sessionFile, sessionsDir);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enabled || !sessionFile) return;

		const sm = ctx.sessionManager;
		const snap = stats.getSnapshot();

		const meta: Metadata = {
			sessionId: sm.getSessionId(),
			name: sm.getSessionName() || undefined,
			messages: sm.getEntries().length,
			tokens: {
				input: snap.totalInputTokens,
				output: snap.totalOutputTokens,
				cacheRead: snap.totalCacheRead,
				cacheWrite: snap.totalCacheWrite,
				total:
					snap.totalInputTokens +
					snap.totalOutputTokens +
					snap.totalCacheRead +
					snap.totalCacheWrite,
			},
			cost: snap.totalCost,
			compactions: snap.compactionCount,
			modelChanges: snap.modelChanges,
			thinkingChanges: snap.thinkingChanges,
			perTurnTokens: snap.perTurnTokens,
			toolStats: computeToolStats(snap.toolExecutions),
			fileModifications: snap.fileModifications,
		};

		const sessionDir = path.dirname(sessionFile);

		// Write metadata
		const metaPath = path.join(sessionDir, `${meta.sessionId}.metadata.json`);
		await files.writeMetadata(sessionDir, meta.sessionId, meta);
		await files.ensureLatestMetadataSymlink(sessionDir, metaPath);

		// Generate .md report
		try {
			const md = renderSessionToMarkdown(sessionFile);
			const mdPath = path.join(sessionDir, `${meta.sessionId}.md`);
			await files.writeSessionReport(sessionDir, meta.sessionId, md);
			await files.ensureMdSymlink(sessionDir, mdPath);
		} catch (err) {
			console.error(`[session-logger] Failed to generate report: ${(err as Error).message}`);
		}
	});

	pi.on("session_compact", async (_event, _ctx) => {
		if (!enabled) return;
		stats.incrementCompaction();
	});

	// ── Model / thinking changes ──

	pi.on("model_select", async (event, _ctx) => {
		if (!enabled) return;
		stats.modelChange(event.model.provider, event.model.id);
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		if (!enabled) return;
		stats.thinkingChange(event.level);
	});

	// ── Turn lifecycle ──

	pi.on("turn_start", async (event, _ctx) => {
		if (!enabled) return;
		stats.recordTurnStart(event.turnIndex);
	});

	pi.on("turn_end", async (event, _ctx) => {
		if (!enabled) return;
		stats.recordTurnEnd();
	});

	// ── Message tracking ──

	pi.on("message_end", async (event, _ctx) => {
		if (!enabled) return;
		if (event.message.role === "assistant") stats.addUsage(event.message.usage);
	});

	// ── Tool execution lifecycle ──

	pi.on("tool_execution_start", async (event, _ctx) => {
		if (!enabled) return;
		stats.recordToolStart(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		if (!enabled) return;
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
		if (!enabled) return;

		if (isToolCallEventType("read", event)) {
			stats.recordFileModification("read", event.input.path);
		} else if (isToolCallEventType("write", event)) {
			stats.recordFileModification("write", event.input.path, event.input.content?.length ?? 0);
		} else if (isToolCallEventType("edit", event)) {
			stats.recordFileModification("edit", event.input.path);
		}
	});
}

/** Aggregate tool executions into a summary map. */
function computeToolStats(
	executions: Array<{
		toolName: string;
		isError: boolean;
		startTime: number;
		endTime: number | null;
	}>,
): Record<string, { calls: number; errors: number; totalDurationMs: number }> {
	const stats: Record<string, { calls: number; errors: number; totalDurationMs: number }> = {};
	for (const exec of executions) {
		if (!stats[exec.toolName]) {
			stats[exec.toolName] = { calls: 0, errors: 0, totalDurationMs: 0 };
		}
		stats[exec.toolName].calls++;
		if (exec.isError) stats[exec.toolName].errors++;
		if (exec.endTime != null) {
			stats[exec.toolName].totalDurationMs += exec.endTime - exec.startTime;
		}
	}
	return stats;
}
