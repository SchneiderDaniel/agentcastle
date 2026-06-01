/**
 * ask-user — Lets the AI ask you interactive questions during a task
 *
 * Thin entry point. Registers the ask_user tool with TypeBox schema from
 * types.ts and delegates execute logic to jsonl-logger.ts and question-ui.ts.
 *
 * Also registers:
 *   - /qna slash command for human querying of Q&A history
 *   - ask_user_read tool for LLM extraction of past Q&A entries
 *
 * All completed interactions are logged to .pi/context/qna.jsonl.
 * Legacy .pi/context/qna.csv is migrated at session start if present.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuestionParams, QnaReadParams } from "./types.ts";
import {
	migrateQnaFromCsv,
	listQnaEntries,
	getQnaEntry,
	queryQnaEntries,
	readQnaEntries,
} from "./jsonl-logger.ts";
import { QuestionHandler } from "./question-handler.ts";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Utility: format entries as markdown table
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 1) + "…";
}

function formatTable(
	entries: Array<{ datetime: string; question: string; answer: string }>,
): string {
	const rows: string[] = [];
	rows.push("| # | Datetime | Question | Answer |");
	rows.push("|---|---|---|---|");
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		const id = i + 1;
		const q = truncate(e.question, 60).replace(/\|/g, "\\|").replace(/\n/g, " ");
		const a = truncate(e.answer, 40).replace(/\|/g, "\\|").replace(/\n/g, " ");
		const dt = truncate(e.datetime, 24);
		rows.push(`| ${id} | ${dt} | ${q} | ${a} |`);
	}
	return rows.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function askUser(pi: ExtensionAPI): void {
	// ── CSV→JSONL migration at session start ─────────────────────────
	// Migration runs once per session when the session starts, not on
	// every first ask_user call. This avoids delaying the first question
	// when CSV has many rows.
	pi.on("session_start", async (_event, ctx) => {
		const projectDir = ctx.sessionManager.getCwd();
		const csvPath = path.join(projectDir, ".pi", "context", "qna.csv");
		if (fs.existsSync(csvPath)) {
			try {
				const result = await migrateQnaFromCsv(projectDir);
				if (result.migrated > 0 || result.skipped > 0) {
					console.warn(
						`Migration: ${result.migrated} entries migrated to qna.jsonl, ${result.skipped} skipped`,
					);
				}
			} catch (err) {
				console.warn(`Migration warning: ${(err as Error).message}`);
			}
		}
	});

	// ── ask_user tool (unchanged except storage backend) ──────────────
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question. Supports multiple-choice (default) and free-text modes. Use choice mode when you need the user to pick from predefined options. Use freetext mode for open-ended questions like 'Tell me about yourself' or 'What do you think?'. All Q&A logged to .pi/context/qna.jsonl.",
		promptSnippet: "Ask user a question (choice or free-text mode)",
		promptGuidelines: [
			"Use ask_user with mode:'choice' (default) for structured multiple-choice questions. Always provide at least 3 options, mark one as recommended, and the 'Other' option is appended automatically unless disableOther is set to true. Do not add 'Other' to the options array yourself.",
			"Use ask_user with mode:'freetext' for open-ended questions where predefined options would be constraining. Examples: asking for a description, opinion, or freeform input. In freetext mode, options are ignored.",
			"Call ask_user ONE question at a time. Do not batch multiple questions into one call.",
			"For quizzes or multiple-choice tests where only predefined choices are accepted, set disableOther to true.",
		],
		parameters: QuestionParams,
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: Record<string, unknown>;
		}> {
			const projectDir = ctx.sessionManager.getCwd();
			const handler = new QuestionHandler(projectDir, ctx);
			return handler.handle(params);
		},
	});

	// ── /qna slash command ──────────────────────────────────────────
	pi.registerCommand("qna", {
		description:
			"Query Q&A history. Usage: /qna list [--limit N], /qna get <id>, /qna search <text>",
		handler: async (args: string, ctx) => {
			const projectDir = ctx.sessionManager.getCwd();
			const trimmed = args.trim();

			// No args or just whitespace
			if (!trimmed) {
				pi.sendUserMessage?.(
					"Usage: `/qna list [--limit N]`, `/qna get <id>`, `/qna search <text>`\n\nNo Q&A history yet.",
					{ deliverAs: "followUp" },
				);
				return;
			}

			// Parse: first word is subcommand, rest are args
			const spaceIdx = trimmed.indexOf(" ");
			const subcommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
			const subargs = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

			if (subcommand === "list") {
				// Parse --limit N
				let limit = 20;
				const limitMatch = subargs.match(/--limit\s+(\d+)/);
				if (limitMatch) {
					limit = parseInt(limitMatch[1]!, 10);
				}

				let entries: Array<{ datetime: string; question: string; answer: string }>;
				try {
					entries = await listQnaEntries(projectDir, limit);
				} catch (err) {
					pi.sendUserMessage?.(`Error reading Q&A history: ${(err as Error).message}`, {
						deliverAs: "followUp",
					});
					return;
				}

				if (entries.length === 0) {
					pi.sendUserMessage?.("No Q&A history yet.", { deliverAs: "followUp" });
					return;
				}

				const table = formatTable(entries);
				pi.sendUserMessage?.(table, { deliverAs: "followUp" });
				return;
			}

			if (subcommand === "get") {
				const id = parseInt(subargs, 10);
				if (isNaN(id) || id < 1) {
					pi.sendUserMessage?.("Usage: `/qna get <id>` — id must be a positive number.", {
						deliverAs: "followUp",
					});
					return;
				}

				let entry: { datetime: string; question: string; answer: string } | null | undefined;
				try {
					entry = await getQnaEntry(projectDir, id);
				} catch (err) {
					pi.sendUserMessage?.(`Error reading Q&A entry: ${(err as Error).message}`, {
						deliverAs: "followUp",
					});
					return;
				}

				if (entry === undefined) {
					pi.sendUserMessage?.("No Q&A history yet.", { deliverAs: "followUp" });
					return;
				}
				if (entry === null) {
					pi.sendUserMessage?.(`Entry #${id} not found.`, { deliverAs: "followUp" });
					return;
				}

				pi.sendUserMessage?.(
					[
						`### Q&A Entry #${id}`,
						``,
						`**Datetime:** ${entry.datetime}`,
						``,
						`**Question:**`,
						entry.question,
						``,
						`**Answer:**`,
						entry.answer,
					].join("\n"),
					{ deliverAs: "followUp" },
				);
				return;
			}

			if (subcommand === "search") {
				if (!subargs) {
					pi.sendUserMessage?.("Usage: `/qna search <text>` — provide search text.", {
						deliverAs: "followUp",
					});
					return;
				}

				let entries: Array<{ datetime: string; question: string; answer: string }>;
				try {
					entries = await queryQnaEntries(projectDir, subargs);
				} catch (err) {
					pi.sendUserMessage?.(`Error searching Q&A history: ${(err as Error).message}`, {
						deliverAs: "followUp",
					});
					return;
				}

				if (entries.length === 0) {
					pi.sendUserMessage?.(`No entries matching "${subargs}".`, {
						deliverAs: "followUp",
					});
					return;
				}

				const table = formatTable(entries);
				pi.sendUserMessage?.([`**Search results for "${subargs}":**`, ``, table].join("\n"), {
					deliverAs: "followUp",
				});
				return;
			}

			// Unknown subcommand
			pi.sendUserMessage?.(
				"Unknown /qna subcommand. Usage: `/qna list [--limit N]`, `/qna get <id>`, `/qna search <text>`",
				{ deliverAs: "followUp" },
			);
		},
	});

	// ── ask_user_read LLM tool ──────────────────────────────────────
	pi.registerTool({
		name: "ask_user_read",
		label: "Read Q&A History",
		description:
			"Read past Q&A entries from the ask-user log. Supports list, get, and query actions. Returns structured JSON with entries array and count.",
		promptSnippet: "Read Q&A history entries",
		promptGuidelines: [
			"Use action:'list' to get recent entries (optionally with limit parameter).",
			"Use action:'get' with id parameter to get a single entry by 1-based line number.",
			"Use action:'query' with text parameter to search question and answer fields (case-insensitive).",
		],
		parameters: QnaReadParams,
		async execute(
			_toolCallId,
			params,
			_signal,
			_onUpdate,
			ctx,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: Record<string, unknown>;
		}> {
			const projectDir = ctx.sessionManager.getCwd();
			const {
				action,
				limit = 20,
				id,
				text,
			} = params as {
				action: "list" | "get" | "query";
				limit?: number;
				id?: number;
				text?: string;
			};

			try {
				if (action === "list") {
					const entries = await listQnaEntries(projectDir, limit);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									entries,
									count: entries.length,
									...(entries.length === 0 ? { message: "No Q&A history yet" } : {}),
								}),
							},
						],
						details: { entries, count: entries.length },
					};
				}

				if (action === "get") {
					if (id === undefined || id === null) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										entries: [],
										count: 0,
										message: "id parameter is required for get action",
									}),
								},
							],
							details: { entries: [], count: 0 },
						};
					}

					const entry = await getQnaEntry(projectDir, id);
					if (entry === undefined) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										entries: [],
										count: 0,
										message: "No Q&A history yet",
									}),
								},
							],
							details: { entries: [], count: 0 },
						};
					}
					if (entry === null) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										entries: [],
										count: 0,
										message: `Entry #${id} not found`,
									}),
								},
							],
							details: { entries: [], count: 0 },
						};
					}

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									entries: [entry],
									count: 1,
								}),
							},
						],
						details: { entries: [entry], count: 1 },
					};
				}

				if (action === "query") {
					if (!text) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										entries: [],
										count: 0,
										message: "text parameter is required for query action",
									}),
								},
							],
							details: { entries: [], count: 0 },
						};
					}

					const entries = await queryQnaEntries(projectDir, text);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									entries,
									count: entries.length,
									...(entries.length === 0 ? { message: "No Q&A history yet" } : {}),
								}),
							},
						],
						details: { entries, count: entries.length },
					};
				}

				// Unknown action
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								entries: [],
								count: 0,
								message: `Unknown action: ${action}`,
							}),
						},
					],
					details: { entries: [], count: 0 },
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								entries: [],
								count: 0,
								message: `Error reading Q&A history: ${(err as Error).message}`,
							}),
						},
					],
					details: { entries: [], count: 0 },
				};
			}
		},
	});
}
