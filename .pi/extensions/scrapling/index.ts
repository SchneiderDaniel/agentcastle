/**
 * web_crawl — Web page crawling and content extraction via Scrapling
 *
 * Uses Scrapling's Progressive Fetching Strategy:
 *   Tier 1: Lightweight zero-browser fetcher (~40MB RAM) for most pages
 *   Tier 2: Heavy Playwright StealthyFetcher (~800MB RAM) for Cloudflare bypass
 *
 * Concurrency semaphore (MAX_CONCURRENT_CRAWLS = 2) prevents OOM on 8GB RAM machines.
 * File-based lock prevents parallel agents from corrupting the venv on fresh start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ensureScraplingVenv } from "./venv-setup";
import { SCRAPLING_SCRIPT } from "./python-script";

// Concurrency lock: Max 2 simultaneous web crawls to protect 8GB RAM
let activeCrawls = 0;
const MAX_CONCURRENT_CRAWLS = 2;

async function acquireCrawlLock(): Promise<void> {
	while (activeCrawls >= MAX_CONCURRENT_CRAWLS) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	activeCrawls++;
}

function releaseCrawlLock(): void {
	activeCrawls = Math.max(0, activeCrawls - 1);
}

export default function webCrawlExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_crawl",
		label: "Web Crawl",
		description:
			"Crawl web pages. Uses lightweight fetcher normally, " +
			"automatically bypasses Cloudflare if blocked.",
		promptSnippet:
			"Crawl web pages and extract content as Markdown, with automatic Cloudflare bypass",
		promptGuidelines: [
			"Use web_crawl for public web pages, especially behind Cloudflare or bot protection; prefer read for local files and bash curl for simple API calls without anti-bot measures.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to crawl (e.g. https://example.com)" }),
			maxPages: Type.Optional(
				Type.Number({
					default: 1,
					description: "Maximum pages to crawl (default 1, max 10)",
				}),
			),
			maxTokens: Type.Optional(
				Type.Number({
					description:
						"Hard token limit per page (rough estimate). Content beyond limit is truncated with notice. 0 = no limit.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			await acquireCrawlLock();

			try {
				const maxPages = Math.min(Math.max(1, params.maxPages ?? 1), 10);

				// URL validation — reject invalid URLs early
				try {
					new URL(params.url);
				} catch {
					throw new Error("Invalid URL");
				}

				onUpdate?.({
					content: [{ type: "text", text: `Crawling ${params.url} …` }],
					details: {} as Record<string, unknown>,
				});

				const cwd = _ctx.cwd;

				const python = await ensureScraplingVenv(pi.exec, cwd, onUpdate);

				const cfg = JSON.stringify({ url: params.url, maxPages });
				const scriptB64 = Buffer.from(SCRAPLING_SCRIPT, "utf-8").toString("base64");
				const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");

				const run = await pi.exec(
					"bash",
					["-c", `${python} -c "$(echo ${scriptB64} | base64 -d)" "$(echo ${cfgB64} | base64 -d)"`],
					{ timeout: 120_000, signal },
				);

				if (run.code === 0) {
					try {
						const parsed = JSON.parse(
							run.stdout.split("\n").find((l) => l.startsWith("{") && l.endsWith("}")) ||
								run.stdout,
						);
						if (parsed.ok && parsed.results) {
							// Cast needed because pi tool params type isn't updated when schema changes
							const maxTokens = (params as { maxTokens?: number }).maxTokens ?? 25000;
							const texts = parsed.results.map((r: any) => {
								if (!r.success) {
									return `--- ${r.url} ---\nError: ${r.error}`;
								}
								let content = r.markdown || "[No content]";
								if (maxTokens > 0) {
									// Rough token estimate: ~4 chars per token for English text
									const estimatedTokens = Math.round(content.length / 4);
									if (estimatedTokens > maxTokens) {
										const maxChars = maxTokens * 4;
										const truncated = content.slice(0, maxChars);
										content = `${truncated}\n\n[... truncated at ~${maxTokens.toLocaleString()} tokens (${estimatedTokens.toLocaleString()} total). Use narrower query or page-specific section.]`;
									}
								}
								return `--- ${r.url} (via ${r.method}) ---\n${content}`;
							});
							return {
								content: [{ type: "text", text: texts.join("\n\n") }],
								details: {} as Record<string, unknown>,
							};
						}
					} catch {
						/* Fallback to raw output if JSON parse fails */
					}
				}
				throw new Error(`Error executing crawl: ${run.stderr || run.stdout}`);
			} finally {
				releaseCrawlLock();
			}
		},
	});
}
