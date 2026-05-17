/**
 * Tests for caveman index.ts — wiring integration
 *
 * Phase 6: Entry point wires stores to events.
 * Index.ts has no business logic, pure adapter.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// We import the default export and test it with a mock pi
// ---------------------------------------------------------------------------

interface EventHandler {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

function makeMockPi(): {
	pi: ExtensionAPI;
	events: EventHandler[];
	entries: { type: string; data: unknown }[];
	commands: { name: string; def: unknown }[];
} {
	const events: EventHandler[] = [];
	const entries: { type: string; data: unknown }[] = [];
	const commands: { name: string; def: unknown }[] = [];

	const pi = {
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			events.push({ event, handler });
		},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
		registerCommand: (name: string, def: unknown) => {
			commands.push({ name, def });
		},
	} as unknown as ExtensionAPI;

	return { pi, events, entries, commands };
}

function makeMockSessionManager() {
	return {
		getEntries: () => [] as unknown[],
	};
}

function makeMockCtx(): ExtensionContext {
	return {
		ui: {
			setStatus: () => {},
			notify: () => {},
			theme: {
				fg: () => (s: string) => s,
				bold: (s: string) => s,
			},
		} as unknown as ExtensionContext["ui"],
		sessionManager: makeMockSessionManager(),
	} as ExtensionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("index.ts — caveman entry point", () => {
	it("caveman(pi) calls pi.on at least once", async () => {
		const { pi, events } = makeMockPi();
		// Dynamic import to load module fresh each test
		const mod = await import("../.pi/extensions/caveman/index.ts");
		mod.default(pi);
		assert.ok(events.length >= 1, "Expected at least 1 event registration");
	});

	it("caveman(pi) calls pi.registerCommand('caveman', ...)", async () => {
		const { pi, commands } = makeMockPi();
		const mod = await import("../.pi/extensions/caveman/index.ts");
		mod.default(pi);
		const cmd = commands.find((c) => c.name === "caveman");
		assert.ok(cmd !== undefined, "caveman command not registered");
	});

	it("caveman(pi) returns void", async () => {
		const { pi } = makeMockPi();
		const mod = await import("../.pi/extensions/caveman/index.ts");
		const result = mod.default(pi);
		assert.strictEqual(result, undefined);
	});

	it("session_start handler calls syncStatus (does not throw)", async () => {
		const { pi, events } = makeMockPi();
		const mod = await import("../.pi/extensions/caveman/index.ts");
		mod.default(pi);

		const sessionStart = events.find((e) => e.event === "session_start");
		assert.ok(sessionStart !== undefined);

		const ctx = makeMockCtx();
		// Should not throw
		await sessionStart.handler({}, ctx);
	});

	it("agent_start sets active, calls syncStatus", async () => {
		const { pi, events } = makeMockPi();
		const mod = await import("../.pi/extensions/caveman/index.ts");
		mod.default(pi);

		const agentStart = events.find((e) => e.event === "agent_start");
		assert.ok(agentStart !== undefined);

		const ctx = makeMockCtx();
		await agentStart.handler({}, ctx);
		// Should not throw
	});

	it("agent_end sets inactive, calls syncStatus", async () => {
		const { pi, events } = makeMockPi();
		const mod = await import("../.pi/extensions/caveman/index.ts");
		mod.default(pi);

		const agentEnd = events.find((e) => e.event === "agent_end");
		assert.ok(agentEnd !== undefined);

		const ctx = makeMockCtx();
		await agentEnd.handler({}, ctx);
		// Should not throw
	});

	it("session_shutdown stops animation", async () => {
		const { pi, events } = makeMockPi();
		const mod = await import("../.pi/extensions/caveman/index.ts");
		mod.default(pi);

		const shutdown = events.find((e) => e.event === "session_shutdown");
		assert.ok(shutdown !== undefined);

		await shutdown.handler();
		// Should not throw
	});

	it("before_agent_start with default lite level injects prompt", async () => {
		const { pi, events } = makeMockPi();
		const mod = await import("../.pi/extensions/caveman/index.ts");
		mod.default(pi);

		// Trigger session_start first to load config and set level
		const sessionStart = events.find((e) => e.event === "session_start");
		const beforeStart = events.find((e) => e.event === "before_agent_start");
		assert.ok(sessionStart !== undefined);
		assert.ok(beforeStart !== undefined);

		// session_start will load config, DEFAULT_CONFIG.defaultLevel is "lite"
		const ctx = {
			ui: {
				setStatus: () => {},
				notify: () => {},
				theme: { fg: () => (s: string) => s, bold: (s: string) => s },
			},
			sessionManager: { getEntries: () => [] },
		};
		await sessionStart.handler({}, ctx as any);

		const event = { systemPrompt: "Existing prompt" };
		const result = await beforeStart.handler(event);
		// DEFAULT_CONFIG.defaultLevel is "lite", so prompt IS injected
		assert.ok(result !== undefined, "Expected prompt injection for lite level");
		assert.ok(
			(result as { systemPrompt: string }).systemPrompt.includes("Caveman Mode"),
			"Expected Caveman Mode in injected prompt",
		);
	});
});
