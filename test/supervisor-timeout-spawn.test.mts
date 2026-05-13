/**
 * Tests for runAgent() timeoutMs parameter passing to spawn().
 *
 * Mocks child_process.spawn, creates mock agent + context,
 * calls runAgent() with different timeoutMs values,
 * and asserts spawn received the correct timeout option.
 *
 * Run with:
 *   npx tsx --test test/supervisor-timeout-spawn.test.mts
 */

import assert from "node:assert";
import { describe, it, mock, afterEach } from "node:test";
import { createRequire } from "node:module";
import child_process from "node:child_process";
import { EventEmitter } from "node:events";

// Use createRequire to import CJS module from ESM test context.
const require = createRequire(import.meta.url);
const {
	runAgent,
	DEFAULT_AGENT_TIMEOUT_MS,
} = require("../.pi/extensions/supervisor.ts");

// ─── Mock helpers ──────────────────────────────────────────────────

/**
 * Creates a mock ChildProcess that emits 'close' immediately.
 */
function createMockChild(): child_process.ChildProcess {
	const emitter = new EventEmitter() as child_process.ChildProcess;
	(emitter as any).stdout = new EventEmitter();
	(emitter as any).stderr = new EventEmitter();
	(emitter as any).stdin = null;
	(emitter as any).pid = 12345;
	(emitter as any).exitCode = null;
	(emitter as any).signalCode = null;
	(emitter as any).spawnargs = [];
	(emitter as any).spawnfile = "/usr/bin/pi";
	(emitter as any).killed = false;
	(emitter as any).channel = undefined;
	(emitter as any).connected = false;

	setImmediate(() => {
		emitter.emit("close", 0, null);
	});

	return emitter;
}

/**
 * Creates a minimal mock agent for runAgent().
 */
function createMockAgent(name: string = "test-agent") {
	return {
		config: {
			name,
			tools: "read,bash",
			model: "",
			extensions: "",
		},
		systemPrompt: "You are a test agent.",
	};
}

/**
 * Creates a minimal mock ExtensionCommandContext for runAgent().
 */
function createMockContext() {
	return {
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			setWorkingMessage: () => {},
		},
	};
}

// ─── Test suite ─────────────────────────────────────────────────────

describe("runAgent() spawn timeout parameter", () => {
	afterEach(() => {
		mock.restoreAll();
	});

	it("DEFAULT_AGENT_TIMEOUT_MS is 1_800_000 (30 minutes)", () => {
		assert.strictEqual(DEFAULT_AGENT_TIMEOUT_MS, 1_800_000);
	});

	it("runAgent with timeoutMs 600_000 → spawn called with timeout: 600_000", async () => {
		let capturedOptions: any = null;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], options?: any) => {
			capturedOptions = options;
			return createMockChild();
		});

		const agent = createMockAgent("developer");
		const ctx = createMockContext();

		await runAgent(agent, "test task", ctx, 600_000);

		assert.ok(capturedOptions !== null, "spawn should have been called");
		assert.strictEqual(capturedOptions.timeout, 600_000);
	});

	it("runAgent without timeoutMs → spawn called with default 1_800_000", async () => {
		let capturedOptions: any = null;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], options?: any) => {
			capturedOptions = options;
			return createMockChild();
		});

		const agent = createMockAgent("developer");
		const ctx = createMockContext();

		await runAgent(agent, "test task", ctx);

		assert.ok(capturedOptions !== null, "spawn should have been called");
		assert.strictEqual(capturedOptions.timeout, DEFAULT_AGENT_TIMEOUT_MS);
	});

	it("runAgent with timeoutMs 0 → spawn called with timeout: 0", async () => {
		let capturedOptions: any = null;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], options?: any) => {
			capturedOptions = options;
			return createMockChild();
		});

		const agent = createMockAgent("developer");
		const ctx = createMockContext();

		await runAgent(agent, "test task", ctx, 0);

		assert.ok(capturedOptions !== null, "spawn should have been called");
		assert.strictEqual(capturedOptions.timeout, 0);
	});

	it("runAgent spawn args include system prompt and tools", async () => {
		let capturedArgs: readonly string[] | undefined;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], _options?: any) => {
			capturedArgs = args;
			return createMockChild();
		});

		const agent = createMockAgent("developer");
		const ctx = createMockContext();

		await runAgent(agent, "test task", ctx, 600_000);

		assert.ok(capturedArgs !== undefined, "spawn args should be captured");
		const argsStr = capturedArgs!.join(" ");
		assert.ok(argsStr.includes("--system-prompt"), "should pass --system-prompt");
		assert.ok(argsStr.includes("You are a test agent"), "should include system prompt text");
		assert.ok(argsStr.includes("--tools"), "should pass --tools");
		assert.ok(argsStr.includes("read,bash"), "should include tools string");
	});
});
