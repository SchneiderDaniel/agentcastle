# @agentcastle/ranked-map

**Smart codebase navigation for LLMs.** Automatically selects full-dump (small repos) or ranked mode (keyword + recency scoring) to deliver the most relevant files within a token budget.

## Features

- **`ranked_map` tool** — Codebase symbol index with auto-mode detection
  - Full-dump mode for repos ≤ autoThreshold (default 20K symbols) — all symbols sorted by path
  - Ranked mode for larger repos — scoring by keyword overlap + git recency
  - Query-free fallback to recency-only ranking
  - Structural overview in recency-only mode — one file per top-level directory ensures broad repo awareness
- **Configurable token budget** — Default 4096 tokens, adjustable per call
- **Caching** — Symbol index cached to `.pi/cache/ranked-map-index.json` keyed by git HEAD, config hash, and target directory (config changes or different directory scope invalidate the cache)
- **Test-file penalty** — Test files (`.test.`, `.spec.`, `/test/`) receive 0.5x score penalty to favor source files
- **.piignore integration** — Patterns from `.piignore` are automatically added as ctags excludes
- **Improved previews** — Shows ctag definition lines (from pattern field) instead of first 5 comment/import lines
- **Smart ctags excludes** — Q&A data files (`*.jsonl`), docs (`*.md`), and pi agent internals are excluded from indexing; submodules are scanned like any other directory
- **.mts file support** — ESM TypeScript (`.mts`) files are mapped to the TypeScript parser via `--map-TypeScript=+.mts`, so their symbols appear in the index
- **Prompt integration** — Injects mode-aware `promptSnippet` and `promptGuidelines` so the LLM knows how to use the tool
- **No external dependencies** — Uses `ctags` for indexing, `ripgrep` for keyword search, `git` for recency

## Architecture

The extension is orchestrated by a **`RankedMapEngine`** class (`engine.ts`) that separates the pipeline into independently testable phases:

- **`buildOrLoadIndex()`** — Look up git HEAD, try cache, fall back to ctags + parsing. Integrates `.piignore` patterns as additional ctags excludes
- **`rank()`** — Select mode (full-dump vs ranked), compute keyword + recency scores, apply test-file penalty, combine and truncate by token budget
- **`addPreviews()`** — Show ctag pattern-based previews (definition lines) when available, fall back to reading first 5 file lines
- **`format()`** — Shape results into the final `RankedMapResult` output. Includes `getStructuralOverview()` for recency-only mode

Each phase accepts `ExecFn` + config via constructor, making all methods testable in isolation without running the full tool.

## How it works

1. On first call, the extension builds a symbol index via `ctags --output-format=json -R` over the target directory
   - Automatically excludes: `node_modules`, `.git`, `*.json`, `*.jsonl`, `*.md`, `*.min.js`, `*.css`, `static`, `context`, `sessions`, `npm`, `chromium-deps`, `crawl4ai-venv`, `web-search-venv`, `benchmarks`
     - Basename-only patterns — `ctags --exclude` matches against the basename of each file/directory, so path prefixes like `.pi/` are omitted
   - Also reads `.piignore` for additional exclusion patterns
2. The index is cached to disk keyed by current git HEAD, config hash, and target directory scope
3. When called, the extension selects mode:
   - **Full dump** — repo small enough, returns all files sorted by path up to token budget
   - **Ranked** — runs `rg --files-with-matches` for keyword scoring, `git log --name-only` for recency scoring, then combines scores with configurable weights. Test files receive a 0.5x score penalty. In recency-only mode (no query), a structural overview injects one representative file per top-level directory
4. Results are formatted as JSON with file paths, symbols, token counts, and (in ranked mode) file previews showing definition lines

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
		"tokenBudget": 4096,
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

- `tokenBudget` — Max tokens per response (default 4096)
- `autoThreshold` — Symbol count threshold for auto-mode (default 20000). Set to 0 for always-ranked
- `recencyWindowDays` — How many days back to track git activity (default 90)
- `weights` — Scoring weights: keyword relevance, git recency, file size penalty

### .piignore integration

The extension automatically reads `.piignore` from the project root and converts its patterns to ctags `--exclude` arguments. Supported patterns:

- Directory patterns (`dist/` → `--exclude=dist`)
- Glob patterns (`*.log` → `--exclude=*.log`)
- Path patterns (`.pi/cache` → `--exclude=cache` via basename extraction)

Comments and negations are skipped. Patterns with double-star (`**`) or leading slash (`/`) are skipped.

## Requirements

- Pi Coding Agent
- `universal-ctags` installed on PATH (with JSON output support)
- `ripgrep` (rg) for keyword search
- `git` for recency scoring and cache keying
- No npm dependencies — all peer deps are pi-provided

## License

MIT
