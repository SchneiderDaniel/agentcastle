/**
 * Tests for .pi/extensions/context-info.ts — Context Window Telemetry Extension
 *
 * Verifies extension state machine handles all event orderings and edge cases.
 * Pure unit tests — mock ExtensionAPI by capturing registered callbacks.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/context-info/test/context-info.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Replicate context-info extension logic for isolated unit testing
// (matches .pi/extensions/context-info.ts implementation exactly)
// ---------------------------------------------------------------------------

interface MockCtx {
	getContextUsage: () => { tokens?: number; contextWindow?: number } | undefined;
}

interface MockPi {
	on: (event: string, handler: (...args: any[]) => void) => void;
}

function createContextInfoExtension(): {
	pi: MockPi;
	logCalls: string[];
	mockCtx: MockCtx;
	getCacheRead: () => number | undefined;
	getCacheWrite: () => number | undefined;
} {
	const logCalls: string[] = [];
	const handlers = new Map<string, (...args: any[]) => void>();
	const mockCtx: MockCtx = {
		getContextUsage: () => undefined,
	};
	let _cacheRead: number | undefined;
	let _cacheWrite: number | undefined;

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
		logCalls.push(
			JSON.stringify({
				type: "context_info",
				contextTokens,
				contextWindow,
			}),
		);
	}

	handlers.set("session_start", () => {
		contextWindow = undefined;
		contextTokens = undefined;
		emitted = false;
		_cacheRead = undefined;
		_cacheWrite = undefined;
	});

	handlers.set("model_select", (event: any) => {
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			contextWindow = cw;
			tryEmit();
		}
	});

	// Match production: use ctx.getContextUsage() instead of event.message.usage
	// Also capture cacheRead/cacheWrite from event.message.usage
	handlers.set("message_end", (event: any) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		// Capture cache stats from raw event usage
		const usage = msg.usage;
		if (usage) {
			if (typeof usage.cacheRead === "number") _cacheRead = usage.cacheRead;
			if (typeof usage.cacheWrite === "number") _cacheWrite = usage.cacheWrite;
		}
		const ctxUsage = mockCtx.getContextUsage();
		if (ctxUsage && typeof ctxUsage.tokens === "number" && ctxUsage.tokens > 0) {
			contextTokens = ctxUsage.tokens;
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
		mockCtx,
		getCacheRead: () => _cacheRead,
		getCacheWrite: () => _cacheWrite,
		_handlers: handlers,
		_invoke: invoke,
	} as unknown as {
		pi: MockPi;
		logCalls: string[];
		mockCtx: MockCtx;
		getCacheRead: () => number | undefined;
		getCacheWrite: () => number | undefined;
		_invoke: (e: string, ...a: any[]) => void;
	};
}

type TestCtx = ReturnType<typeof createContextInfoExtension>;

function setCtxUsage(ctx: TestCtx, tokens: number) {
	ctx.mockCtx.getContextUsage = () => ({ tokens, contextWindow: 256000 });
}

function getCacheRead(ctx: TestCtx): number | undefined {
	return ctx.getCacheRead();
}

function getCacheWrite(ctx: TestCtx): number | undefined {
	return ctx.getCacheWrite();
}

function invoke(ctx: TestCtx, event: string, ...args: any[]) {
	(ctx as any)._invoke(event, ...args);
}

// ---------------------------------------------------------------------------
// Duplicated helpers from .pi/extensions/context-info.ts (session timer)
// ---------------------------------------------------------------------------

/** Format token count: 1200 → "1.2K", 1200000 → "1.2M" */
function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/** Format cache stats: 📦 cacheRead/cacheWrite */
function formatCacheStats(
	cacheRead: number | undefined | null,
	cacheWrite: number | undefined | null,
): string {
	if (
		cacheRead === undefined ||
		cacheRead === null ||
		cacheWrite === undefined ||
		cacheWrite === null
	) {
		return "\u{1F4E6} --/--";
	}
	return `\u{1F4E6} ${formatTokens(cacheRead)}/${formatTokens(cacheWrite)}`;
}

/** Format elapsed ms → "⏱ Xh Ym Zs" */
function formatSessionTimer(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `\u23f1 ${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `\u23f1 ${minutes}m ${seconds}s`;
	return `\u23f1 ${seconds}s`;
}

/** Build right section string: timer · tokens, or just timer, or just tokens */
function buildRightSection(
	showTimer: boolean,
	timerMs: number,
	tokenDisplay: string | null,
): string {
	const timerStr = showTimer ? formatSessionTimer(timerMs) : null;
	if (timerStr && tokenDisplay) return `${timerStr} \u00b7 ${tokenDisplay}`;
	if (timerStr) return timerStr;
	return tokenDisplay ?? "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// formatSessionTimer tests
// ---------------------------------------------------------------------------

describe("formatSessionTimer", () => {
	it("0ms → ⏱ 0s", () => {
		assert.strictEqual(formatSessionTimer(0), "\u23f1 0s");
	});

	it("sub-minute: 30s → ⏱ 30s", () => {
		assert.strictEqual(formatSessionTimer(30_000), "\u23f1 30s");
	});

	it("multi-minute: 5m 30s → ⏱ 5m 30s", () => {
		assert.strictEqual(formatSessionTimer(330_000), "\u23f1 5m 30s");
	});

	it("multi-hour: 1h 23m 45s → ⏱ 1h 23m 45s", () => {
		assert.strictEqual(formatSessionTimer(5_025_000), "\u23f1 1h 23m 45s");
	});

	it(">24h: 26h 15m → ⏱ 26h 15m 0s", () => {
		// 26h 15m = 94,500,000ms
		assert.strictEqual(formatSessionTimer(94_500_000), "\u23f1 26h 15m 0s");
	});

	it("exact hour: 1h → ⏱ 1h 0m 0s", () => {
		assert.strictEqual(formatSessionTimer(3_600_000), "\u23f1 1h 0m 0s");
	});

	it("exact minute: 1m → ⏱ 1m 0s", () => {
		assert.strictEqual(formatSessionTimer(60_000), "\u23f1 1m 0s");
	});
});

// ---------------------------------------------------------------------------
// Footer right section integration tests
// ---------------------------------------------------------------------------

describe("footer right section — session timer", () => {
	it("timer with token display → ⏱ ... · ◉ ...", () => {
		const result = buildRightSection(true, 330_000, "\u25c9 12.5K/200K [6%]");
		assert.strictEqual(result, "\u23f1 5m 30s \u00b7 \u25c9 12.5K/200K [6%]");
	});

	it("timer hidden (showTimer=false) → only token display", () => {
		const result = buildRightSection(false, 330_000, "\u25c9 12.5K/200K [6%]");
		assert.strictEqual(result, "\u25c9 12.5K/200K [6%]");
	});

	it("timer visible, no token data → timer alone", () => {
		const result = buildRightSection(true, 60_000, null);
		assert.strictEqual(result, "\u23f1 1m 0s");
	});

	it("timer hidden, no token data → empty string", () => {
		const result = buildRightSection(false, 0, null);
		assert.strictEqual(result, "");
	});
});

describe("context-info extension — happy path", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.1: model_select then assistant message with usage → emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});

		assert.strictEqual(ctx.logCalls.length, 1);
		assert.strictEqual(
			ctx.logCalls[0],
			'{"type":"context_info","contextTokens":12400,"contextWindow":256000}',
		);
	});

	it("P2.2: message_end before model_select → deferred emit", () => {
		invoke(ctx, "session_start", {});
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		// No emit yet — waiting for model info
		assert.strictEqual(ctx.logCalls.length, 0);

		// Now model info arrives → emit
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		assert.strictEqual(ctx.logCalls.length, 1);
		assert.strictEqual(
			ctx.logCalls[0],
			'{"type":"context_info","contextTokens":12400,"contextWindow":256000}',
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
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.4: contextWindow is 0 → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 0 } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.5: contextWindow undefined → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: undefined } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.6: getContextUsage returns undefined → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		// Don't call setCtxUsage — getContextUsage returns undefined
		invoke(ctx, "message_end", { message: { role: "assistant" } });
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.7: getContextUsage returns tokens=0 → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 0);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.8: message role is not assistant → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "user" },
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
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
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
		setCtxUsage(ctx, 12400);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 1);

		// Round 2 — reset mockCtx as well (new session)
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 512000 } });
		setCtxUsage(ctx, 8000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 2);
		assert.strictEqual(
			ctx.logCalls[1],
			'{"type":"context_info","contextTokens":8000,"contextWindow":512000}',
		);
	});
});

describe("context-info extension — error resilience", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("P2.13: getContextUsage returns negative tokens → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		setCtxUsage(ctx, -1);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});

	it("P2.14: contextWindow negative → no emit", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: -1 } });
		setCtxUsage(ctx, 1000);
		invoke(ctx, "message_end", {
			message: { role: "assistant" },
		});
		assert.strictEqual(ctx.logCalls.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Cache stats capture tests
// ---------------------------------------------------------------------------

describe("context-info extension — cache stats capture", () => {
	let ctx: TestCtx;

	beforeEach(() => {
		ctx = createContextInfoExtension();
	});

	it("message_end with usage.cacheRead=76288 cacheWrite=0 → captures values", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 76288, cacheWrite: 0 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), 76288);
		assert.strictEqual(getCacheWrite(ctx), 0);
	});

	it("message_end without usage → cacheRead/cacheWrite remain undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: { role: "assistant", content: [] },
		});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});

	it("message_end with usage but missing cacheRead → cacheRead stays undefined", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { totalTokens: 100, input: 50, output: 50 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});

	it("session_start resets cache stats", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "assistant",
				usage: { cacheRead: 100, cacheWrite: 50 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), 100);

		// New session resets
		invoke(ctx, "session_start", {});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});

	it("message_end role is not assistant → does not capture cache stats", () => {
		invoke(ctx, "session_start", {});
		invoke(ctx, "model_select", { model: { contextWindow: 256000 } });
		invoke(ctx, "message_end", {
			message: {
				role: "user",
				usage: { cacheRead: 100, cacheWrite: 50 },
			},
		});
		assert.strictEqual(getCacheRead(ctx), undefined);
		assert.strictEqual(getCacheWrite(ctx), undefined);
	});
});

// ---------------------------------------------------------------------------
// formatCacheStats tests
// ---------------------------------------------------------------------------

describe("formatCacheStats", () => {
	it("formatCacheStats(76288, 0) → 📦 76.3K/0", () => {
		assert.strictEqual(formatCacheStats(76288, 0), "\u{1F4E6} 76.3K/0");
	});

	it("formatCacheStats(1200000, 500) → 📦 1.2M/500", () => {
		assert.strictEqual(formatCacheStats(1200000, 500), "\u{1F4E6} 1.2M/500");
	});

	it("formatCacheStats(0, 0) → 📦 0/0", () => {
		assert.strictEqual(formatCacheStats(0, 0), "\u{1F4E6} 0/0");
	});

	it("formatCacheStats(undefined, undefined) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(undefined, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(null, undefined) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(null, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(0, undefined) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(0, undefined), "\u{1F4E6} --/--");
	});

	it("formatCacheStats(undefined, 0) → 📦 --/--", () => {
		assert.strictEqual(formatCacheStats(undefined, 0), "\u{1F4E6} --/--");
	});
});
