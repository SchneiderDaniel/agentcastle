# @agentcastle/web-search

**Web search tool for Pi — DuckDuckGo search with ranked results.** Returns structured results with titles, URLs, and snippets for use by researcher and other agents.

## Features

- **`web_search` tool** — Search the web using DuckDuckGo metasearch engine
  - Accepts query string and optional `maxResults` (default 10, max 50)
  - Returns ranked `[{title, url, snippet}]` results
  - Uses `ddgs` Python library with `backend="auto"` for multi-engine fallback
  - Optional proxy support for restricted environments
- **Delimiter-based output** — `SEARCH_OK` / `SEARCH_DONE` markers around JSON output for reliable parsing
- **Result cache** — Same query+maxResults returns cached result within 5-minute TTL
- **Graceful degradation** — If search fails, returns error message for the agent to handle
- **SIGTERM handling** — Python subprocess exits cleanly with code 130 on cancellation

## How it works

1. The LLM calls `web_search` with a query and optional maxResults
2. The extension validates the query (rejects empty queries)
3. **Cache check** — If the same query+maxResults was already searched within 5 minutes, the cached result is returned without re-running the subprocess
4. The extension writes the Python script and config to `.pi/web-search/` temp files
5. The script is executed via `bash -c` using `pi.exec`
6. The Python script uses `ddgs.DDGS().text(query, max_results=N, backend="auto")` to perform the search
7. Results are parsed from the `SEARCH_OK`/`SEARCH_DONE` delimited output
8. Results are cached in memory for the session duration (5-minute TTL)
9. A formatted result string is returned showing ranked results with titles as markdown links and snippets

## Install

```bash
pip install ddgs
```

Then ensure `python3` is available on the system PATH. No virtual environment required — the tool uses the system `python3` directly.

## Usage

The LLM uses `web_search` automatically when researching topics. Example invocations:

```
web_search(query="latest rust web framework 2026", maxResults=5)
web_search(query="typescript best practices error handling")
web_search(query="python async patterns")
```

The tool is designed to work alongside `web_crawl` — use `web_search` to discover relevant URLs, then `web_crawl` to fetch full page content.

## Requirements

- Python 3.x
- `ddgs` Python package (`pip install ddgs`)
- Pi Coding Agent

## License

MIT
