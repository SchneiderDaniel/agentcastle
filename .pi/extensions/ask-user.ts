/**
 * ask-user — interactive questions for the AI (choice + free-text)
 *
 * Registers a tool the AI can call to ask the user structured questions
 * with selectable options (and optional "Other" free-text fallback), or
 * open-ended free-text questions.
 *
 * All completed interactions are logged to .pi/context/qna.csv with columns
 * datetime; question; answer (semicolon-separated).
 *
 * For choice mode: Uses a scrollable custom dialog so long questions (with
 * code blocks) don't push options off-screen. PgUp/PgDn scroll the question
 * text independently from arrow-key option navigation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	SelectList,
	type SelectItem,
	type SelectListTheme,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";

/** Max visible lines for the question area before scrolling kicks in. */
const MAX_QUESTION_LINES = 12;
/** Number of lines to scroll per PgUp/PgDn press. */
const QUESTION_SCROLL_STEP = 5;

// ---------------------------------------------------------------------------
// CSV helpers (semicolon-separated)
// ---------------------------------------------------------------------------

/**
 * Escape a single field.
 * Fields containing semicolons, double quotes, or CRLF are enclosed in double
 * quotes; internal double quotes are doubled ("").
 */
function escapeCsvField(s: string): string {
	if (s.includes('"') || s.includes(";") || s.includes("\n") || s.includes("\r")) {
		return `"${s.replace(/"/g, '""')}"`;
	}
	return s;
}

/**
 * Build a single row for a Q&A entry.
 * Columns: datetime; question; answer. Terminated with \n.
 */
function toCsvRow(timestamp: string, question: string, answer: string): string {
	return `${escapeCsvField(timestamp)};${escapeCsvField(question)};${escapeCsvField(answer)}\n`;
}

/**
 * Append one Q&A entry to .pi/context/qna.csv (semicolon-separated).
 * Creates the directory and file if missing. Errors are silently swallowed
 * (best-effort per R3).
 */
async function appendQnaEntry(
	projectDir: string,
	timestamp: string,
	question: string,
	answer: string,
): Promise<void> {
	const csvDir = path.join(projectDir, ".pi", "context");
	const csvPath = path.join(csvDir, "qna.csv");
	try {
		await fs.mkdir(csvDir, { recursive: true });
		await fs.appendFile(csvPath, toCsvRow(timestamp, question, answer), "utf-8");
	} catch {
		// Best-effort: silently ignore write failures (R3)
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function askUser(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question. Supports multiple-choice (default) and free-text modes. Use choice mode when you need the user to pick from predefined options. Use freetext mode for open-ended questions like 'Tell me about yourself' or 'What do you think?'. All Q&A logged to .pi/context/qna.csv (semicolon-separated).",
		promptSnippet: "Ask user a question (choice or free-text mode)",
		promptGuidelines: [
			"Use ask_user with mode:'choice' (default) for structured multiple-choice questions. Always provide at least 3 options, mark one as recommended, and the 'Other' option is appended automatically unless disableOther is set to true. Do not add 'Other' to the options array yourself.",
			"Use ask_user with mode:'freetext' for open-ended questions where predefined options would be constraining. Examples: asking for a description, opinion, or freeform input. In freetext mode, options are ignored.",
			"Call ask_user ONE question at a time. Do not batch multiple questions into one call.",
			"For quizzes or multiple-choice tests where only predefined choices are accepted, set disableOther to true.",
		],
		parameters: Type.Object({
			mode: Type.Optional(
				Type.Union(
					[
						Type.Literal("choice", {
							description: "Multiple-choice mode — user picks from a list of options (default)",
						}),
						Type.Literal("freetext", {
							description: "Free-text mode — user types an open-ended answer without options",
						}),
					],
					{
						default: "choice",
						description:
							"Question mode: 'choice' for multiple-choice, 'freetext' for open-ended input",
					},
				),
			),
			question: Type.String({
				description:
					"The question to display to the user. Include enough context that the user can answer without scrolling up.",
			}),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({
							description: "The option text shown to the user",
						}),
						value: Type.String({
							description:
								"Short value returned when this option is selected (e.g. 'yes_noop', 'keep_as_is')",
						}),
						recommended: Type.Optional(
							Type.Boolean({
								description: "Set to true for exactly ONE option to mark it as 'Recommended'",
							}),
						),
					}),
					{
						description:
							"Answer options (required for choice mode, ignored in freetext mode). Must have at least 3 options. One must have recommended=true. 'Other' is added automatically unless disableOther is true.",
					},
				),
			),
			disableOther: Type.Optional(
				Type.Boolean({
					description:
						"Set to true to suppress the automatic 'Other' option. Use for quizzes or when only predefined choices are accepted.",
				}),
			),
		}),
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
			const { question, mode = "choice" } = params;

			// ── Freetext mode ──────────────────────────────────────────
			if (mode === "freetext") {
				const answer = await ctx.ui.input(question, "");
				if (answer === undefined || answer.trim() === "") {
					return {
						content: [
							{
								type: "text" as const,
								text: "User cancelled the question. Ask if they want to skip this topic and move on.",
							},
						],
						details: {} as Record<string, unknown>,
					};
				}

				const trimmedAnswer = answer.trim();
				const timestamp = new Date().toISOString();

				// Best-effort CSV logging
				const sm = ctx.sessionManager;
				await appendQnaEntry(sm.getCwd(), timestamp, question, trimmedAnswer);

				return {
					content: [
						{
							type: "text" as const,
							text: `User answered: "${trimmedAnswer}"`,
						},
					],
					details: { answer: trimmedAnswer },
				};
			}

			// ── Choice mode (default) ──────────────────────────────────
			const options = params.options ?? [];

			// Build SelectItems. Map labels back to values after selection.
			const labelToValue: Array<{ label: string; value: string }> = [];
			const items: SelectItem[] = [];

			for (let i = 0; i < options.length; i++) {
				const opt = options[i]!;
				const suffix = opt.recommended ? " (Recommended)" : "";
				const label = `${i + 1}. ${opt.label}${suffix}`;
				labelToValue.push({ label, value: opt.value });
				items.push({ value: label, label });
			}

			let otherLabel = "";
			if (!params.disableOther) {
				otherLabel = `${items.length + 1}. Other (type your answer)`;
				items.push({ value: otherLabel, label: otherLabel });
			}

			// Use custom scrollable dialog instead of ctx.ui.select so
			// long questions (with code blocks) can be scrolled independently
			// from the option list. Arrow keys navigate options, PgUp/PgDn
			// scroll the question text.
			const selectedLabel = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) => {
					let questionScrollOffset = 0;

					const selectListTheme: SelectListTheme = {
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("muted", text),
						noMatch: (text) => theme.fg("muted", text),
					};

					const selectList = new SelectList(items, Math.min(items.length, 10), selectListTheme);
					selectList.onSelect = (item) => done(item.value);
					selectList.onCancel = () => done(undefined);

					const borderColor = (s: string) => theme.fg("border", s);

					return {
						render(width: number): string[] {
							const lines: string[] = [];

							// Wrap question to current width (leave 4 cols for padding)
							const qLines = wrapTextWithAnsi(question, Math.max(10, width - 4));

							// Clamp scroll offset in case terminal was resized
							const maxOffset = Math.max(0, qLines.length - MAX_QUESTION_LINES);
							if (questionScrollOffset > maxOffset) {
								questionScrollOffset = maxOffset;
							}
							if (questionScrollOffset < 0) {
								questionScrollOffset = 0;
							}

							const visibleQLines = qLines.slice(
								questionScrollOffset,
								questionScrollOffset + MAX_QUESTION_LINES,
							);

							// Top border
							lines.push(borderColor("─".repeat(Math.max(1, width))));
							lines.push("");

							// Scroll indicator at top
							if (questionScrollOffset > 0) {
								lines.push(theme.fg("dim", "  ▲ more above (PgUp to scroll)"));
							}

							// Question lines
							for (const line of visibleQLines) {
								lines.push("  " + line);
							}

							// Scroll indicator at bottom of question area
							if (questionScrollOffset + MAX_QUESTION_LINES < qLines.length) {
								lines.push(theme.fg("dim", "  ▼ more below (PgDn to scroll)"));
							}

							lines.push("");

							// Options via SelectList
							const listLines = selectList.render(width);
							for (const line of listLines) {
								lines.push(line);
							}

							lines.push("");
							lines.push(
								theme.fg(
									"dim",
									"  ↑↓ navigate  enter select  esc cancel  PgUp/PgDn scroll question",
								),
							);
							lines.push("");
							lines.push(borderColor("─".repeat(Math.max(1, width))));

							return lines;
						},

						invalidate() {
							questionScrollOffset = 0;
							selectList.invalidate();
						},

						handleInput(data: string) {
							const kb = getKeybindings();

							// PgUp — scroll question up
							if (kb.matches(data, "tui.select.pageUp")) {
								questionScrollOffset = Math.max(0, questionScrollOffset - QUESTION_SCROLL_STEP);
								tui.requestRender();
								return;
							}

							// PgDn — scroll question down
							if (kb.matches(data, "tui.select.pageDown")) {
								questionScrollOffset += QUESTION_SCROLL_STEP;
								tui.requestRender();
								return;
							}

							// Forward everything else to SelectList
							// (arrows, enter, escape, etc.)
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				},
			);

			const timestamp = new Date().toISOString();
			const sm = ctx.sessionManager;

			// User cancelled (Esc)
			if (selectedLabel === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text: "User cancelled the question. Ask if they want to skip this topic and move on.",
						},
					],
					details: {} as Record<string, unknown>,
				};
			}

			// User picked "Other" — ask for custom text (only when not disabled)
			if (!params.disableOther && selectedLabel === otherLabel) {
				const customAnswer = await ctx.ui.input("Type your answer:", "");
				if (customAnswer === undefined || customAnswer.trim() === "") {
					return {
						content: [
							{
								type: "text" as const,
								text: "User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
							},
						],
						details: {} as Record<string, unknown>,
					};
				}

				const trimmedCustom = customAnswer.trim();

				// Log custom text (not "__other__") per AC8
				await appendQnaEntry(sm.getCwd(), timestamp, question, trimmedCustom);

				return {
					content: [
						{
							type: "text" as const,
							text: `User chose "Other" and answered: "${trimmedCustom}"`,
						},
					],
					details: { selected: "__other__", customAnswer: trimmedCustom },
				};
			}

			// User picked a predefined option
			const selectedValue =
				labelToValue.find((e) => e.label === selectedLabel)?.value ?? selectedLabel;

			await appendQnaEntry(sm.getCwd(), timestamp, question, selectedValue);

			return {
				content: [
					{
						type: "text" as const,
						text: `User selected: "${selectedLabel}"`,
					},
				],
				details: { selected: selectedValue, label: selectedLabel },
			};
		},
	});
}
