/**
 * crawl4ai — Web page crawling and content extraction
 *
 * Provides the web_crawl tool. Tries crawl4ai first, falls back to
 * Apify then direct HTTP fetch. Extracts page content as markdown.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import { CRAWL4AI_SCRIPT } from "./python-script";
import { ensurePythonVenv, ensureChromiumDeps } from "./venv-setup";
import type { VenvCache } from "./venv-setup";
import { runCrawl4aiScript } from "./executor";
import { apifyCrawl } from "./apify-crawl";
import { directFetchCrawl } from "./direct-fetch";

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

			// 1. Try local crawl4ai (preferred)
			const cwd = _ctx.cwd;
			const python = await ensurePythonVenv(pi.exec, cwd, onUpdate, venvReady);
			const depsDir = await ensureChromiumDeps(pi.exec, cwd, onUpdate, depsReady);
			if (python && depsDir) {
				const browsersPath = (os.homedir() || "/tmp") + "/.cache/ms-playwright";
				const run = await runCrawl4aiScript(
					python,
					depsDir,
					browsersPath,
					CRAWL4AI_SCRIPT,
					{ url: params.url, maxPages },
					120_000,
					signal,
					pi.exec,
				);
				if (run.code === 0) {
					try {
						// Parse between CRAWL4AI_OK and CRAWL4AI_DONE delimiters
						const okIdx = run.stdout.indexOf("CRAWL4AI_OK");
						const doneIdx = run.stdout.indexOf("CRAWL4AI_DONE");
						let jsonStr = "";
						if (okIdx !== -1 && doneIdx !== -1 && doneIdx > okIdx) {
							jsonStr = run.stdout.slice(okIdx + "CRAWL4AI_OK".length, doneIdx).trim();
						}
						const parsed = JSON.parse(jsonStr || run.stdout) as {
							ok: boolean;
							error?: string;
							results?: Array<{ url: string; markdown?: string; error?: string; success: boolean }>;
						};
						if (parsed.ok && parsed.results) {
							const texts = parsed.results.map((r) =>
								r.success
									? `--- ${r.url} ---\n${r.markdown || "[No content]"}`
									: `--- ${r.url} ---\nError: ${r.error}`,
							);
							return {
								content: [{ type: "text", text: texts.join("\n\n") }],
								details: {} as Record<string, unknown>,
							};
						}
					} catch {
						console.error(
							"crawl4ai: parse failed, raw stdout (first 500 chars):",
							run.stdout.slice(0, 500),
						);
						// parsing failed => fall through
					}
				}
			}

			// 2. Fall back to Apify actor
			onUpdate?.({
				content: [{ type: "text", text: "Falling back to Apify actor …" }],
				details: {} as Record<string, unknown>,
			});
			const apifyResult = await apifyCrawl(params.url, maxPages, signal);
			if (apifyResult) {
				return {
					content: [{ type: "text", text: apifyResult }],
					details: {} as Record<string, unknown>,
				};
			}

			// 3. Last resort: direct fetch + lightweight extraction
			onUpdate?.({
				content: [{ type: "text", text: "Falling back to direct HTTP fetch …" }],
				details: {} as Record<string, unknown>,
			});
			const directResult = await directFetchCrawl(params.url, maxPages, signal);
			return {
				content: [{ type: "text", text: directResult }],
				details: {} as Record<string, unknown>,
			};
		},
	});
}
