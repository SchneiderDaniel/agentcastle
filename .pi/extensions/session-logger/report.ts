/**
 * report.ts — Session report generation for session-logger
 *
 * Generates .md reports and .metadata.json files alongside .jsonl session files.
 * Extracted from index.ts for testability and separation of concerns.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { computeToolStats } from "./stats.ts";
import type { StatsSnapshot } from "./stats.ts";
import { createFileOps } from "./files.ts";
import { renderSessionToMarkdown, parseSessionStats } from "./renderer.ts";
import type { ParsedSessionStats } from "./renderer.ts";
import type { Metadata } from "./types.ts";

/**
 * Generate metadata.json and .md report for a session file if they're missing.
 * Called from session_shutdown (primary) and session_start (recovery).
 */
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
		modelChanges: parsed.modelChanges,
		thinkingChanges: parsed.thinkingChanges,
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
