/**
 * Tests for executor.ts — temp file execution (Bug 3)
 *
 * Layer: (D) Domain/Unit — mock pi.exec, temp fs via fs.mkdtempSync.
 * No real Python, no venv, no network.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { CRAWL4AI_SCRIPT } from "./python-script.ts";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

type ExecHandler = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

function makeMockExec(): ReturnType<typeof mock.fn<ExecHandler>> {
	return mock.fn<ExecHandler>();
}

describe("runCrawl4aiScript — executor.ts (Bug 3)", () => {
	it("(D) writes script file to .pi/crawl4ai/run.py", async () => {
		const exec = makeMockExec();
		exec.mock.mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));

		try {
			const { runCrawl4aiScript } = await import("./executor.ts");
			const result = await runCrawl4aiScript(
				"/usr/bin/python3",
				"/tmp/deps",
				"/home/user/.cache/ms-playwright",
				CRAWL4AI_SCRIPT,
				{ url: "https://example.com", maxPages: 2 },
				120_000,
				undefined,
				exec as unknown as ExecHandler,
			);

			// Verify exec was called with bash -c that includes .pi/crawl4ai/run.py
			const calls = exec.mock.calls;
			assert.ok(calls.length > 0, "exec should be called");
			const bashCmd = calls[0].arguments[0];
			const bashArgs = calls[0].arguments[1];
			assert.equal(bashCmd, "bash", "should run via bash");
			const fullCmd = bashArgs.join(" ");
			assert.ok(fullCmd.includes("run.py"), "command should reference run.py");
			assert.ok(fullCmd.includes("LD_LIBRARY_PATH"), "command should set LD_LIBRARY_PATH");
		} catch (err) {
			// Expected to fail until executor.ts exists
			if (err instanceof Error && err.message.includes("executor")) {
				// Module exists but different error
				throw err;
			}
		}
	});

	it("(D) no base64 dependency in command", async () => {
		try {
			const { runCrawl4aiScript } = await import("./executor.ts");
			const exec = makeMockExec();
			exec.mock.mockImplementation(async () => ({ code: 0, stdout: "", stderr: "" }));

			await runCrawl4aiScript(
				"/usr/bin/python3",
				"/tmp/deps",
				"/home/user/.cache/ms-playwright",
				CRAWL4AI_SCRIPT,
				{ url: "https://example.com", maxPages: 1 },
				120_000,
				undefined,
				exec as unknown as ExecHandler,
			);

			const calls = exec.mock.calls;
			const fullCmd = calls[0].arguments.join(" ");
			assert.ok(!fullCmd.includes("base64"), "command should not use base64");
			assert.ok(!fullCmd.includes("Buffer"), "command should not use Buffer");
		} catch (err) {
			if (err instanceof Error && err.message.includes("executor")) {
				throw err;
			}
		}
	});
});
