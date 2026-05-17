/**
 * crawl4ai extension entry point — orchestrator.
 *
 * Closure state (venvReady, depsReady) + pi.registerTool call only.
 * Fallback chain: crawl4ai -> Apify -> direct fetch.
 * Preserves existing behavior exactly.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import { CRAWL4AI_SCRIPT } from "./python-script";
import { ensurePythonVenv, ensureChromiumDeps } from "./venv-setup";
import { apifyCrawl } from "./apify-crawl";
import { directFetchCrawl } from "./direct-fetch";

export default function crawl4ai(pi: ExtensionAPI): void {
	const venvReady = new Map<string, boolean>();
	const depsReady = new Map<string, boolean>();

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

			onUpdate?.({
				content: [{ type: "text", text: `Crawling ${params.url} …` }],
				details: {} as Record<string, unknown>,
			});

			// 1. Try local crawl4ai (preferred)
			const cwd = _ctx.cwd;
			const python = await ensurePythonVenv(pi.exec, cwd, onUpdate, venvReady);
			const depsDir = await ensureChromiumDeps(pi.exec, cwd, onUpdate, depsReady);
			if (python && depsDir) {
				const cfg = JSON.stringify({ url: params.url, maxPages });
				const browsersPath = (os.homedir() || "/tmp") + "/.cache/ms-playwright";
				// Base64-encode script & config to avoid bash escaping issues.
				// Use bash -c to set LD_LIBRARY_PATH (ExecOptions has no 'env' field).
				const scriptB64 = Buffer.from(CRAWL4AI_SCRIPT, "utf-8").toString("base64");
				const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
				const run = await pi.exec(
					"bash",
					[
						"-c",
						"LD_LIBRARY_PATH=" +
							depsDir +
							":$LD_LIBRARY_PATH " +
							"PLAYWRIGHT_BROWSERS_PATH=" +
							browsersPath +
							" " +
							python +
							' -c "$(echo ' +
							scriptB64 +
							' | base64 -d)" ' +
							'"$(echo ' +
							cfgB64 +
							' | base64 -d)"',
					],
					{
						timeout: 120_000,
						signal,
					},
				);
				if (run.code === 0) {
					try {
						// stdout may contain crawl4ai progress lines before the final JSON.
						// Extract the last JSON object from stdout.
						const lines = run.stdout.split("\n");
						let jsonStr = "";
						for (let i = lines.length - 1; i >= 0; i--) {
							const trimmed = lines[i].trim();
							if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
								jsonStr = trimmed;
								break;
							}
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
						// parsing failed → fall through
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
