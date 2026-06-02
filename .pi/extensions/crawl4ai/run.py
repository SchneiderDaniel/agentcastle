
import asyncio
import json
import sys
import signal

signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(130))

async def main():
    with open(sys.argv[1]) as f:
        config = json.load(f)
    url = config["url"]
    max_pages = min(max(1, config.get("maxPages", 1)), 10)

    try:
        from crawl4ai import AsyncWebCrawler, CrawlerRunConfig, CacheMode
    except ImportError as e:
        print("CRAWL4AI_OK")
        print(json.dumps({"ok": False, "error": f"crawl4ai not installed: {e}"}))
        print("CRAWL4AI_DONE")
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

    print("CRAWL4AI_OK")
    print(json.dumps({"ok": True, "results": results}))
    print("CRAWL4AI_DONE")

asyncio.run(main())
