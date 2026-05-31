/**
 * Tests for QuestionHandler — extracted question-asking logic
 *
 * Tests cover freetext, choice, and Other-handling paths.
 * All deps are injected via constructor — no pi runtime coupling.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/question-handler.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { QuestionHandler, type QuestionHandlerDeps } from "../question-handler.ts";

describe("QuestionHandler", () => {
	let deps: QuestionHandlerDeps;
	let notifyCalls: Array<{ message: string; level: string }>;
	let appendCalls: Array<{
		projectDir: string;
		timestamp: string;
		question: string;
		answer: string;
	}>;

	beforeEach(() => {
		notifyCalls = [];
		appendCalls = [];

		const ui = {
			input: async (_prompt: string, _defaultValue: string): Promise<string | undefined> =>
				undefined,
			custom: async <T,>(..._args: any[]): Promise<T> => undefined as unknown as T,
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifyCalls.push({ message, level: type ?? "info" });
			},
		};

		deps = {
			projectDir: "/test/project",
			ui,
			appendQnaEntry: async (
				projectDir: string,
				timestamp: string,
				question: string,
				answer: string,
			) => {
				appendCalls.push({ projectDir, timestamp, question, answer });
			},
		};
	});

	// ── handleFreetext ───────────────────────────────────────────────────

	describe("handleFreetext", () => {
		it("returns answer in content[0].text and details.answer for valid input", async () => {
			deps.ui.input = async () => "My answer";
			const handler = new QuestionHandler(deps);
			const result = await handler.handleFreetext("What do you think?");

			assert.strictEqual(result.content[0]?.text, 'User answered: "My answer"');
			assert.strictEqual(result.details.answer, "My answer");
		});

		it("returns cancel text when ui.input returns undefined", async () => {
			deps.ui.input = async () => undefined;
			const handler = new QuestionHandler(deps);
			const result = await handler.handleFreetext("What do you think?");

			assert.strictEqual(
				result.content[0]?.text,
				"User cancelled the question. Ask if they want to skip this topic and move on.",
			);
			assert.deepStrictEqual(result.details, {});
		});

		it("returns cancel text for whitespace-only input", async () => {
			deps.ui.input = async () => "   ";
			const handler = new QuestionHandler(deps);
			const result = await handler.handleFreetext("What do you think?");

			assert.strictEqual(
				result.content[0]?.text,
				"User cancelled the question. Ask if they want to skip this topic and move on.",
			);
		});

		it("calls appendQnaEntry with projectDir, ISO timestamp, question, and trimmed answer", async () => {
			deps.ui.input = async () => "  My answer  ";
			const handler = new QuestionHandler(deps);
			await handler.handleFreetext("What do you think?");

			assert.strictEqual(appendCalls.length, 1);
			assert.strictEqual(appendCalls[0]!.projectDir, "/test/project");
			assert.strictEqual(appendCalls[0]!.question, "What do you think?");
			assert.strictEqual(appendCalls[0]!.answer, "My answer");

			// Timestamp should be a valid ISO string
			const ts = appendCalls[0]!.timestamp;
			assert.doesNotThrow(() => new Date(ts).toISOString(), "Timestamp must be valid ISO");
		});

		it("notifies on logging failure but still returns the answer", async () => {
			deps.ui.input = async () => "My answer";
			deps.appendQnaEntry = async () => {
				throw new Error("Disk full");
			};

			const handler = new QuestionHandler(deps);
			const result = await handler.handleFreetext("What do you think?");

			assert.strictEqual(result.content[0]?.text, 'User answered: "My answer"');
			assert.strictEqual(notifyCalls.length, 1);
			assert.ok(
				notifyCalls[0]!.message.includes("Disk full"),
				"Notify should contain error message",
			);
			assert.strictEqual(notifyCalls[0]!.level, "error");
		});
	});

	// ── handleChoice ─────────────────────────────────────────────────────

	describe("handleChoice", () => {
		it("selects predefined option and returns label in content and value in details.selected", async () => {
			(deps.ui.custom as any) = async () => "1. Option A";

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(result.content[0]?.text, 'User selected: "1. Option A"');
			assert.strictEqual(result.details.selected, "a");
		});

		it("returns cancel text when ui.custom returns undefined", async () => {
			(deps.ui.custom as any) = async () => undefined;

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(
				result.content[0]?.text,
				"User cancelled the question. Ask if they want to skip this topic and move on.",
			);
			assert.deepStrictEqual(result.details, {});
		});

		it("selects Other then enters custom text", async () => {
			(deps.ui.custom as any) = async () => "3. Other (type your answer)";
			deps.ui.input = async () => "My custom answer";

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(
				result.content[0]?.text,
				'User chose "Other" and answered: "My custom answer"',
			);
			assert.strictEqual(result.details.selected, "__other__");
			assert.strictEqual(result.details.customAnswer, "My custom answer");
		});

		it("selects Other then cancels custom input", async () => {
			(deps.ui.custom as any) = async () => "3. Other (type your answer)";
			deps.ui.input = async () => undefined;

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(
				result.content[0]?.text,
				"User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
			);
		});

		it("selects Other then enters whitespace-only custom input", async () => {
			(deps.ui.custom as any) = async () => "3. Other (type your answer)";
			deps.ui.input = async () => "   ";

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(
				result.content[0]?.text,
				"User cancelled or left 'Other' empty. Re-ask or mark this topic as unresolved.",
			);
		});

		it("calls appendQnaEntry when predefined option selected", async () => {
			(deps.ui.custom as any) = async () => "2. Option B";

			const handler = new QuestionHandler(deps);
			await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(appendCalls.length, 1);
			assert.strictEqual(appendCalls[0]!.projectDir, "/test/project");
			assert.strictEqual(appendCalls[0]!.question, "Pick one:");
			assert.strictEqual(appendCalls[0]!.answer, "b");
		});

		it("notifies on logging failure but still returns the selection", async () => {
			(deps.ui.custom as any) = async () => "1. Option A";
			deps.appendQnaEntry = async () => {
				throw new Error("Write error");
			};

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(result.content[0]?.text, 'User selected: "1. Option A"');
			assert.strictEqual(notifyCalls.length, 1);
			assert.ok(
				notifyCalls[0]!.message.includes("Write error"),
				"Notify should contain error message",
			);
		});

		it("selects Other then logs custom answer", async () => {
			(deps.ui.custom as any) = async () => "3. Other (type your answer)";
			deps.ui.input = async () => "My custom answer";

			const handler = new QuestionHandler(deps);
			await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(appendCalls.length, 1);
			assert.strictEqual(appendCalls[0]!.question, "Pick one:");
			assert.strictEqual(appendCalls[0]!.answer, "My custom answer");
		});

		it("handles recommended option suffix correctly", async () => {
			(deps.ui.custom as any) = async () => "1. Option A (Recommended)";

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a", recommended: true },
					{ label: "Option B", value: "b" },
				],
			});

			assert.strictEqual(result.details.selected, "a");
			assert.ok(
				(result.content[0]?.text ?? "").includes("Recommended"),
				"Should include (Recommended) in label",
			);
		});

		it("handles disableOther — no Other option shown", async () => {
			(deps.ui.custom as any) = async () => "2. Option B";

			const handler = new QuestionHandler(deps);
			const result = await handler.handleChoice({
				question: "Pick one:",
				options: [
					{ label: "Option A", value: "a" },
					{ label: "Option B", value: "b" },
				],
				disableOther: true,
			});

			assert.strictEqual(result.details.selected, "b");
		});
	});
});
