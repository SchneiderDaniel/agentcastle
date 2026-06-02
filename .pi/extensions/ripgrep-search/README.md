# @agentcastle/ripgrep-search

**Fast code search tool for Pi — literal text and regex, natively respects `.gitignore`.** Replaces grep-based approaches with structured file:line:column:text output that the LLM can parse and act on.

## Features

- **`ripgrep_search` tool** — Search codebase by literal text or regex pattern
  - Default 10 matches per file, configurable via `max_count`
  - Structured JSON output (`file`, `line`, `column`, `text` per match)
  - Respects `.gitignore` natively when ripgrep is available
  - Falls back to `grep` if ripgrep not installed
  - Auto-rejects structural patterns (`class `, `function `, `def `) — redirects to `structural_search`/`ranked_map`
- **Configurable backend** — Set `searchBackend` to `"auto"` (default), `"ripgrep"`, or `"grep"` in `.pi/settings.json`
- **Backend indicator** — Injects current search backend into system prompt so LLM knows which tool is active
- **Temp file handling** — Large outputs saved to temp files, cleaned up at session shutdown
- **TUI rendering** — Compact inline result display with match counts and truncation status

## How it works

1. The LLM calls `ripgrep_search` with a query and optional directory/max_count
2. The extension validates the query (rejects structural patterns), resolves the directory, and selects the backend (ripgrep or grep)
3. The backend runs — ripgrep with `--vimgrep` for structured output, or grep with `-rnH` as fallback
4. Results are parsed into structured `RgMatch[]` objects and returned with `total_returned`, `results`, and truncation info
5. Large outputs are saved to temp files with a path reference in the response

## Install

```bash
pi install npm:@agentcastle/ripgrep-search
```

Then run `/reload` or restart pi.

## Usage

The LLM uses `ripgrep_search` automatically. Example invocations the LLM might make:

```
ripgrep_search(query="TODO", directory="src")
ripgrep_search(query="console\\.log", directory=".", max_count=20)
ripgrep_search(query="magic.number.42", directory=".")
```

### Configuration (optional)

In `.pi/settings.json`:

```json
{
	"ripgrepSearch": {
		"searchBackend": "auto",
		"maxLineLength": 200
	}
}
```

- `searchBackend`: `"auto"` (try ripgrep, fallback to grep), `"ripgrep"` (require), or `"grep"` (skip detection)
- `maxLineLength`: Cap line length in results (default 200)

## Requirements

- Pi Coding Agent
- ripgrep recommended (`rg` — install via `apt`, `brew`, or `choco`)
- Falls back to system `grep` if ripgrep unavailable

## License

MIT
