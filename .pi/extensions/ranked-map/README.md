# @agentcastle/ranked-map

**Smart codebase navigation for LLMs.** Automatically selects full-dump (small repos) or ranked mode (keyword + recency scoring) to deliver the most relevant files within a token budget.

## Features

- **`ranked_map` tool** — Codebase symbol index with auto-mode detection
  - Full-dump mode for repos ≤ autoThreshold (default 20K symbols) — all symbols sorted by path
  - Ranked mode for larger repos — scoring by keyword overlap + git recency
  - Query-free fallback to recency-only ranking
- **Configurable token budget** — Default 2048 tokens, adjustable per call
- **Caching** — Symbol index cached to `.pi/cache/ranked-map-index.json` keyed by git HEAD
- **Prompt integration** — Injects mode-aware `promptSnippet` and `promptGuidelines` so the LLM knows how to use the tool
- **No external dependencies** — Uses `ctags` for indexing, `ripgrep` for keyword search, `git` for recency

## Architecture

The extension is orchestrated by a **`RankedMapEngine`** class (`engine.ts`) that separates the pipeline into independently testable phases:

- **`buildOrLoadIndex()`** — Look up git HEAD, try cache, fall back to ctags + parsing
- **`rank()`** — Select mode (full-dump vs ranked), compute keyword + recency scores, combine and truncate by token budget
- **`addPreviews()`** — Read first 5 lines per file for ranked mode previews
- **`format()`** — Shape results into the final `RankedMapResult` output

Each phase accepts `ExecFn` + config via constructor, making all methods testable in isolation without running the full tool.

## How it works

1. On first call, the extension builds a symbol index via `ctags --output-format=json -R` over the target directory
2. The index is cached to disk keyed by current git HEAD
3. When called, the extension selects mode:
   - **Full dump** — repo small enough, returns all files sorted by path up to token budget
   - **Ranked** — runs `rg --files-with-matches` for keyword scoring, `git log --name-only` for recency scoring, then combines scores with configurable weights
4. Results are formatted as JSON with file paths, symbols, token counts, and (in ranked mode) file previews

## Install

```bash
pi install npm:@agentcastle/ranked-map
```

Then run `/reload` or restart pi.

## Usage

The LLM uses `ranked_map` automatically. Example invocations:

```
ranked_map()
ranked_map(query="login auth token")
ranked_map(query="error handler", directory="src", tokenBudget=1024)
```

### Configuration (optional)

In `.pi/settings.json`:

```json
{
	"rankedMap": {
		"tokenBudget": 2048,
		"autoThreshold": 20000,
		"recencyWindowDays": 90,
		"weights": {
			"keyword": 0.6,
			"recency": 0.3,
			"fileSize": 0.1
		}
	}
}
```

- `tokenBudget` — Max tokens per response (default 2048)
- `autoThreshold` — Symbol count threshold for auto-mode (default 20000). Set to 0 for always-ranked
- `recencyWindowDays` — How many days back to track git activity (default 90)
- `weights` — Scoring weights: keyword relevance, git recency, file size penalty

## Requirements

- Pi Coding Agent
- `universal-ctags` installed on PATH (with JSON output support)
- `ripgrep` (rg) for keyword search
- `git` for recency scoring and cache keying
- No npm dependencies — all peer deps are pi-provided

## License

MIT
