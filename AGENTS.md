# Agent Castle: The Pi Stack

This is a Pi framwork based coding agent that is used on multiple git submodules.

## Rules
- For read and edit in the .pi folder, please consult always the pi framework documention https://pi.dev/docs/latest and Update @README.me
- If you need to same temporary files, please save them to the `ignore/` folder in this project. But make sure to delete them after use.
- When creating GitHub issues, always use the repo defined in .pi/settings.json (supervisor.repo field). Never use git remote origin.

## Search Tools

### ripgrep_search (preferred)
Dedicated tool for literal text and regex searches across the codebase. Respects `.gitignore`. Outputs structured JSON with file, line, column, text.

- **Backend**: Uses ripgrep when available, falls back to `grep -rnH` automatically
- **Fallback limits**: grep fallback lacks column output (defaults to 1) and `.gitignore` awareness. Only `.git/` is excluded.
- **When to use**: Finding magic numbers, hardcoded strings, error messages, TODOs, config values, any exact text match
- **Limit**: Default `max_count` is 10 per file. Increase for targeted searches with few expected results.

### structural_search (AST-aware)
Use for code structure patterns — function definitions, class declarations, method calls, try/catch blocks. Does NOT search comments or strings.

- **When NOT to use**: Pure text searches. Use ripgrep_search instead.

### map_codebase (ctags symbol lookup)
Use to discover what files and symbols exist. Returns function/class/variable definitions with line numbers.

- **When to use**: Find function definitions, class declarations, understand file structure

### bash (fallback only for search)
Do NOT use bash+grep manually. The ripgrep_search tool handles this with proper output parsing and error handling.
