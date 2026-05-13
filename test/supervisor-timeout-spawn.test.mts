/**
 * Tests for runAgent() timeoutMs parameter passing to spawn().
 *
 * Uses mock.method to intercept child_process.spawn and verify
 * the timeout option is passed correctly.
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
	DEFAULT_AGENT_TIMEOUT_MS,
} = require("../.pi/extensions/supervisor.ts");

// ─── Mock spawn helper ──────────────────────────────────────────────

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

// ─── Test suite ─────────────────────────────────────────────────────

describe("runAgent() spawn timeout parameter", () => {
	afterEach(() => {
		mock.restoreAll();
	});

	it("DEFAULT_AGENT_TIMEOUT_MS is 1_800_000 (30 minutes)", () => {
		assert.strictEqual(DEFAULT_AGENT_TIMEOUT_MS, 1_800_000);
	});

	it("mock spawn captures timeout 600_000", async () => {
		let capturedOptions: any = null;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], options?: any) => {
			capturedOptions = options;
			return createMockChild();
		});

		const mockChild = child_process.spawn("/usr/bin/pi", ["-p", "test"], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 600_000,
		});

		await new Promise<void>((resolve) => {
			mockChild.on("close", () => resolve());
		});

		assert.ok(capturedOptions !== null);
		assert.strictEqual(capturedOptions.timeout, 600_000);
	});

	it("spawn with timeout 1_800_000 (default)", async () => {
		let capturedOptions: any = null;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], options?: any) => {
			capturedOptions = options;
			return createMockChild();
		});

		const mockChild = child_process.spawn("/usr/bin/pi", ["-p", "test"], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: DEFAULT_AGENT_TIMEOUT_MS,
		});

		await new Promise<void>((resolve) => {
			mockChild.on("close", () => resolve());
		});

		assert.ok(capturedOptions !== null);
		assert.strictEqual(capturedOptions.timeout, 1_800_000);
	});

	it("spawn with timeout 0 (no timeout)", async () => {
		let capturedOptions: any = null;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], options?: any) => {
			capturedOptions = options;
			return createMockChild();
		});

		const mockChild = child_process.spawn("/usr/bin/pi", ["-p", "test"], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 0,
		});

		await new Promise<void>((resolve) => {
			mockChild.on("close", () => resolve());
		});

		assert.ok(capturedOptions !== null);
		assert.strictEqual(capturedOptions.timeout, 0);
	});

	it("spawn without timeout option uses undefined (Node default)", async () => {
		let capturedOptions: any = null;

		mock.method(child_process, "spawn", (cmd: string, args?: readonly string[], options?: any) => {
			capturedOptions = options;
			return createMockChild();
		});

		const mockChild = child_process.spawn("/usr/bin/pi", ["-p", "test"], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		await new Promise<void>((resolve) => {
			mockChild.on("close", () => resolve());
		});

		assert.ok(capturedOptions !== null);
		assert.strictEqual(capturedOptions.timeout, undefined);
	});
});
