/**
 * crawl4ai — Web page crawling and content extraction
 *
 * Provides the web_crawl tool using a pluggable CrawlBackend strategy.
 * Backends are tried in order (crawl4ai → Apify → direct HTTP fetch)
 * until one succeeds. Adding a new backend is a single import + registration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { VenvCache } from "./venv-setup";
import {
	CrawlBackendRegistry,
	LocalCrawl4aiBackend,
	ApifyBackend,
	DirectFetchBackend,
} from "./backends";

export default function crawl4ai(pi: ExtensionAPI): void {
	const venvReady: VenvCache = new Map();
	const depsReady: VenvCache = new Map();

	pi.registerTool({
		name: "web_crawl",
		label: "Web Crawl",
		description:
			"Crawl and extract markdown content from web pages using crawl4ai. " +
			"Runs locally when possible, falls back to Apify (if APIFY_TOKEN is set), " +
			"then to direct HTTP fetch. " +
			"Use when the user asks to search the web, scrape a page, " +
			"extract content from a URL, or crawl a site.",
		promptSnippet: "Crawl web pages and return extracted markdown content via crawl4ai",
		parameters: Type.Object({
			url: Type.String({
				description: "URL to crawl (e.g. https://example.com)",
			}),
			maxPages: Type.Optional(
				Type.Number({
					default: 1,
					description: "Maximum pages to crawl (default 1, max 10)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const maxPages = Math.min(Math.max(1, params.maxPages ?? 1), 10);

			// URL validation — reject invalid URLs early
			try {
				new URL(params.url);
			} catch {
				return {
					content: [{ type: "text", text: "Invalid URL" }],
					details: {} as Record<string, unknown>,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Crawling ${params.url} …` }],
				details: {} as Record<string, unknown>,
			});

			// Build fallback chain: crawl4ai → Apify → direct fetch
			const cwd = _ctx.cwd;
			const registry = new CrawlBackendRegistry([
				new LocalCrawl4aiBackend(pi.exec, cwd, venvReady, depsReady),
				new ApifyBackend(),
				new DirectFetchBackend(),
			]);

			const result = await registry.tryAll(params.url, maxPages, signal, onUpdate);
			return {
				content: [
					{ type: "text", text: result ?? "Crawl completed but no content was extracted." },
				],
				details: {} as Record<string, unknown>,
			};
		},
	});
}
