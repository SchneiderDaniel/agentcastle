/**
 * ask-user — interactive multiple-choice questions for the AI
 *
 * Registers a tool the AI can call to ask the user structured questions
 * with selectable options, a recommended pick, and an "Other" free-text option.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export default function askUser(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a multiple-choice question. Call this whenever you need user input during interviews, clarifications, or decision points. Present at least 3 options, mark one as recommended, and always include 'Other' for custom answers.",
		promptSnippet:
			"Ask user a multiple-choice question with recommended option and free-text fallback",
		promptGuidelines: [
			"Use ask_user to ask the user structured questions instead of open-ended text questions. Always provide at least 3 options, mark one as recommended, and include an 'Other' option.",
			"Call ask_user ONE question at a time. Do not batch multiple questions into one call.",
		],
		parameters: Type.Object({
			question: Type.String({
				description:
					"The question to display to the user. Include enough context that the user can answer without scrolling up.",
			}),
			options: Type.Array(
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
							description:
								"Set to true for exactly ONE option to mark it as 'Recommended'",
						}),
					),
				}),
				{
					description:
						"Answer options. Must have at least 3 options. One must have recommended=true. 'Other' is added automatically.",
				},
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { question, options } = params;

			// Build flat string labels. Map labels back to values after selection.
			const labelToValue: Record<string, string> = {};
			const labels: string[] = [];

			for (let i = 0; i < options.length; i++) {
				const opt = options[i]!;
				const num = i + 1;
				const suffix = opt.recommended ? " (Recommended)" : "";
				const label = `${num}. ${opt.label}${suffix}`;
				labelToValue[label] = opt.value;
				labels.push(label);
			}

			const otherLabel = `${labels.length + 1}. Other (type your answer)`;
			labels.push(otherLabel);

			const selectedLabel = await ctx.ui.select(question, labels);

			// User cancelled (Esc)
			if (selectedLabel === undefined) {
				return {
					content: [
						{
							type: "text" as const,
							text: "User cancelled the question. Ask if they want to skip this topic and move on.",
						},
					],
					details: {},
				};
			}

			// User picked "Other" — ask for custom text
			if (selectedLabel === otherLabel) {
				const customAnswer = await ctx.ui.input("Type your answer:", "");
				if (customAnswer === undefined || customAnswer.trim() === "") {
					return {
						content: [
							{
								type: "text" as const,
								text: "User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
							},
						],
						details: {},
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `User chose "Other" and answered: "${customAnswer}"`,
						},
					],
					details: { selected: "__other__", customAnswer },
				};
			}

			// User picked a predefined option
			const selectedValue = labelToValue[selectedLabel] ?? selectedLabel;
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
