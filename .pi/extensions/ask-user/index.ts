/**
 * ask-user — interactive questions for the AI (choice + free-text)
 *
 * Thin entry point. Registers the ask_user tool with TypeBox schema from
 * types.ts and delegates execute logic to csv-logger.ts and question-ui.ts.
 *
 * All completed interactions are logged to .pi/context/qna.csv with columns
 * datetime; question; answer (semicolon-separated).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuestionParams } from "./types.ts";
import { appendQnaEntry } from "./csv-logger.ts";
import { renderScrollableDialog } from "./question-ui.ts";

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
			const items: Array<{ value: string; label: string }> = [];

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

			// Use custom scrollable dialog so long questions (with code
			// blocks) can be scrolled independently from the option list.
			const selectedLabel = await ctx.ui.custom<string | undefined>(
				(tui, theme, _keybindings, done) =>
					renderScrollableDialog(tui, theme, done, question, items, labelToValue, otherLabel),
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
