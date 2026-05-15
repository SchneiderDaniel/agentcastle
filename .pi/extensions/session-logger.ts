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

import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Metadata {
	sessionId: string;
	name?: string;
	messages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	compactions: number;
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// ── toggle state ─────────────────────────────────────────────────────
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

	// ── accumulated stats ───────────────────────────────────────────────
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let modelChanges: Array<{ time: string; model: string }> = [];
	let thinkingChanges: Array<{ time: string; level: string }> = [];
	let compactionCount = 0;

	// ── helpers ──────────────────────────────────────────────────────────

	function addUsage(usage: any) {
		if (!usage) return;
		totalInputTokens += usage.input ?? 0;
		totalOutputTokens += usage.output ?? 0;
		totalCacheRead += usage.cacheRead ?? 0;
		totalCacheWrite += usage.cacheWrite ?? 0;
		totalCost += usage.cost?.total ?? 0;
	}

	/** Seed stats from existing session entries (on resume/reload). */
	function seedStats(sm: { getEntries(): any[] }) {
		for (const entry of sm.getEntries()) {
			if (entry.type === "message") {
				if (entry.message.role === "assistant") addUsage(entry.message.usage);
			} else if (entry.type === "compaction") {
				compactionCount++;
			} else if (entry.type === "model_change") {
				modelChanges.push({
					time: entry.timestamp,
					model: `${entry.provider}/${entry.modelId}`,
				});
			} else if (entry.type === "thinking_level_change") {
				thinkingChanges.push({ time: entry.timestamp, level: entry.thinkingLevel });
			}
		}
	}

	// ── event handlers ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) return;

		const sm = ctx.sessionManager;
		const sessionFile = sm.getSessionFile();
		if (!sessionFile) return;

		// Reset stats
		totalInputTokens = 0;
		totalOutputTokens = 0;
		totalCacheRead = 0;
		totalCacheWrite = 0;
		totalCost = 0;
		modelChanges = [];
		thinkingChanges = [];
		compactionCount = 0;

		// Seed from existing entries (resume/reload)
		seedStats(sm);

		// Create / update latest.jsonl symlink in .pi/sessions/
		const sessionsDir = path.resolve(sm.getCwd(), ".pi", "sessions");
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		try {
			fs.unlinkSync(latestLink);
		} catch {
			// symlink didn't exist, ignore
		}
		try {
			fs.symlinkSync(sessionFile, latestLink);
		} catch {
			// symlink creation can fail (permissions, cross-device), ignore
		}
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!enabled) return;
		if (event.message.role === "assistant") addUsage(event.message.usage);
	});

	pi.on("session_compact", async (_event, _ctx) => {
		if (!enabled) return;
		compactionCount++;
	});

	pi.on("model_select", async (event, _ctx) => {
		if (!enabled) return;
		modelChanges.push({
			time: new Date().toISOString(),
			model: `${event.model.provider}/${event.model.id}`,
		});
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		if (!enabled) return;
		thinkingChanges.push({ time: new Date().toISOString(), level: event.level });
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enabled) return;

		const sm = ctx.sessionManager;
		const sessionFile = sm.getSessionFile();
		if (!sessionFile) return;

		const sessionDir = path.dirname(sessionFile);

		const meta: Metadata = {
			sessionId: sm.getSessionId(),
			name: sm.getSessionName() || undefined,
			messages: sm.getEntries().length,
			tokens: {
				input: totalInputTokens,
				output: totalOutputTokens,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total:
					totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			compactions: compactionCount,
			modelChanges,
			thinkingChanges,
		};

		await writeFile(
			path.join(sessionDir, "metadata.json"),
			JSON.stringify(meta, null, 2),
		);
	});
}
