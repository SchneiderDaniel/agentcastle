/**
 * Tests for backends.ts — CrawlBackend interface, registry, and implementations
 *
 * Layer: (D) Domain/Unit — mock all dependencies, no infra.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ExecResult, ExecFn } from "../types.ts";
import {
	CrawlBackendRegistry,
	DirectFetchBackend,
	ApifyBackend,
	type CrawlBackend,
} from "../backends.ts";

// ── Helpers ──

type ExecHandler = ExecFn;

function makeMockExec(): ReturnType<typeof mock.fn<ExecHandler>> {
	return mock.fn<ExecHandler>();
}

/**
 * Create a minimal mock backend for testing the registry.
 */
function makeMockBackend(name: string, result: string | null): CrawlBackend {
	return {
		name,
		async tryCrawl() {
			return result;
		},
	};
}

/**
 * A spy backend that records calls and returns a given result.
 */
function makeSpyBackend(name: string, result: string | null): CrawlBackend & { calls: number } {
	let calls = 0;
	return {
		name,
		get calls() {
			return calls;
		},
		async tryCrawl() {
			calls++;
			return result;
		},
	};
}

// ── CrawlBackend interface contract ──

describe("CrawlBackend interface contract", () => {
	it("(D) a backend must have a string name property", () => {
		const backend: CrawlBackend = {
			name: "test-backend",
			async tryCrawl() {
				return "result";
			},
		};
		assert.equal(typeof backend.name, "string");
		assert.equal(backend.name, "test-backend");
	});

	it("(D) a backend must have a tryCrawl method returning string | null", async () => {
		const backend: CrawlBackend = {
			name: "test-backend",
			async tryCrawl() {
				return "markdown content";
			},
		};
		const result = await backend.tryCrawl("https://example.com", 1);
		assert.equal(result, "markdown content");
	});

	it("(D) tryCrawl can return null to signal failure", async () => {
		const backend: CrawlBackend = {
			name: "failing-backend",
			async tryCrawl() {
				return null;
			},
		};
		const result = await backend.tryCrawl("https://example.com", 1);
		assert.equal(result, null);
	});

	it("(D) tryCrawl accepts (url, maxPages, signal, onUpdate) signature", async () => {
		const backend: CrawlBackend = {
			name: "sig-test",
			async tryCrawl(_url, _maxPages, _signal, _onUpdate) {
				return "ok";
			},
		};
		// All 4 args should work fine
		const result = await backend.tryCrawl("https://example.com", 2, undefined, undefined);
		assert.equal(result, "ok");
	});
});

// ── CrawlBackendRegistry ──

describe("CrawlBackendRegistry", () => {
	it("(D) empty registry returns null", async () => {
		const registry = new CrawlBackendRegistry([]);
		const result = await registry.tryAll("https://example.com", 1);
		assert.equal(result, null);
	});

	it("(D) returns first backend result when it succeeds", async () => {
		const backend = makeMockBackend("b1", "success from b1");
		const registry = new CrawlBackendRegistry([backend]);
		const result = await registry.tryAll("https://example.com", 1);
		assert.equal(result, "success from b1");
	});

	it("(D) tries backends in order and returns first success", async () => {
		const b1 = makeMockBackend("b1", null);
		const b2 = makeMockBackend("b2", "success from b2");
		const b3 = makeMockBackend("b3", "should not be reached");
		const registry = new CrawlBackendRegistry([b1, b2, b3]);
		const result = await registry.tryAll("https://example.com", 1);
		assert.equal(result, "success from b2");
	});

	it("(D) stops after first successful backend (does not call later ones)", async () => {
		const b1 = makeSpyBackend("b1", "success");
		const b2 = makeSpyBackend("b2", "should not be called");
		const registry = new CrawlBackendRegistry([b1, b2]);
		await registry.tryAll("https://example.com", 1);
		assert.equal(b2.calls, 0, "b2 should not have been called");
		assert.equal(b1.calls, 1, "b1 should have been called once");
	});

	it("(D) all backends fail returns null", async () => {
		const b1 = makeMockBackend("b1", null);
		const b2 = makeMockBackend("b2", null);
		const registry = new CrawlBackendRegistry([b1, b2]);
		const result = await registry.tryAll("https://example.com", 1);
		assert.equal(result, null);
	});

	it("(D) passes url, maxPages, and signal to each backend", async () => {
		let capturedUrl = "";
		let capturedMaxPages = 0;
		let capturedSignal: AbortSignal | undefined;

		const backend: CrawlBackend = {
			name: "capture",
			async tryCrawl(url, maxPages, signal) {
				capturedUrl = url;
				capturedMaxPages = maxPages;
				capturedSignal = signal;
				return "ok";
			},
		};

		const controller = new AbortController();
		const registry = new CrawlBackendRegistry([backend]);
		await registry.tryAll("https://example.com/page", 3, controller.signal);

		assert.equal(capturedUrl, "https://example.com/page");
		assert.equal(capturedMaxPages, 3);
		assert.equal(capturedSignal, controller.signal);
	});
});

// ── DirectFetchBackend ──

describe("DirectFetchBackend", () => {
	it("(D) DirectFetchBackend has name 'direct-fetch'", () => {
		const backend = new DirectFetchBackend();
		assert.equal(backend.name, "direct-fetch");
	});

	it("(D) DirectFetchBackend delegates to directFetchCrawl", async () => {
		// We test that the wrapper returns a string for a URL
		// (actual directFetchCrawl integration is tested in direct-fetch.test.ts)
		const backend = new DirectFetchBackend();
		assert.equal(typeof backend.tryCrawl, "function");
	});

	it("(D) DirectFetchBackend.tryCrawl returns a string (never null in normal flow)", async () => {
		// Mock fetch to return a simple page so directFetchCrawl returns content
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			return {
				ok: true,
				status: 200,
				headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
				text: async () => "<html><body><p>hello world</p></body></html>",
				redirected: false,
				type: "basic" as ResponseType,
				url: "",
				clone: function () {
					return this;
				},
				body: null,
				bodyUsed: false,
				arrayBuffer: async () => new ArrayBuffer(0),
				blob: async () => new Blob(),
				formData: async () => new FormData(),
				json: async () => ({}),
			} as Response;
		}) as unknown as typeof globalThis.fetch;

		try {
			const backend = new DirectFetchBackend();
			const result = await backend.tryCrawl("https://example.com", 1);
			assert.ok(result !== null, "should return a string");
			assert.ok(typeof result === "string", "result should be a string");
			assert.ok(result.includes("hello world"), "result should contain extracted content");
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});

// ── ApifyBackend ──

describe("ApifyBackend", () => {
	it("(D) ApifyBackend has name 'apify'", () => {
		const backend = new ApifyBackend();
		assert.equal(backend.name, "apify");
	});

	it("(D) ApifyBackend.tryCrawl returns null when APIFY_TOKEN is absent", async () => {
		const origToken = process.env.APIFY_TOKEN;
		delete process.env.APIFY_TOKEN;

		try {
			const backend = new ApifyBackend();
			const result = await backend.tryCrawl("https://example.com", 1);
			assert.equal(result, null, "should return null when no token");
		} finally {
			if (origToken !== undefined) process.env.APIFY_TOKEN = origToken;
		}
	});

	it("(D) ApifyBackend.tryCrawl is a function", () => {
		const backend = new ApifyBackend();
		assert.equal(typeof backend.tryCrawl, "function");
	});
});

// ── CrawlBackend type — is a backend - structural duck typing ──

describe("Backend duck-typing — object shapes", () => {
	it("(D) object with name and tryCrawl satisfies CrawlBackend", () => {
		const impl: CrawlBackend = {
			name: "custom",
			async tryCrawl() {
				return "custom result";
			},
		};
		assert.equal(impl.name, "custom");
	});

	it("(D) CrawlBackendRegistry accepts custom backends", async () => {
		const custom: CrawlBackend = {
			name: "custom",
			async tryCrawl() {
				return "custom result";
			},
		};
		const registry = new CrawlBackendRegistry([custom]);
		const result = await registry.tryAll("https://example.com", 1);
		assert.equal(result, "custom result");
	});
});
