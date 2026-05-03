---
name: crawl4ai
description: Web crawling and content extraction using the crawl4ai Apify actor. Use when the user asks to search the web, crawl a site, extract page content, scrape URLs, or retrieve information from a specific webpage.
---

# crawl4ai Web Crawling

## Preferred method (host-side, works in sandboxed environments)

This project has a pi Extension that registers the `web_crawl` tool. It runs inside the pi agent process on the **host** and directly calls the Apify API via HTTPS, bypassing the Daytona sandbox entirely.

Use the tool like this (the agent will call it automatically):

```
web_crawl(url="https://example.com", maxPages=1)
```

## Fallback method (bash — only works if sandbox has outbound internet)

If the extension is unavailable, you can run the helper script directly:

```bash
node .pi/skills/crawl4ai/crawl.mjs "https://example.com"
```

## Setup

Ensure `APIFY_TOKEN` is exported **in the same shell where you launch pi**:

```bash
export APIFY_TOKEN=your_token_here
pi
```

> **Note:** The Daytona sandbox blocks outbound HTTPS, so `curl`, `wget`, and bash-based crawls will fail inside the sandbox. The `web_crawl` extension tool avoids this by executing on the host.
