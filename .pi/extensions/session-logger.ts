/**
 * Session Logger Extension
 *
 * Writes every session as a clean, LLM-friendly Markdown file to
 * .pi/sessions/<session-id>/session.md so you can later feed it
 * to an LLM and ask: "What in my harness is wasting tokens, confusing
 * the model, or could be improved?"
 *
 * Also writes a tiny metadata.json with stats for programmatic queries.
 *
 * Design decisions:
 * - Markdown over JSON/HTML: ~90% less structural token overhead
 * - Write-at-message_end: safe because toolResults emit in source order
 * - System prompt captured once per new file (not rewritten on /reload)
 * - Tool outputs truncated to 2000+500 chars to keep file size manageable
 * - Thinking blocks preserved in full (highest signal for analysis)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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

function ts(timestamp: number | string): string {
	const d =
		typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
	return d.toISOString().slice(11, 19);
}

function tok(n: number | undefined): string {
	if (n === undefined) return "?";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function costStr(c: number | undefined): string {
	if (c === undefined) return "?";
	if (c >= 0.01) return `$${c.toFixed(4)}`;
	if (c >= 0.0001) return `$${c.toFixed(6)}`;
	return `$${c.toExponential(1)}`;
}

function extractText(blocks: unknown): string {
	if (typeof blocks === "string") return blocks;
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n\n");
}

function hasImages(blocks: unknown): boolean {
	if (!Array.isArray(blocks)) return false;
	return blocks.some((b: any) => b.type === "image");
}

// ---------------------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------------------

function formatUserMessage(msg: any): string {
	const text = extractText(msg.content);
	const images = hasImages(msg.content) ? " 🖼️" : "";
	return `### [%IDX%] 👤 User \`${ts(msg.timestamp)}\`${images}\n${text}\n`;
}

function formatAssistantMessage(msg: any): string {
	const parts: string[] = [];

	for (const block of msg.content) {
		if (block.type === "text" && block.text.trim()) {
			parts.push(block.text.trim());
		} else if (block.type === "thinking") {
			parts.push(`💭 ${block.thinking}`);
		} else if (block.type === "toolCall") {
			const args = block.arguments ?? {};
			const argsStr = Object.entries(args)
				.map(([k, v]) => {
					const s = typeof v === "string" ? v : JSON.stringify(v);
					return s.length > 80 ? `${k}=${s.slice(0, 77)}...` : `${k}=${s}`;
				})
				.join(", ");
			parts.push(`🔧 **${block.name}** \`${argsStr}\``);
		}
	}

	const tokens = msg.usage?.totalTokens;
	const totalCost = msg.usage?.cost?.total;
	const header = `### [%IDX%] 🤖 Assistant \`${ts(msg.timestamp)}\` — ${tok(tokens)} tok · ${costStr(totalCost)}`;

	if (msg.stopReason && msg.stopReason !== "stop") {
		return `${header} · stop=${msg.stopReason}\n${parts.join("\n\n")}\n`;
	}
	return `${header}\n${parts.join("\n\n")}\n`;
}

function formatToolResult(msg: any): string {
	const icon = msg.isError ? "❌" : "✅";
	const output = extractText(msg.content);
	const truncated = truncate(output, MAX_TOOL_OUTPUT, MAX_TOOL_OUTPUT_TAIL);
	const name = msg.toolName || "unknown";
	return `### [%IDX%] 📋 ${name} ${icon} \`${ts(msg.timestamp)}\`\n\`\`\`\n${truncated}\n\`\`\`\n`;
}

function formatBashExecution(msg: any): string {
	const icon = msg.exitCode === 0 ? "✅" : "❌";
	const output = truncate(
		msg.output || "",
		MAX_TOOL_OUTPUT,
		MAX_TOOL_OUTPUT_TAIL,
	);
	const cancelled = msg.cancelled ? " [CANCELLED]" : "";
	const exit = msg.exitCode !== undefined ? ` exit=${msg.exitCode}` : "";
	return (
		`### [%IDX%] 💻 bash ${icon}\`${ts(msg.timestamp)}\`${cancelled}${exit}\n` +
		`\`\`\`sh\n${msg.command}\n\`\`\`\n` +
		`\`\`\`\n${output}\n\`\`\`\n`
	);
}

function formatCustomMessage(msg: any): string {
	const text = extractText(msg.content);
	return `### [%IDX%] 🔌 ${msg.customType || "extension"} \`${ts(msg.timestamp)}\`\n${text}\n`;
}

function formatBranchSummary(msg: any): string {
	return `> 📍 Branch summary (from ${msg.fromId}): ${msg.summary}\n`;
}

function formatCompactionSummary(msg: any): string {
	return `> 🗜️ Compaction: ${msg.summary}\n`;
}

// ---------------------------------------------------------------------------
// Main extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
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

	function writeln(line: string) {
		if (writeStream) writeStream.write(`${line}\n`);
	}

	function writeMessage(msg: any) {
		if (!writeStream) return;

		messageIdx++;
		let formatted: string;

		switch (msg.role) {
			case "user":
				formatted = formatUserMessage(msg);
				break;
			case "assistant":
				formatted = formatAssistantMessage(msg);
				// Accumulate stats
				if (msg.usage) {
					totalInputTokens += msg.usage.input || 0;
					totalOutputTokens += msg.usage.output || 0;
					totalCacheRead += msg.usage.cacheRead || 0;
					totalCacheWrite += msg.usage.cacheWrite || 0;
					totalCost += msg.usage.cost?.total || 0;
				}
				break;
			case "toolResult":
				formatted = formatToolResult(msg);
				break;
			case "bashExecution":
				formatted = formatBashExecution(msg);
				break;
			case "custom":
				formatted = formatCustomMessage(msg);
				break;
			case "branchSummary":
				formatted = formatBranchSummary(msg);
				break;
			case "compactionSummary":
				formatted = formatCompactionSummary(msg);
				break;
			default:
				formatted = `### [${messageIdx}] ❓ ${msg.role} \`${ts(msg.timestamp)}\`\n\`\`\`json\n${JSON.stringify(msg, null, 2)}\n\`\`\`\n`;
		}

		writeln(formatted.replace("%IDX%", String(messageIdx)));
	}

	function writeCompactionEntry(entry: any) {
		if (!writeStream) return;
		compactionCount++;
		writeln("---");
		writeln(`## Compaction \`${ts(entry.timestamp)}\``);
		writeln(`**Tokens before:** ${tok(entry.tokensBefore)}`);
		if (entry.firstKeptEntryId)
			writeln(`**Kept from:** \`${entry.firstKeptEntryId}\``);
		writeln("");
		writeln(entry.summary || "");
		writeln("");
		writeln("---");
		writeln("");
	}

	function writeHeader(ctx: any) {
		const sm = ctx.sessionManager;
		const header = sm.getHeader();
		writeln(`# Session ${(header?.id || sm.getSessionId()).slice(0, 8)}`);
		writeln(
			`**Started:** ${header?.timestamp || new Date().toISOString()} | **CWD:** ${sm.getCwd()}`,
		);
		writeln("");
		writeln("---");
		writeln("");
	}

	function writeMetadata() {
		if (!sessionDir) return;
		const meta = {
			sessionId: path.basename(sessionDir),
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
		fs.writeFileSync(
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
		sessionDir = path.join(sm.getCwd(), ".pi", "sessions", sessionId);
		fs.mkdirSync(sessionDir, { recursive: true });

		const filePath = path.join(sessionDir, "session.md");
		isNewFile = !fs.existsSync(filePath);
		systemPromptWritten = !isNewFile;

		// Reset stats if starting fresh (new file)
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

		writeStream = fs.createWriteStream(filePath, { flags: "a" });

		if (isNewFile) {
			writeHeader(ctx);

			for (const entry of sm.getEntries()) {
				if (entry.type === "message") {
					writeMessage(entry.message);
				} else if (entry.type === "compaction") {
					writeCompactionEntry(entry);
				} else if (entry.type === "model_change") {
					const m = entry as any;
					modelChanges.push({
						time: ts(m.timestamp),
						model: `${m.provider || "?"}/${m.modelId}`,
					});
					writeln(
						`> 🔄 Model → **${m.provider || "?"}/${m.modelId}** \`${ts(m.timestamp)}\``,
					);
					writeln("");
				} else if (entry.type === "thinking_level_change") {
					const t = entry as any;
					thinkingChanges.push({
						time: ts(t.timestamp),
						level: t.thinkingLevel,
					});
					writeln(
						`> 🧠 Thinking → **${t.thinkingLevel}** \`${ts(t.timestamp)}\``,
					);
					writeln("");
				}
			}
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (systemPromptWritten || !isNewFile) return;
		if (!ensureStream()) return;

		const prompt = (event as any).systemPrompt || "";
		if (!prompt) return;

		writeln("## System Prompt");
		writeln("```");
		writeln(truncate(prompt, MAX_SYSTEM_PROMPT, 0));
		if (prompt.length > MAX_SYSTEM_PROMPT) {
			writeln(
				`\n[... ${prompt.length - MAX_SYSTEM_PROMPT} more chars truncated ...]`,
			);
		}
		writeln("```");
		writeln("");
		writeln("---");
		writeln("");

		systemPromptWritten = true;
	});

	pi.on("message_end", async (event, _ctx) => {
		if (!ensureStream()) return;
		writeMessage(event.message);
	});

	pi.on("session_compact", async (event, _ctx) => {
		if (!ensureStream()) return;
		writeCompactionEntry(event.compactionEntry);
	});

	pi.on("model_select", async (event, _ctx) => {
		if (!ensureStream()) return;
		const m = event.model;
		const label = `${m.provider}/${m.id}`;
		modelChanges.push({ time: ts(Date.now()), model: label });
		writeln(`> 🔄 Model → **${label}** \`${ts(Date.now())}\``);
		writeln("");
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		if (!ensureStream()) return;
		thinkingChanges.push({ time: ts(Date.now()), level: event.level });
		writeln(`> 🧠 Thinking → **${event.level}** \`${ts(Date.now())}\``);
		writeln("");
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		if (writeStream) {
			writeStream.end();
			writeStream = null;
		}
		writeMetadata();
	});
}
