import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"crawl4ai not installed: {e}"}))
        return

    results = []
    visited = set()
    queue = [url]

    run_conf = CrawlerRunConfig(cache_mode=CacheMode.BYPASS)

    async with AsyncWebCrawler() as crawler:
        while queue and len(visited) < max_pages:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)

            try:
                try:
                    result = await crawler.arun(url=current, config=run_conf)
                except TypeError:
                    result = await crawler.arun(url=current)

                md_attr = getattr(result, "markdown", "")
                if isinstance(md_attr, str):
                    md = md_attr
                elif hasattr(md_attr, "raw_markdown"):
                    md = md_attr.raw_markdown or ""
                elif hasattr(md_attr, "fit_markdown"):
                    md = md_attr.fit_markdown or ""
                else:
                    md = str(md_attr) if md_attr else ""

                results.append({"url": current, "markdown": md, "success": True})

                if len(visited) < max_pages:
                    links = getattr(result, "links", None)
                    internal = []
                    if isinstance(links, dict):
                        internal = links.get("internal", [])
                    elif isinstance(links, list):
                        internal = links
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

export default function (pi: ExtensionAPI): void {
  // Paths computed lazily at call time — process.cwd() at module load may be stale
  let venvReady: boolean | null = null;
  let depsReady: boolean | null = null;

  function lazyPaths(cwd: string) {
    return {
      VENV_DIR: `${cwd}/.pi/crawl4ai-venv`,
      VENV_PYTHON: `${cwd}/.pi/crawl4ai-venv/bin/python3`,
      DEPS_DIR: `${cwd}/.pi/chromium-deps`,
      DEPS_LIB_DIR: `${cwd}/.pi/chromium-deps/usr/lib/x86_64-linux-gnu`,
    };
  }

  async function ensurePythonVenv(cwd: string, onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void): Promise<string | null> {
    const { VENV_PYTHON, VENV_DIR } = lazyPaths(cwd);
    if (venvReady !== null) return venvReady ? VENV_PYTHON : null;

    // Check system python3 exists
    const pyCheck = await pi.exec("python3", ["--version"]);
    if (pyCheck.code !== 0) {
      console.error("crawl4ai: python3 not found");
      venvReady = false;
      return null;
    }

    // Check if venv already set up with crawl4ai
    const alreadyOk = await pi.exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
    if (alreadyOk.code === 0 && alreadyOk.stdout.includes("ok")) {
      venvReady = true;
      return VENV_PYTHON;
    }

    // Create venv if it doesn't exist (or is broken)
    const venvCheck = await pi.exec(VENV_PYTHON, ["--version"]);
    if (venvCheck.code !== 0) {
      // Clean up any broken partial venv first
      await pi.exec("rm", ["-rf", VENV_DIR]);
      onUpdate?.({ content: [{ type: "text", text: "Creating Python virtual environment for crawl4ai…" }], details: {} as Record<string, unknown> });
      const create = await pi.exec("python3", ["-m", "venv", "--clear", VENV_DIR]);
      if (create.code !== 0) {
        console.error("crawl4ai: failed to create venv");
        venvReady = false;
        return null;
      }
    }

    // Install crawl4ai in venv
    onUpdate?.({ content: [{ type: "text", text: "Installing crawl4ai (this may take a minute)…" }], details: {} as Record<string, unknown> });
    const install = await pi.exec(VENV_PYTHON, ["-m", "pip", "install", "crawl4ai"], { timeout: 180_000 });
    if (install.code !== 0) {
      console.error("crawl4ai: pip install failed:", install.stderr.slice(0, 500));
      venvReady = false;
      return null;
    }

    // Install playwright browsers (best-effort)
    onUpdate?.({ content: [{ type: "text", text: "Installing Chromium browser for crawl4ai…" }], details: {} as Record<string, unknown> });
    await pi.exec(VENV_PYTHON, ["-m", "playwright", "install", "chromium"], { timeout: 120_000 });

    // Verify
    const verify = await pi.exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
    venvReady = verify.code === 0 && verify.stdout.includes("ok");
    return venvReady ? VENV_PYTHON : null;
  }

  async function ensureChromiumDeps(cwd: string, onUpdate?: (u: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void): Promise<string | null> {
    const { DEPS_DIR, DEPS_LIB_DIR } = lazyPaths(cwd);
    if (depsReady !== null) return depsReady ? DEPS_LIB_DIR : null;

    // Check if deps already extracted and working
    const testLib = `${DEPS_LIB_DIR}/libnspr4.so`;
    const libCheck = await pi.exec("bash", ["-c", `test -f ${testLib}`]);
    if (libCheck.code === 0) {
      depsReady = true;
      return DEPS_LIB_DIR;
    }

    // Download and extract Chromium system dependencies (without sudo)
    onUpdate?.({ content: [{ type: "text", text: "Downloading Chromium system libraries…" }], details: {} as Record<string, unknown> });

    const pkgs = ["libnspr4", "libnss3", "libasound2t64"];
    for (const pkg of pkgs) {
      const dl = await pi.exec("bash", ["-c", `cd ${DEPS_DIR} && apt-get download ${pkg}`], {
        timeout: 30_000,
      });
      if (dl.code !== 0) {
        console.error(`crawl4ai: failed to download ${pkg}`);
      }
    }

    // Extract all debs
    const findResult = await pi.exec("bash", ["-c", `ls ${DEPS_DIR}/*.deb 2>/dev/null`]);
    if (findResult.code === 0 && findResult.stdout.trim()) {
      for (const deb of findResult.stdout.trim().split("\n")) {
        await pi.exec("dpkg", ["-x", deb.trim(), DEPS_DIR]);
      }
    }

    // Verify
    const verify = await pi.exec("bash", ["-c", `test -f ${testLib}`]);
    if (verify.code !== 0) {
      console.error("crawl4ai: failed to set up Chromium system libraries");
      depsReady = false;
      return null;
    }

    depsReady = true;
    return DEPS_LIB_DIR;
  }

  async function apifyCrawl(
    url: string,
    maxPages: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const token = process.env.APIFY_TOKEN;
    if (!token) return null;

    // Use Apify's official website-content-crawler (5.0 rating, actively maintained).
    const actorId = "apify~website-content-crawler";
    const apiUrl = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${token}&timeout=120`;

    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: [{ url }],
          maxCrawlPages: maxPages,
          maxCrawlDepth: 0,
          outputFormat: "markdown",
          sameDomainOnly: true,
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`--- ${current} ---\nError: ${msg}`);
      }
    }

    return results.join("\n\n") || "Crawl completed but no content was extracted.";
  }

  // Compute paths lazily at call time (ctx.cwd may differ from process.cwd at module load)
  function getPaths(ctxCwd: string) {
    const cwd = ctxCwd;
    return {
      CWD: cwd,
      VENV_DIR: `${cwd}/.pi/crawl4ai-venv`,
      VENV_PYTHON: `${cwd}/.pi/crawl4ai-venv/bin/python3`,
      DEPS_DIR: `${cwd}/.pi/chromium-deps`,
      DEPS_LIB_DIR: `${cwd}/.pi/chromium-deps/usr/lib/x86_64-linux-gnu`,
    };
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
        details: {} as Record<string, unknown>,
      });

      // 1. Try local crawl4ai (preferred)
      const cwd = _ctx.cwd;
      const python = await ensurePythonVenv(cwd, onUpdate);
      const depsDir = await ensureChromiumDeps(cwd, onUpdate);
      if (python && depsDir) {
        const cfg = JSON.stringify({ url: params.url, maxPages });
        const browsersPath = (process.env.HOME || "/tmp") + "/.cache/ms-playwright";
        // Base64-encode script & config to avoid bash escaping issues.
        // Use bash -c to set LD_LIBRARY_PATH (ExecOptions has no 'env' field).
        const scriptB64 = Buffer.from(CRAWL4AI_SCRIPT, "utf-8").toString("base64");
        const cfgB64 = Buffer.from(cfg, "utf-8").toString("base64");
        const run = await pi.exec("bash", ["-c",
          "LD_LIBRARY_PATH=" + depsDir + ":$LD_LIBRARY_PATH " +
          "PLAYWRIGHT_BROWSERS_PATH=" + browsersPath + " " +
          python + " -c \"$(echo " + scriptB64 + " | base64 -d)\" " +
          "\"$(echo " + cfgB64 + " | base64 -d)\"",
        ], {
          timeout: 120_000,
          signal,
        });
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
        return { content: [{ type: "text", text: apifyResult }], details: {} as Record<string, unknown> };
      }

      // 3. Last resort: direct fetch + lightweight extraction
      onUpdate?.({
        content: [{ type: "text", text: "Falling back to direct HTTP fetch …" }],
        details: {} as Record<string, unknown>,
      });
      const directResult = await directFetchCrawl(params.url, maxPages, signal);
      return { content: [{ type: "text", text: directResult }], details: {} as Record<string, unknown> };
    },
  });
}
