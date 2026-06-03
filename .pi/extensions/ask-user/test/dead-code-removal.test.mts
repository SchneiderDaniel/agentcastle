/**
 * Verification tests for dead code removal (Issue #452).
 *
 * Confirms that the unused `QuestionResult` interface has been removed
 * from both `types.ts` and the test file duplicate.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ask-user/test/dead-code-removal.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const typesPath = path.resolve(__dirname, "../types.ts");
const testFilePath = path.resolve(__dirname, "question-handler.test.mts");

describe("dead code removal — Issue #452", () => {
	it("no longer exports QuestionResult interface from types.ts", () => {
		const content = fs.readFileSync(typesPath, "utf-8");

		// The export keyword + QuestionResult must not appear in the file
		const exportLine = content.split("\n").find((line) => line.includes("QuestionResult"));

		assert.ok(
			exportLine === undefined,
			`Expected QuestionResult to be removed, but found: "${exportLine?.trim()}"`,
		);
	});

	it("no longer has duplicate QuestionResult interface in test file", () => {
		const content = fs.readFileSync(testFilePath, "utf-8");

		// The local interface definition (no export) must also be gone
		const interfaceLine = content
			.split("\n")
			.find((line) => line.includes("interface QuestionResult"));

		assert.ok(
			interfaceLine === undefined,
			`Expected QuestionResult interface to be removed from test file, but found: "${interfaceLine?.trim()}"`,
		);
	});
});
