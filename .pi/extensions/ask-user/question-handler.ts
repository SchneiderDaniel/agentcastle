/**
 * ask-user — QuestionHandler
 *
 * Extracted question-asking logic that was previously inline in index.ts.
 * Encapsulates freetext, choice, and Other-handling with shared helpers.
 * All dependencies injected via constructor — no pi runtime coupling.
 */

import type { LabelValuePair, OptionItem } from "./types.ts";
import { renderScrollableDialog } from "./question-ui.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Ui {
	input: (prompt: string, defaultValue: string) => Promise<string | undefined>;
	custom: <T>(
		renderer: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any,
	) => Promise<T>;
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

export interface QuestionHandlerDeps {
	projectDir: string;
	ui: Ui;
	appendQnaEntry: (
		projectDir: string,
		timestamp: string,
		question: string,
		answer: string,
	) => Promise<any>;
}

export interface QuestionChoiceParams {
	question: string;
	options?: OptionItem[];
	disableOther?: boolean;
}

export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// QuestionHandler
// ---------------------------------------------------------------------------

export class QuestionHandler {
	private deps: QuestionHandlerDeps;

	constructor(deps: QuestionHandlerDeps) {
		this.deps = deps;
	}

	// ── Public ───────────────────────────────────────────────────────

	/**
	 * Handle a freetext question.
	 * Shows an input prompt, validates the response, logs it, and returns the result.
	 */
	async handleFreetext(question: string): Promise<ToolResult> {
		const answer = await this.deps.ui.input(question, "");
		if (answer === undefined || answer.trim() === "") {
			return this.cancelResponse(
				"User cancelled the question. Ask if they want to skip this topic and move on.",
			);
		}

		const trimmedAnswer = answer.trim();
		const timestamp = new Date().toISOString();
		await this.logAnswer(timestamp, question, trimmedAnswer);

		return {
			content: [{ type: "text", text: `User answered: "${trimmedAnswer}"` }],
			details: { answer: trimmedAnswer },
		};
	}

	/**
	 * Handle a choice (multiple-choice) question.
	 * Builds the option list, renders the scrollable dialog, and processes the result.
	 */
	async handleChoice(params: QuestionChoiceParams): Promise<ToolResult> {
		const { question, options = [], disableOther = false } = params;

		// Build SelectItems. Map labels back to values after selection.
		const labelToValue: LabelValuePair[] = [];
		const items: Array<{ value: string; label: string }> = [];

		for (let i = 0; i < options.length; i++) {
			const opt = options[i]!;
			const suffix = opt.recommended ? " (Recommended)" : "";
			const label = `${i + 1}. ${opt.label}${suffix}`;
			labelToValue.push({ label, value: opt.value });
			items.push({ value: label, label });
		}

		let otherLabel = "";
		if (!disableOther) {
			otherLabel = `${items.length + 1}. Other (type your answer)`;
			items.push({ value: otherLabel, label: otherLabel });
		}

		// Use custom scrollable dialog so long questions (with code
		// blocks) can be scrolled independently from the option list.
		const selectedLabel = (await this.deps.ui.custom((tui, theme, _keybindings, done) =>
			renderScrollableDialog(
				tui,
				theme as { fg: (color: string, text: string) => string },
				done,
				question,
				items,
				labelToValue,
				otherLabel,
			),
		)) as string | undefined;

		const timestamp = new Date().toISOString();

		// User cancelled (Esc)
		if (selectedLabel === undefined) {
			return this.cancelResponse(
				"User cancelled the question. Ask if they want to skip this topic and move on.",
			);
		}

		// User picked "Other" — ask for custom text (only when not disabled)
		if (!disableOther && selectedLabel === otherLabel) {
			return this.handleOther(question, timestamp);
		}

		// User picked a predefined option
		const selectedValue =
			labelToValue.find((e) => e.label === selectedLabel)?.value ?? selectedLabel;

		await this.logAnswer(timestamp, question, selectedValue);

		return {
			content: [
				{
					type: "text",
					text: `User selected: "${selectedLabel}"`,
				},
			],
			details: { selected: selectedValue, label: selectedLabel },
		};
	}

	// ── Private ──────────────────────────────────────────────────────

	/**
	 * Handle the "Other" flow — prompt for custom text input.
	 */
	private async handleOther(question: string, timestamp: string): Promise<ToolResult> {
		const customAnswer = await this.deps.ui.input("Type your answer:", "");
		if (customAnswer === undefined || customAnswer.trim() === "") {
			return this.cancelResponse(
				"User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
			);
		}

		const trimmedCustom = customAnswer.trim();
		await this.logAnswer(timestamp, question, trimmedCustom);

		return {
			content: [
				{
					type: "text",
					text: `User chose "Other" and answered: "${trimmedCustom}"`,
				},
			],
			details: { selected: "__other__", customAnswer: trimmedCustom },
		};
	}

	/**
	 * Build a cancellation response.
	 */
	private cancelResponse(text: string): ToolResult {
		return {
			content: [{ type: "text", text }],
			details: {} as Record<string, unknown>,
		};
	}

	/**
	 * Log a Q&A entry. On failure, notifies the user but does not throw.
	 */
	private async logAnswer(timestamp: string, question: string, answer: string): Promise<void> {
		try {
			await this.deps.appendQnaEntry(this.deps.projectDir, timestamp, question, answer);
		} catch (err) {
			this.deps.ui.notify(`Failed to save Q&A entry: ${(err as Error).message}`, "error");
		}
	}
}
