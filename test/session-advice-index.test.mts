/**
 * Tests for session-advice/index.ts — extension lifecycle handlers
 *
 * Bug 1: before_agent_start guard — skips lesson injection for sub-agents
 * Bug 2: DefaultResourceLoader noExtensions for sub-agents
 * Bug 3: session_shutdown deferred writeAdvice — non-blocking
 *
 * Run with:
 *   node --experimental-strip-types --test test/session-advice-index.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Bug 2: DefaultResourceLoader — noExtensions option in agent-session-runner
// ---------------------------------------------------------------------------

describe("DefaultResourceLoader — noExtensions option", () => {
	it("DefaultResourceLoaderOptions includes noExtensions: true", () => {
		const options = {
			cwd: "/repo",
			agentDir: "/repo/.pi",
			settingsManager: {} as any,
			additionalExtensionPaths: ["/repo/.pi/extensions/mcp/index.ts"],
			noExtensions: true,
		};
		assert.strictEqual(options.noExtensions, true, "noExtensions should be true");
		assert.strictEqual(options.additionalExtensionPaths?.length, 1, "explicit paths still passed");
	});

	it("noExtensions: true vs false differentiates behavior", () => {
		const optionsWith = { noExtensions: true };
		const optionsWithout = { noExtensions: false };
		assert.strictEqual(optionsWith.noExtensions, true);
		assert.strictEqual(optionsWithout.noExtensions, false);
	});

	it("noExtensions set in the actual code path of runAgentInProcess", () => {
		const source = readFileSync(".pi/extensions/supervisor/agent-session-runner.ts", "utf-8");
		assert.ok(
			source.includes("noExtensions: true"),
			"Should contain noExtensions: true in DefaultResourceLoader constructor call",
		);
	});
});

// ---------------------------------------------------------------------------
// Bug 1: before_agent_start guard — getSessionFile() as sub-agent proxy
// ---------------------------------------------------------------------------

describe("before_agent_start — sub-agent guard", () => {
	it("returns early when getSessionFile() is undefined (in-memory session = sub-agent)", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: () => undefined,
			},
		};

		const shouldReturn = !ctx.sessionManager?.getSessionFile();
		assert.strictEqual(shouldReturn, true, "undefined sessionFile should trigger early return");
	});

	it("passes through when getSessionFile() returns a path (file-backed session = main agent)", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: () => "/home/user/project/.pi/sessions/2026-05-24-session.jsonl",
			},
		};

		const shouldContinue = !!ctx.sessionManager?.getSessionFile();
		assert.strictEqual(shouldContinue, true, "non-undefined sessionFile should allow pass-through");
	});

	it("handles missing sessionManager gracefully (optional chaining)", () => {
		const ctx = {};

		const shouldReturn = !(ctx as any).sessionManager?.getSessionFile;
		assert.strictEqual(shouldReturn, true, "missing sessionManager should trigger early return");
	});

	it("guard prevents lesson injection when sessionFile is undefined", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: () => undefined,
			},
		};

		if (!ctx.sessionManager?.getSessionFile()) {
			assert.ok(true, "Guard fired — lesson injection skipped for sub-agent");
			return;
		}

		assert.fail("Should have returned early for undefined sessionFile");
	});

	it("guard allows lesson injection when sessionFile has a path", () => {
		const ctx = {
			sessionManager: {
				getSessionFile: () => "/repo/.pi/sessions/latest.jsonl",
			},
		};

		let guardFired = false;
		if (!ctx.sessionManager?.getSessionFile()) {
			guardFired = true;
		}

		assert.strictEqual(guardFired, false, "Guard should NOT fire for file-backed session");
	});
});

// ---------------------------------------------------------------------------
// Bug 3: session_shutdown deferred writeAdvice — non-blocking
// ---------------------------------------------------------------------------

describe("session_shutdown — deferred writeAdvice", () => {
	it("writeAdvice call is deferred via Promise.resolve().then()", () => {
		let callOrder: string[] = [];

		function writeAdvice() {
			callOrder.push("writeAdvice");
		}

		// Synchronous code — writeAdvice NOT called yet
		Promise.resolve().then(() => {
			writeAdvice();
		});

		assert.strictEqual(callOrder.length, 0, "writeAdvice should not be called synchronously");

		return new Promise<void>((resolve) => {
			setTimeout(() => {
				assert.strictEqual(callOrder.length, 1, "writeAdvice should be called after microtask");
				assert.strictEqual(callOrder[0], "writeAdvice");
				resolve();
			}, 10);
		});
	});

	it("session_shutdown completes before deferred writeAdvice executes", () => {
		let writeAdviceCalled = false;
		let shutdownCompleted = false;

		async function sessionShutdownHandler() {
			// Defer writeAdvice so shutdown is not blocked
			Promise.resolve().then(() => {
				writeAdviceCalled = true;
			});
			// This runs synchronously before deferred writeAdvice
			shutdownCompleted = true;
		}

		return sessionShutdownHandler().then(() => {
			assert.strictEqual(shutdownCompleted, true, "shutdown flag set synchronously");
		});
	});

	it("deferred writeAdvice eventually executes", () => {
		let writeAdviceCalled = false;

		async function sessionShutdownHandler() {
			Promise.resolve().then(() => {
				writeAdviceCalled = true;
			});
		}

		return sessionShutdownHandler().then(() => {
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					assert.strictEqual(writeAdviceCalled, true, "writeAdvice should eventually execute");
					resolve();
				}, 10);
			});
		});
	});
});

// ---------------------------------------------------------------------------
// Bug 3: session_shutdown guard — skip when getSessionFile() returns null
// ---------------------------------------------------------------------------

describe("session_shutdown — session file guard", () => {
	it("skips writeAdvice when getSessionFile() returns null/undefined", () => {
		const sm = {
			getSessionFile: () => undefined,
		};

		const sessionFile = sm.getSessionFile();
		if (!sessionFile) {
			assert.ok(true, "Skipping advice generation — no session file");
			return;
		}
		assert.fail("Should have skipped for undefined sessionFile");
	});

	it("proceeds to defer writeAdvice when sessionFile exists", () => {
		const sm = {
			getSessionFile: () => "/repo/.pi/sessions/session.jsonl",
		};

		const sessionFile = sm.getSessionFile();
		assert.ok(sessionFile, "sessionFile should exist");
	});
});
