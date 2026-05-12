/**
 * Tests for .pi/extensions/context-info.ts — Context Window Telemetry Extension
 *
 * Verifies extension state machine handles all event orderings and edge cases.
 * Pure unit tests — mock ExtensionAPI by capturing registered callbacks.
 *
 * Run with:
 *   node --experimental-strip-types --test test/context-info.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Replicate context-info extension logic for isolated unit testing
// (matches .pi/extensions/context-info.ts implementation exactly)
// ---------------------------------------------------------------------------

interface MockPi {
	on: (event: string, handler: (...args: any[]) => void) => void;
}

function createContextInfoExtension(): { pi: MockPi; logCalls: string[] } {
	const logCalls: string[] = [];
	const handlers = new Map<string, (...args: any[]) => void>();

	const mockPi: MockPi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
	};

	// Simulate the extension's default export logic
	let contextWindow: number | undefined;
	let contextTokens: number | undefined;
	let emitted = false;

	function tryEmit() {
		if (emitted) return;
		if (contextWindow === undefined || contextWindow <= 0) return;
		if (contextTokens === undefined || contextTokens <= 0) return;
		emitted = true;
		logCalls.push(JSON.stringify({
			type: "context_info",
			contextTokens,
			contextWindow,
		}));
	}

	handlers.set("session_start", () => {
		contextWindow = undefined;
		contextTokens = undefined;
		emitted = false;
	});

	handlers.set("model_select", (event: any) => {
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			contextWindow = cw;
			tryEmit();
		}
	});

	handlers.set("message_end", (event: any) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		const input = msg.usage?.input;
		if (typeof input === "number" && input > 0) {
			contextTokens = input;
			tryEmit();
		}
	});

	function invoke(event: string, ...args: any[]) {
		const handler = handlers.get(event);
		if (handler) handler(...args);
	}

	return {
		pi: mockPi,
		logCalls,
		_handlers: handlers,
		_invoke: invoke,
	} as unknown as { pi: MockPi; logCalls: string[]; _invoke: (e: string, ...a: any[]) => void };
}

type TestCtx = ReturnType<typeof createContextInfoExtension>;

function invoke(ctx: TestCtx, event: string, ...args: any[]) {
	(ctx as any)._invoke(event, ...args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context-info extension — happy path", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.1: model_select then assistant message with usage → emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 12400 } },
		});

		assert.strictEqual(ctx.logCalls.length, 1);
		assert.strictEqual(
			ctx.logCalls[0],
			'{"type":"context_info","contextTokens":12400,"contextWindow":256000}'
		);
	});

	it("P2.2: message_end before model_select → deferred emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 12400 } },
		});
		// No emit yet — waiting for model info
		assert.strictEqual(ctx.logCalls.length, 0);

		// Now model info arrives → emit
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		assert.strictEqual(ctx.logCalls.length, 1);
		assert.strictEqual(
			ctx.logCalls[0],
			'{"type":"context_info","contextTokens":12400,"contextWindow":256000}'
		);
	});
});

describe("context-info extension — suppression cases", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.3: contextWindow missing → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: {} });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 1000 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.4: contextWindow is 0 → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 0 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 1000 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.5: contextWindow undefined → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: undefined } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 1000 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.6: no usage.input in message → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", { message: { role: "assistant", content: [] } });
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.7: usage.input is 0 → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 0 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.8: message role is not assistant → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "user", usage: { input: 1000 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.9: no message_end ever fires → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.10: no model_select ever fires → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 1000 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.11: agent fails immediately (only session_start) → no emit", () => {
		invoke(ctx, "session_start", {});
		assert.strictEqual(ctx.logCalls.length, 0);
	});
});

describe("context-info extension — reset behavior", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.12: second session_start resets state → separate emits per round", () => {
		// Round 1
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 12400 } },
		});
		assert.strictEqual(ctx.logCalls.length, 1);

		// Round 2
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 512000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 8000 } },
		});
		assert.strictEqual(ctx.logCalls.length, 2);
		assert.strictEqual(
			ctx.logCalls[1],
			'{"type":"context_info","contextTokens":8000,"contextWindow":512000}'
		);
	});
});

describe("context-info extension — error resilience", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.13: usage.input negative → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: -1 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.14: contextWindow negative → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: -1 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", usage: { input: 1000 } },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});
});
