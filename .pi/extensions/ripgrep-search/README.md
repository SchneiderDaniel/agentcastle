# @agentcastle/ripgrep-search

**Fast code search tool for Pi — literal text and regex, natively respects `.gitignore`.** Returns structured human-readable summaries with top-N results, file counts, and truncation info.

## Features

- **`ripgrep_search` tool** — Search codebase by literal text or regex pattern
  - Default 10 matches per file, configurable via `max_count`
  - Structured summary output showing top-N results with file counts and truncation indicator
  - Respects `.gitignore` natively when ripgrep is available
  - Falls back to `grep` if ripgrep not installed
  - Auto-rejects structural patterns — redirects to `structural_search`
- **Result cache** — Same query+directory returns cached result without re-running the CLI
- **Configurable backend** — Set `searchBackend` to `"auto"` (default), `"ripgrep"`, or `"grep"` in `.pi/settings.json`
- **Backend indicator** — Injects current search backend into system prompt so LLM knows which tool is active
- **Temp file handling** — Large outputs saved to temp files, cleaned up at session shutdown
- **TUI rendering** — Compact inline result display with match counts and truncation status

## How it works

1. The LLM calls `ripgrep_search` with a query and optional directory/max_count
2. The extension validates the query (rejects structural patterns), resolves the directory, and selects the backend (ripgrep or grep)
3. **Cache check** — If the same query+directory was already searched, the cached result is returned without re-running the CLI
4. The backend runs — ripgrep with `--vimgrep` for structured output, or grep with `-rnH` as fallback
5. Results are parsed and cached in memory for the session duration
6. A human-readable summary is returned showing top-N results (tunable via `max_count`), unique file count, and truncation status
7. Large outputs are saved to temp files with a path reference in the response; temp files and cache are cleaned up at session shutdown

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

## ripgrep Availability Detection
The extension detects `rg` at startup in three stages:

1. **PATH scan** — walks `process.env.PATH` with `accessSync` (zero-overhead, no subprocess)
2. **Pi bin dir fallback** — checks `~/.pi/agent/bin/rg` (pi's own managed tools directory)
3. **Spawn fallback** — runs `rg --version` via subprocess (last resort)

If none succeed, the extension falls back to system `grep`.

### Common Fix: Symlink into `~/.local/bin`
If `~/.pi/agent/bin` is not on PATH (e.g. WSL interop environment mismatch):

```bash
ln -sf ~/.pi/agent/bin/rg ~/.local/bin/rg
```

`~/.local/bin` is typically on PATH and persists across sessions.

## License

MIT
