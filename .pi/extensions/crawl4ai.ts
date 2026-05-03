import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// Python script that uses local crawl4ai to extract markdown from pages.
const CRAWL4AI_SCRIPT = `
import asyncio
import json
import sys

async def main():
    config = json.loads(sys.argv[1])
    url = config["url"]
    max_pages = min(max(1, config.get("maxPages", 1)), 10)

    try:
        from crawl4ai import AsyncWebCrawler
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"crawl4ai not installed: {e}"}))
        return

    results = []
    visited = set()
    queue = [url]

    async with AsyncWebCrawler() as crawler:
        while queue and len(visited) < max_pages:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)

            try:
                # Try older API first, then newer API
                try:
                    result = await crawler.arun(url=current, bypass_cache=True)
                except TypeError:
                    result = await crawler.arun(url=current)

                md = getattr(result, "markdown", "") or ""
                results.append({"url": current, "markdown": md, "success": True})

                # Queue same-origin internal links if more pages requested
                if len(visited) < max_pages:
                    links = getattr(result, "links", {}) or {}
                    internal = links.get("internal", []) if isinstance(links, dict) else []
                    base = current.split("/")[2]
                    for link in internal:
                        if link not in visited and link not in queue:
                            queue.append(link)
            except Exception as e:
                results.append({"url": current, "error": str(e), "success": False})

    print(json.dumps({"ok": True, "results": results}))

asyncio.run(main())
`;

// Fallback lightweight HTML→markdown converter (used only if crawl4ai + Apify both fail)
function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  text = text.replace(/<(\/?)(p|div|section|article|main|blockquote)[^>]*>/gi, "\n");
  text = text.replace(/<(\/?)(h[1-6])[^>]*>/gi, (_m, _slash, tag) => {
    const level = parseInt(tag[1], 10);
    return "\n" + "#".repeat(level) + " ";
  });
  text = text.replace(/<(\/?)(ul|ol)[^>]*>/gi, "\n");
  text = text.replace(/<(\/?)li[^>]*>/gi, "\n- ");
  text = text.replace(/<(\/?)(tr|br)[^>]*>/gi, "\n");
  text = text.replace(/<(\/?)(td|th)[^>]*>/gi, " | ");
  text = text.replace(
    /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, inner) => `[${inner.replace(/<[^>]+>/g, "").trim()}](${href})`,
  );
  text = text.replace(/<(\/?)(strong|b)[^>]*>/gi, "**");
  text = text.replace(/<(\/?)(em|i)[^>]*>/gi, "_");
  text = text.replace(/<(\/?)code[^>]*>/gi, "`");
  text = text.replace(/<(\/?)pre[^>]*>/gi, "\n```\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  return text
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  let crawl4aiReady: boolean | null = null;

  async function ensureCrawl4AI(onUpdate?: (u: { content: Array<{ type: "text"; text: string }> }) => void): Promise<boolean> {
    if (crawl4aiReady !== null) return crawl4aiReady;

    const pyCheck = await pi.exec("python3", ["--version"]);
    if (pyCheck.code !== 0) {
      crawl4aiReady = false;
      return false;
    }

    const modCheck = await pi.exec("python3", ["-c", "import crawl4ai; print('ok')"]);
    if (modCheck.code !== 0) {
      onUpdate?.({ content: [{ type: "text", text: "Installing crawl4ai…" }] });
      const install = await pi.exec("python3", ["-m", "pip", "install", "crawl4ai"]);
      if (install.code !== 0) {
        crawl4aiReady = false;
        return false;
      }
      // Ensure browser binaries are available (best-effort)
      await pi.exec("python3", ["-m", "playwright", "install", "chromium"]);
    }

    crawl4aiReady = true;
    return true;
  }

  async function apifyCrawl(
    url: string,
    maxPages: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const token = process.env.APIFY_TOKEN;
    if (!token) return null;

    const actorId = "janbuchar~crawl4ai";
    const apiUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}`;

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: [{ url }],
          maxRequestsPerCrawl: maxPages,
        }),
        signal,
      });

      if (!res.ok) return null;
      const items = (await res.json()) as Array<Record<string, unknown>>;
      const texts = items.map((item) => {
        const u = String(item.url ?? url);
        const body = String(
          item.markdown ?? item.text ?? item.content ?? JSON.stringify(item, null, 2),
        );
        return `--- ${u} ---\n${body}`;
      });
      return texts.join("\n\n") || null;
    } catch {
      return null;
    }
  }

  async function directFetchCrawl(
    url: string,
    maxPages: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const visited = new Set<string>();
    const queue: string[] = [url];
    const results: string[] = [];

    while (queue.length > 0 && visited.size < maxPages) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      try {
        const res = await fetch(current, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/120.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
          signal,
        });

        if (!res.ok) {
          results.push(`--- ${current} ---\nError: HTTP ${res.status} ${res.statusText}`);
          continue;
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) {
          const snippet = await res.text();
          results.push(`--- ${current} ---\n[Non-HTML: ${contentType}]\n${snippet.slice(0, 800)}`);
          continue;
        }

        const html = await res.text();
        const md = htmlToMarkdown(html);
        results.push(`--- ${current} ---\n${md || "[No extractable content]"}`);

        if (visited.size < maxPages) {
          const base = new URL(current);
          const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
          let m: RegExpExecArray | null;
          while ((m = regex.exec(html)) !== null) {
            try {
              const link = new URL(m[1], current).href;
              if (new URL(link).origin !== base.origin) continue;
              const clean = link.split("#")[0];
              if (!visited.has(clean) && !queue.includes(clean)) queue.push(clean);
            } catch {
              // ignore
            }
          }
        }
      } catch (err: any) {
        results.push(`--- ${current} ---\nError: ${err.message ?? err}`);
      }
    }

    return results.join("\n\n") || "Crawl completed but no content was extracted.";
  }

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
      });

      // 1. Try local crawl4ai (preferred)
      const hasC4A = await ensureCrawl4AI(onUpdate);
      if (hasC4A) {
        const cfg = JSON.stringify({ url: params.url, maxPages });
        const run = await pi.exec("python3", ["-c", CRAWL4AI_SCRIPT, cfg], {
          timeout: 120_000,
          signal,
        });
        if (run.code === 0) {
          try {
            const parsed = JSON.parse(run.stdout) as {
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
              };
            }
          } catch {
            // parsing failed → fall through
          }
        }
      }

      // 2. Fall back to Apify actor
      onUpdate?.({
        content: [{ type: "text", text: "Falling back to Apify crawl4ai actor …" }],
      });
      const apifyResult = await apifyCrawl(params.url, maxPages, signal);
      if (apifyResult) {
        return { content: [{ type: "text", text: apifyResult }] };
      }

      // 3. Last resort: direct fetch + lightweight extraction
      onUpdate?.({
        content: [{ type: "text", text: "Falling back to direct HTTP fetch …" }],
      });
      const directResult = await directFetchCrawl(params.url, maxPages, signal);
      return { content: [{ type: "text", text: directResult }] };
    },
  });
}
