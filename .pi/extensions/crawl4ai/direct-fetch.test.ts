/**
 * Tests for directFetchCrawl — onUpdate wiring
 *
 * Layer: (D) Domain/Unit — mock fetch + mock onUpdate, no infra needed.
 * Fast, no network, no Docker, no filesystem.
 */

import assert from "node:assert/strict";
import { describe, it, mock, afterEach } from "node:test";
import { directFetchCrawl } from "./direct-fetch.ts";

/**
 * Helper: create a mock Response with given body and options.
 */
function htmlResponse(html: string, status = 200, contentType = "text/html"): Response {
	return new Response(html, {
		status,
		statusText: status === 200 ? "OK" : "Not Found",
		headers: { "content-type": contentType },
	});
}

describe("directFetchCrawl — onUpdate wiring", { concurrency: false }, () => {
	afterEach(() => {
		mock.restoreAll();
	});

	// ── Test 1: Happy path, single page ──

	it("(D) happy path single page — onUpdate called 2× with correct args", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();

		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) =>
			Promise.resolve(htmlResponse("<html><body><p>Hello world</p></body></html>")),
		);

		const result = await directFetchCrawl("https://example.com", 1, undefined, onUpdate);

		assert.equal(onUpdate.mock.calls.length, 2, "onUpdate called 2×");

		// call0: before-fetch
		const arg0 = onUpdate.mock.calls[0].arguments[0] as {
			content: Array<{ type: string; text: string }>;
			details: unknown;
		};
		assert.equal(arg0.content[0].type, "text");
		assert.ok(
			arg0.content[0].text.startsWith("Fetching"),
			`call0 starts with Fetching: ${arg0.content[0].text}`,
		);
		assert.ok(arg0.content[0].text.includes("https://example.com"));
		assert.ok(arg0.details !== undefined, "details field present");

		// call1: after-success
		const arg1 = onUpdate.mock.calls[1].arguments[0] as {
			content: Array<{ type: string; text: string }>;
			details: unknown;
		};
		assert.equal(arg1.content[0].type, "text");
		assert.ok(
			arg1.content[0].text.startsWith("Fetched"),
			`call1 starts with Fetched: ${arg1.content[0].text}`,
		);
		assert.ok(arg1.content[0].text.includes("https://example.com"));

		// Return string contains converted markdown
		assert.ok(result.includes("Hello world"));
	});

	// ── Test 2: Happy path, two pages ──

	it("(D) happy path two pages — onUpdate called 4× with phase ordering", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();

		mock.method(globalThis, "fetch", (url: string, _opts?: RequestInit) => {
			if (url === "https://example.com/page2") {
				return Promise.resolve(htmlResponse("<html><body><p>Page 2 content</p></body></html>"));
			}
			return Promise.resolve(
				htmlResponse('<html><body><p>Page 1</p><a href="/page2">Link</a></body></html>'),
			);
		});

		const result = await directFetchCrawl("https://example.com", 2, undefined, onUpdate);

		assert.equal(onUpdate.mock.calls.length, 4, "onUpdate called 4× (2 pages × 2 calls)");

		// Verify phase ordering: before-fetch, after-success, before-fetch, after-success
		const texts = onUpdate.mock.calls.map(
			(c) => (c.arguments[0] as { content: Array<{ text: string }> }).content[0].text,
		);
		assert.match(texts[0], /^Fetching/, "call0: Fetching page 1");
		assert.match(texts[1], /^Fetched/, "call1: Fetched page 1");
		assert.match(texts[2], /^Fetching/, "call2: Fetching page 2");
		assert.match(texts[3], /^Fetched/, "call3: Fetched page 2");

		assert.ok(result.includes("Page 1"));
		assert.ok(result.includes("Page 2 content"));
	});

	// ── Test 3: HTTP error (404) ──

	it("(D) HTTP error 404 — onUpdate called with error text", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();

		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) =>
			Promise.resolve(
				new Response("Not Found", {
					status: 404,
					statusText: "Not Found",
					headers: { "content-type": "text/html" },
				}),
			),
		);

		const result = await directFetchCrawl("https://example.com", 1, undefined, onUpdate);

		assert.equal(onUpdate.mock.calls.length, 2, "onUpdate called 2×");

		// call0: before-fetch
		const arg0 = onUpdate.mock.calls[0].arguments[0] as {
			content: Array<{ text: string }>;
		};
		assert.match(arg0.content[0].text, /^Fetching/);

		// call1: error
		const arg1 = onUpdate.mock.calls[1].arguments[0] as {
			content: Array<{ text: string }>;
		};
		assert.match(arg1.content[0].text, /^Error/, `starts with Error: ${arg1.content[0].text}`);
		assert.ok(arg1.content[0].text.includes("404") || arg1.content[0].text.includes("Not Found"));

		assert.ok(result.includes("404"));
		assert.ok(result.includes("Not Found"));
	});

	// ── Test 4: Network error ──

	it("(D) network error — onUpdate called with error text", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();

		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) =>
			Promise.reject(new Error("fetch failed")),
		);

		const result = await directFetchCrawl("https://example.com", 1, undefined, onUpdate);

		assert.equal(onUpdate.mock.calls.length, 2, "onUpdate called 2×");

		// call0: before-fetch
		const arg0 = onUpdate.mock.calls[0].arguments[0] as {
			content: Array<{ text: string }>;
		};
		assert.match(arg0.content[0].text, /^Fetching/);

		// call1: error
		const arg1 = onUpdate.mock.calls[1].arguments[0] as {
			content: Array<{ text: string }>;
		};
		assert.match(arg1.content[0].text, /^Error/);
		assert.ok(arg1.content[0].text.includes("fetch failed"));

		assert.ok(result.includes("fetch failed"));
	});

	// ── Test 5: onUpdate undefined ──

	it("(D) onUpdate undefined — no crash, same result as no-op", async () => {
		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) =>
			Promise.resolve(htmlResponse("<html><body><p>Hello world</p></body></html>")),
		);

		const resultUndefined = await directFetchCrawl("https://example.com", 1, undefined, undefined);
		const resultNoop = await directFetchCrawl("https://example.com", 1, undefined, () => {});

		assert.strictEqual(resultUndefined, resultNoop);
		assert.ok(resultUndefined.includes("Hello world"));
	});

	// ── Test 6: AbortSignal aborted mid-crawl ──

	it("(D) AbortSignal aborted mid-crawl — onUpdate called with error on second page", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();
		let fetchCount = 0;

		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) => {
			fetchCount++;
			if (fetchCount === 1) {
				return Promise.resolve(
					htmlResponse('<html><body><p>Page 1</p><a href="/page2">Link</a></body></html>'),
				);
			}
			return Promise.reject(new Error("The operation was aborted"));
		});

		const result = await directFetchCrawl("https://example.com", 2, undefined, onUpdate);

		assert.equal(onUpdate.mock.calls.length, 4, "onUpdate called 4×");

		// Phase order: Fetching, Fetched, Fetching, Error
		const texts = onUpdate.mock.calls.map(
			(c) => (c.arguments[0] as { content: Array<{ text: string }> }).content[0].text,
		);
		assert.match(texts[0], /^Fetching/, "call0: Fetching page 1");
		assert.match(texts[1], /^Fetched/, "call1: Fetched page 1");
		assert.match(texts[2], /^Fetching/, "call2: Fetching page 2");
		assert.match(texts[3], /^Error/, "call3: Error page 2");
		assert.ok(texts[3].includes("aborted"), "error text mentions abort");

		assert.ok(result.includes("Page 1"), "result includes page 1 content");
		assert.ok(result.includes("aborted"), "result includes abort error");
	});

	// ── Test 7: Non-HTML content type ──

	it("(D) non-HTML content type — onUpdate called with before-fetch then after-success", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();

		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) =>
			Promise.resolve(
				new Response('{"ok":true}', {
					status: 200,
					statusText: "OK",
					headers: {
						"content-type": "application/json",
					},
				}),
			),
		);

		const result = await directFetchCrawl("https://example.com", 1, undefined, onUpdate);

		assert.equal(onUpdate.mock.calls.length, 2, "onUpdate called 2×");

		// call0: before-fetch
		const arg0 = onUpdate.mock.calls[0].arguments[0] as {
			content: Array<{ text: string }>;
		};
		assert.match(arg0.content[0].text, /^Fetching/);

		// call1: after-success (non-HTML is treated as processed)
		const arg1 = onUpdate.mock.calls[1].arguments[0] as {
			content: Array<{ text: string }>;
		};
		assert.match(
			arg1.content[0].text,
			/^Fetched/,
			`non-HTML gets Fetched: ${arg1.content[0].text}`,
		);
		assert.ok(arg1.content[0].text.includes("non-HTML") || arg1.content[0].text.includes("json"));

		assert.ok(result.includes("[Non-HTML: application/json]"));
	});

	// ── Test 8: maxPages=1, multiple links on page ──

	it("(D) maxPages=1 multiple links — onUpdate called exactly 2×", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();

		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) =>
			Promise.resolve(
				htmlResponse(
					'<html><body><p>Page 1</p><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></body></html>',
				),
			),
		);

		const result = await directFetchCrawl("https://example.com", 1, undefined, onUpdate);

		// Only 1 page crawled despite 3 links
		assert.equal(onUpdate.mock.calls.length, 2, "onUpdate called 2× (not 6×) for 1 page");

		assert.ok(result.includes("Page 1"));

		// Verify no further pages were processed
		const texts = onUpdate.mock.calls.map(
			(c) => (c.arguments[0] as { content: Array<{ text: string }> }).content[0].text,
		);
		assert.match(texts[0], /^Fetching/);
		assert.match(texts[1], /^Fetched/);
	});

	// ── Test 9: Empty HTML ──

	it("(D) empty HTML — onUpdate called 2× normally, result contains [No extractable content]", async () => {
		const onUpdate = mock.fn<(...args: unknown[]) => void>();

		mock.method(globalThis, "fetch", (_url: string, _opts?: RequestInit) =>
			Promise.resolve(htmlResponse("<html></html>")),
		);

		const result = await directFetchCrawl("https://example.com", 1, undefined, onUpdate);

		assert.equal(onUpdate.mock.calls.length, 2, "onUpdate called 2×");

		const texts = onUpdate.mock.calls.map(
			(c) => (c.arguments[0] as { content: Array<{ text: string }> }).content[0].text,
		);
		assert.match(texts[0], /^Fetching/);
		assert.match(texts[1], /^Fetched/);

		assert.ok(result.includes("[No extractable content]"));
	});
});
