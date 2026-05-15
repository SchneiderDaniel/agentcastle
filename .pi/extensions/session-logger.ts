/**
 * Session Logger Extension — JSONL Format
 *
 * Writes every session event as a JSON Lines record to
 * .pi/sessions/<datetime>_<short-id>/session.jsonl so you can query with jq:
 *
 *   cat .pi/sessions/latest.jsonl | jq 'select(.error != null)'
 *
 * Design decisions:
 * - JSONL over Markdown: O(1) append, jq streaming, no structural overhead
 * - Append-safe: each line independently parseable
 * - Symlink .pi/sessions/latest.jsonl → current session file
 * - Folder name: datetime + short-id so user can easily find latest session
 * - No BOM, UTF-8, \n line terminators per jsonlines.org spec
 */

import * as fs from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractTextFromContent } from "../lib/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

interface LogRecord {
	timestamp: string;
	agent: string;
	tool: string;
	token_usage?: TokenUsage;
	error: string | null;
	loop_step: number;
	payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT = 2000;
const MAX_TOOL_OUTPUT_TAIL = 500;
const MAX_SYSTEM_PROMPT = 5000;

function truncate(text: string, head: number, tail = 0): string {
	if (text.length <= head + tail) return text;
	const cut = text.length - head - tail;
	if (tail > 0) {
		return (
			text.slice(0, head) +
			`\n\n[... ${cut} chars truncated ...]\n\n` +
			text.slice(-tail)
		);
	}
	return text.slice(0, head) + `\n\n[... ${cut} chars truncated ...]`;
}

// Re-export from shared types — eliminates duplication with supervisor.ts
const extractText = extractTextFromContent;

// ---------------------------------------------------------------------------
// JSONL Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a log record to a single JSONL line.
 * Returns string terminated with \n. Never emits blank lines or BOM.
 */
function serializeRecord(record: LogRecord): string {
	// Ensure all schema fields present — error must be explicit null
	const normalized: LogRecord = {
		timestamp: record.timestamp,
		agent: record.agent,
		tool: record.tool,
		...(record.token_usage && { token_usage: record.token_usage }),
		error: record.error ?? null,
		loop_step: record.loop_step,
		payload: record.payload ?? {},
	};
	// JSON.stringify produces valid UTF-8, no BOM. Append \n.
	return JSON.stringify(normalized) + "\n";
}

// ---------------------------------------------------------------------------
// Event → Record Mappers
// ---------------------------------------------------------------------------

function userMessageToRecord(msg: any, step: number): LogRecord {
	const text = extractText(msg.content);
	return {
		timestamp: typeof msg.timestamp === "string"
			? msg.timestamp
			: new Date(msg.timestamp).toISOString(),
		agent: "user",
		tool: "message",
		error: null,
		loop_step: 0,
		payload: { role: "user", content: text },
	};
}

function assistantMessageToRecord(msg: any, step: number): LogRecord {
	const texts: string[] = [];
	const thinking: string[] = [];
	const toolCalls: Array<{ name: string; arguments: unknown }> = [];

	for (const block of msg.content || []) {
		if (block.type === "text" && block.text?.trim()) texts.push(block.text.trim());
		else if (block.type === "thinking") thinking.push(block.thinking);
		else if (block.type === "toolCall") {
			toolCalls.push({ name: block.name, arguments: block.arguments ?? {} });
		}
	}

	const tokenUsage: TokenUsage | undefined = msg.usage
		? {
			input: msg.usage.input ?? 0,
			output: msg.usage.output ?? 0,
			total: msg.usage.totalTokens ?? (msg.usage.input ?? 0) + (msg.usage.output ?? 0),
		}
		: undefined;

	return {
		timestamp: typeof msg.timestamp === "string"
			? msg.timestamp
			: new Date(msg.timestamp).toISOString(),
		agent: "assistant",
		tool: "message",
		...(tokenUsage && { token_usage: tokenUsage }),
		error: msg.stopReason && msg.stopReason !== "stop" ? `stop_reason: ${msg.stopReason}` : null,
		loop_step: 0,
		payload: {
			role: "assistant",
			texts,
			thinking,
			toolCalls,
		},
	};
}

function toolResultToRecord(msg: any, step: number): LogRecord {
	const output = truncate(
		extractText(msg.content),
		MAX_TOOL_OUTPUT,
		MAX_TOOL_OUTPUT_TAIL,
	);
	return {
		timestamp: typeof msg.timestamp === "string"
			? msg.timestamp
			: new Date(msg.timestamp).toISOString(),
		agent: "tool",
		tool: msg.toolName || "unknown",
		error: msg.isError ? output : null,
		loop_step: 0,
		payload: { role: "toolResult", toolName: msg.toolName, output },
	};
}

function bashExecutionToRecord(msg: any, step: number): LogRecord {
	const output = truncate(msg.output || "", MAX_TOOL_OUTPUT, MAX_TOOL_OUTPUT_TAIL);
	const errorMsg = msg.exitCode !== 0 ? output : null;
	return {
		timestamp: typeof msg.timestamp === "string"
			? msg.timestamp
			: new Date(msg.timestamp).toISOString(),
		agent: "bash",
		tool: "bash",
		error: errorMsg,
		loop_step: 0,
		payload: {
			role: "bashExecution",
			command: msg.command,
			output,
			exitCode: msg.exitCode,
			cancelled: msg.cancelled ?? false,
		},
	};
}

function customMessageToRecord(msg: any, step: number): LogRecord {
	return {
		timestamp: typeof msg.timestamp === "string"
			? msg.timestamp
			: new Date(msg.timestamp).toISOString(),
		agent: msg.customType || "extension",
		tool: msg.customType || "extension",
		error: null,
		loop_step: 0,
		payload: { role: "custom", content: extractText(msg.content) },
	};
}

function branchSummaryToRecord(msg: any, step: number): LogRecord {
	return {
		timestamp: new Date().toISOString(),
		agent: "branch",
		tool: "branch_summary",
		error: null,
		loop_step: 0,
		payload: { role: "branchSummary", fromId: msg.fromId, summary: msg.summary },
	};
}

function compactionToRecord(msg: any, step: number): LogRecord {
	return {
		timestamp: typeof msg.timestamp === "string"
			? msg.timestamp
			: new Date().toISOString(),
		agent: "compaction",
		tool: "compaction",
		error: null,
		loop_step: 0,
		payload: {
			role: "compactionSummary",
			tokensBefore: msg.tokensBefore,
			firstKeptEntryId: msg.firstKeptEntryId,
			summary: msg.summary,
		},
	};
}

function modelSelectToRecord(event: any, step: number): LogRecord {
	const m = event.model;
	return {
		timestamp: new Date().toISOString(),
		agent: "model_select",
		tool: "model_select",
		error: null,
		loop_step: 0,
		payload: { provider: m.provider, modelId: m.id },
	};
}

function thinkingSelectToRecord(event: any, step: number): LogRecord {
	return {
		timestamp: new Date().toISOString(),
		agent: "thinking_select",
		tool: "thinking_select",
		error: null,
		loop_step: 0,
		payload: { level: event.level },
	};
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
			ctx.ui.notify(
				`Session logger: ${enabled ? "ON" : "OFF"} (applies to next session)`,
				"info",
			);
		},
	});

	// ── stream state ─────────────────────────────────────────────────────
	let writeStream: fs.WriteStream | null = null;
	let sessionFilePath: string | null = null;
	let sessionDir: string | null = null;
	let messageIdx = 0;
	let systemPromptWritten = false;
	let isNewFile = false;

	// Accumulated stats for metadata.json
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let modelChanges: Array<{ time: string; model: string }> = [];
	let thinkingChanges: Array<{ time: string; level: string }> = [];
	let compactionCount = 0;

	// ── helpers ──────────────────────────────────────────────────────────

	function ensureStream(): fs.WriteStream | null {
		return writeStream;
	}

	/**
	 * Write a single JSONL line to the stream.
	 * Each call appends exactly one line terminated with \n.
	 */
	function writeRecord(record: LogRecord) {
		if (writeStream) {
			messageIdx++;
			const line = serializeRecord({ ...record, loop_step: messageIdx });
			writeStream.write(line);
		}
	}

	function writeMessage(msg: any) {
		if (!writeStream) return;

		switch (msg.role) {
			case "user": {
				writeRecord(userMessageToRecord(msg));
				break;
			}
			case "assistant": {
				writeRecord(assistantMessageToRecord(msg));
				// Accumulate stats
				if (msg.usage) {
					totalInputTokens += msg.usage.input || 0;
					totalOutputTokens += msg.usage.output || 0;
					totalCacheRead += msg.usage.cacheRead || 0;
					totalCacheWrite += msg.usage.cacheWrite || 0;
					totalCost += msg.usage.cost?.total || 0;
				}
				break;
			}
			case "toolResult": {
				writeRecord(toolResultToRecord(msg));
				break;
			}
			case "bashExecution": {
				writeRecord(bashExecutionToRecord(msg));
				break;
			}
			case "custom": {
				writeRecord(customMessageToRecord(msg));
				break;
			}
			case "branchSummary": {
				writeRecord(branchSummaryToRecord(msg));
				break;
			}
			case "compactionSummary": {
				writeRecord(compactionToRecord(msg));
				break;
			}
			default: {
				writeRecord({
					timestamp: typeof msg.timestamp === "string"
						? msg.timestamp
						: new Date(msg.timestamp).toISOString(),
					agent: msg.role ?? "unknown",
					tool: "unknown",
					error: null,
					loop_step: messageIdx,
					payload: { role: msg.role, raw: msg },
				});
			}
		}
	}

	async function writeMetadata() {
		if (!sessionDir) return;
		const folderName = path.basename(sessionDir);
		const meta = {
			sessionId: folderName,
			messages: messageIdx,
			tokens: {
				input: totalInputTokens,
				output: totalOutputTokens,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total:
					totalInputTokens +
					totalOutputTokens +
					totalCacheRead +
					totalCacheWrite,
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
	}

	// ── event handlers ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) return;
		if (writeStream) {
			writeStream.end();
			writeStream = null;
		}

		const sm = ctx.sessionManager;
		const sessionId = sm.getSessionId();
		const shortId = sessionId.slice(0, 8);
		const now = new Date();
		const ts =
			now.getFullYear() +
			"-" +
			String(now.getMonth() + 1).padStart(2, "0") +
			"-" +
			String(now.getDate()).padStart(2, "0") +
			"T" +
			String(now.getHours()).padStart(2, "0") +
			"-" +
			String(now.getMinutes()).padStart(2, "0") +
			"-" +
			String(now.getSeconds()).padStart(2, "0");
		const folderName = `${ts}_${shortId}`;
		const sessionsDir = path.join(sm.getCwd(), ".pi", "sessions");
		sessionDir = path.join(sessionsDir, folderName);
		fs.mkdirSync(sessionDir, { recursive: true });

		// JSONL file per session (inside the timestamped folder)
		sessionFilePath = path.join(sessionDir, `session.jsonl`);
		isNewFile = !fs.existsSync(sessionFilePath);
		systemPromptWritten = !isNewFile;

		// Reset stats if starting fresh
		if (isNewFile) {
			messageIdx = 0;
			totalInputTokens = 0;
			totalOutputTokens = 0;
			totalCacheRead = 0;
			totalCacheWrite = 0;
			totalCost = 0;
			modelChanges = [];
			thinkingChanges = [];
			compactionCount = 0;
		}

		// Create/update symlink latest.jsonl → current session
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		try {
			fs.unlinkSync(latestLink);
		} catch {
			// symlink didn't exist, ignore
		}
		fs.symlinkSync(sessionFilePath, latestLink);

		writeStream = fs.createWriteStream(sessionFilePath, { flags: "a" });

		if (isNewFile) {
			// Write session header as a special record
			writeRecord({
				timestamp: new Date().toISOString(),
				agent: "system",
				tool: "session_start",
				error: null,
				loop_step: 0,
				payload: {
					role: "session_start",
					sessionId: shortId,
					cwd: sm.getCwd(),
				},
			});

			// Replay existing entries
			for (const entry of sm.getEntries()) {
				if (entry.type === "message") {
					writeMessage(entry.message);
				} else if (entry.type === "compaction") {
					writeRecord(compactionToRecord(entry));
				} else if (entry.type === "model_change") {
					const m = entry as any;
					modelChanges.push({
						time: new Date(m.timestamp).toISOString(),
						model: `${m.provider || "?"}/${m.modelId}`,
					});
					writeRecord({
						timestamp: new Date(m.timestamp).toISOString(),
						agent: "model_change",
						tool: "model_select",
						error: null,
						loop_step: 0,
						payload: { provider: m.provider, modelId: m.modelId },
					});
				} else if (entry.type === "thinking_level_change") {
					const t = entry as any;
					thinkingChanges.push({
						time: new Date(t.timestamp).toISOString(),
						level: t.thinkingLevel,
					});
					writeRecord({
						timestamp: new Date(t.timestamp).toISOString(),
						agent: "thinking_change",
						tool: "thinking_select",
						error: null,
						loop_step: 0,
						payload: { level: t.thinkingLevel },
					});
				}
			}
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (systemPromptWritten || !isNewFile) return;
		if (!ensureStream()) return;

		const prompt = (event as any).systemPrompt || "";
		if (!prompt) return;

		writeRecord({
			timestamp: new Date().toISOString(),
			agent: "system",
			tool: "system_prompt",
			error: null,
			loop_step: 0,
			payload: {
				role: "system_prompt",
				prompt: truncate(prompt, MAX_SYSTEM_PROMPT, 0),
				truncated: prompt.length > MAX_SYSTEM_PROMPT,
			},
		});

		systemPromptWritten = true;
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!ensureStream()) return;
		writeMessage(event.message);
	});

	pi.on("session_compact", async (event, _ctx) => {
		if (!ensureStream()) return;
		writeRecord(compactionToRecord(event.compactionEntry));
	});

	pi.on("model_select", async (event, _ctx) => {
		if (!ensureStream()) return;
		const m = event.model;
		const label = `${m.provider}/${m.id}`;
		modelChanges.push({ time: new Date().toISOString(), model: label });
		writeRecord(modelSelectToRecord(event));
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		if (!ensureStream()) return;
		thinkingChanges.push({ time: new Date().toISOString(), level: event.level });
		writeRecord(thinkingSelectToRecord(event));
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (writeStream) {
			writeStream.end();
			writeStream = null;
		}
		await writeMetadata();
	});
}
