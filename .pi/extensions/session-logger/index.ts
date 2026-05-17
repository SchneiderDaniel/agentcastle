/**
 * Session Logger — thin wrapper around pi's built-in session storage
 *
 * Pi's native sessions already persist all messages, model changes,
 * thinking-level changes, compactions, and tree state to JSONL.
 * Configured via sessionDir in settings.json.
 *
 * This extension adds extras pi doesn't provide:
 * - `.pi/sessions/latest.jsonl` symlink ──┬── current session file
 * - `metadata.json` per session directory  ── token counts, costs, timestamps
 * - `/session-logger` toggle command
 *
 * Session storage is handled entirely by pi's SessionManager.
 * This extension only reads events and writes supplementary data.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionStats } from "./stats.js";
import { createFileOps } from "./files.js";
import type { Metadata } from "./types.js";

export default function (pi: ExtensionAPI): void {
	let enabled = true;

	pi.registerCommand("session-logger", {
		description: "Toggle session logging on/off (takes effect next session)",
		handler: async (args, ctx) => {
			if (args === "on") enabled = true;
			else if (args === "off") enabled = false;
			else enabled = !enabled;
			ctx.ui.notify(`Session logger: ${enabled ? "ON" : "OFF"} (applies to next session)`, "info");
		},
	});

	const stats = createSessionStats();
	const files = createFileOps();

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) return;

		const sm = ctx.sessionManager;
		const sessionFile = sm.getSessionFile();
		if (!sessionFile) return;

		stats.reset();
		stats.seedStats(sm);

		const sessionsDir = path.resolve(sm.getCwd(), ".pi", "sessions");
		await files.ensureSymlink(sessionFile, sessionsDir);
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!enabled) return;
		if (event.message.role === "assistant") stats.addUsage(event.message.usage);
	});

	pi.on("session_compact", async (_event, _ctx) => {
		if (!enabled) return;
		stats.incrementCompaction();
	});

	pi.on("model_select", async (event, _ctx) => {
		if (!enabled) return;
		stats.modelChange(event.model.provider, event.model.id);
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		if (!enabled) return;
		stats.thinkingChange(event.level);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enabled) return;

		const sm = ctx.sessionManager;
		const sessionFile = sm.getSessionFile();
		if (!sessionFile) return;

		const sessionDir = path.dirname(sessionFile);
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
		};

		await files.writeMetadata(sessionDir, meta);
	});
}
