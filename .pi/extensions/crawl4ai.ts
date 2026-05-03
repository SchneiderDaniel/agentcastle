import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  const base = new URL(baseUrl);
  while ((match = regex.exec(html)) !== null) {
    try {
      const url = new URL(match[1], baseUrl).href;
      // Same-origin only, skip fragments
      if (new URL(url).origin !== base.origin) continue;
      const clean = url.split("#")[0];
      if (!seen.has(clean)) {
        seen.add(clean);
        links.push(clean);
      }
    } catch {
      // ignore invalid URLs
    }
  }
  return links;
}

function htmlToMarkdown(html: string): string {
  // Remove unwanted tags entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Block elements → newlines
  text = text.replace(/<(\/\s*)?(p|div|section|article|main|blockquote)[^>]*>/gi, "\n");
  text = text.replace(/<(\/\s*)?(h[1-6])[^>]*>/gi, (_m, _slash, tag) => {
    const level = parseInt(tag[1], 10);
    return "\n" + "#".repeat(level) + " ";
  });
  text = text.replace(/<(\/\s*)?(ul|ol)[^>]*>/gi, "\n");
  text = text.replace(/<(\/\s*)?li[^>]*>/gi, "\n- ");
  text = text.replace(/<(\/\s*)?(tr|br)[^>]*>/gi, "\n");
  text = text.replace(/<(\/\s*)?(td|th)[^>]*>/gi, " | ");

  // Links → markdown
  text = text.replace(
    /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, inner) => {
      const label = htmlToPlainText(inner).trim();
      return `[${label}](${href})`;
    },
  );

  // Images
  text = text.replace(
    /<img[^>]+src=["']([^"']+)["'][^>]*>/gi,
    (_m, src) => `\n![image](${src})\n`,
  );

  // Bold / italic
  text = text.replace(/<(\/?)(strong|b)[^>]*>/gi, "**");
  text = text.replace(/<(\/?)(em|i)[^>]*>/gi, "_");
  text = text.replace(/<(\/?)code[^>]*>/gi, "`");
  text = text.replace(/<(\/?)pre[^>]*>/gi, "\n```\n");

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, num) => String.fromCharCode(parseInt(num, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));

  // Collapse whitespace
  text = text
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

function htmlToPlainText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description:
      "Crawl and extract markdown content from web pages. " +
      "Fetches pages directly and converts HTML to clean markdown. " +
      "Use when the user asks to search the web, scrape a page, " +
      "extract content from a URL, or crawl a site.",
    promptSnippet:
      "Crawl web pages and return extracted markdown content",
    parameters: Type.Object({
      url: Type.String({
        description: "URL to crawl (e.g. https://example.com)",
      }),
      maxPages: Type.Optional(
        Type.Number({
          default: 1,
          description: "Maximum pages to crawl (default 1)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const maxPages = Math.min(Math.max(1, params.maxPages ?? 1), 10);
      const visited = new Set<string>();
      const queue: string[] = [params.url];
      const results: string[] = [];

      while (queue.length > 0 && visited.size < maxPages) {
        const url = queue.shift()!;
        if (visited.has(url)) continue;
        visited.add(url);

        onUpdate?.({
          content: [{ type: "text", text: `Crawling ${url} ...` }],
        });

        try {
          const res = await fetch(url, {
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
            results.push(`--- ${url} ---\nError: HTTP ${res.status} ${res.statusText}`);
            continue;
          }

          const contentType = res.headers.get("content-type") || "";
          if (!contentType.includes("text/html")) {
            const snippet = await res.text();
            results.push(
              `--- ${url} ---\n[Non-HTML content: ${contentType}]\n${snippet.slice(0, 800)}`,
            );
            continue;
          }

          const html = await res.text();
          const md = htmlToMarkdown(html);
          results.push(`--- ${url} ---\n${md || "[No extractable content]"}`);

          // Queue same-origin links if we need more pages
          if (visited.size < maxPages) {
            const links = extractLinks(html, url);
            for (const link of links) {
              if (!visited.has(link) && !queue.includes(link)) {
                queue.push(link);
              }
            }
          }
        } catch (err: any) {
          results.push(`--- ${url} ---\nError: ${err.message ?? err}`);
        }
      }

      return {
        content: [
          {
            type: "text",
            text:
              results.join("\n\n") || "Crawl completed but no content was extracted.",
          },
        ],
      };
    },
  });
}
