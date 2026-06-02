/**
 * Tests for direct-fetch.ts — HTTP error messages, onUpdate removal
 *
 * Layer: (D) Domain/Unit — pure functions, mocked fetch.
 * No infra, no network.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { htmlToMarkdown, directFetchCrawl } from "../direct-fetch.ts";

function mockResponse(overrides: Partial<Response>): Response {
	const defaults: Response = {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Map() as unknown as Headers,
		text: async () => "",
		redirected: false,
		type: "basic" as ResponseType,
		url: "",
		clone: () => defaults,
		body: null,
		bodyUsed: false,
		arrayBuffer: async () => new ArrayBuffer(0),
		blob: async () => new Blob(),
		formData: async () => new FormData(),
		json: async () => ({}),
	} as Response;
	return { ...defaults, ...overrides } as Response;
}

describe("directFetchCrawl — HTTP error messages (Secondary)", () => {
	it("(D) HTTP 401 returns message containing 401 and Unauthorized", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			return mockResponse({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await directFetchCrawl("https://example.com/private", 1);
			assert.ok(result.includes("401"), "result should mention 401");
			assert.ok(result.includes("Unauthorized"), "result should mention Unauthorized");
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("(D) HTTP 403 returns message containing 403 and Forbidden", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			return mockResponse({
				ok: false,
				status: 403,
				statusText: "Forbidden",
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await directFetchCrawl("https://example.com/forbidden", 1);
			assert.ok(result.includes("403"), "result should mention 403");
			assert.ok(result.includes("Forbidden"), "result should mention Forbidden");
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("(D) Generic HTTP error returns numeric code only", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			return mockResponse({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await directFetchCrawl("https://example.com/error", 1);
			assert.ok(result.includes("500"), "result should mention 500");
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});

describe("directFetchCrawl — no onUpdate in signature (Secondary)", () => {
	it("(D) directFetchCrawl can be called with 3 args (url, maxPages, signal)", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			return mockResponse({
				ok: true,
				status: 200,
				text: async () => "<html><body><p>hello</p></body></html>",
				headers: new Map([["content-type", "text/html"]]) as unknown as Headers,
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await directFetchCrawl("https://example.com", 1);
			assert.ok(result, "should return a result");
			assert.ok(result.includes("hello"), "result should contain extracted content");
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});

describe("htmlToMarkdown — no regression (Secondary)", () => {
	it("(Regression) removes <script> tags", () => {
		const html = "<script>alert('xss')</script><p>hello</p>";
		const md = htmlToMarkdown(html);
		assert.ok(!md.includes("alert"), "script content should be removed");
		assert.ok(md.includes("hello"), "visible content should remain");
	});

	it("(Regression) converts <a> to markdown links", () => {
		const html = '<a href="https://example.com">click here</a>';
		const md = htmlToMarkdown(html);
		assert.ok(md.includes("[click here]"), "should have link text in brackets");
		assert.ok(md.includes("(https://example.com)"), "should have URL in parens");
	});

	it("(Regression) converts <h1> to # heading", () => {
		const html = "<h1>Title</h1>";
		const md = htmlToMarkdown(html);
		assert.ok(md.startsWith("# "), "h1 should convert to # heading");
		assert.ok(md.includes("Title"), "heading text should be preserved");
	});

	it("(Regression) decodes HTML entities", () => {
		const html = "<p>foo &amp; bar &lt; baz</p>";
		const md = htmlToMarkdown(html);
		assert.ok(md.includes("&"), "should decode &amp; to &");
		assert.ok(md.includes("<"), "should decode &lt; to <");
	});
});
