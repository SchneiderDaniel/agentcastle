# @agentcastle/structural-analyzer

**Find code patterns, not text matches.** Uses ast-grep with Tree-sitter AST parsing to search for semantic constructs — function calls, class definitions, try/catch blocks, method invocations — without noise from comments or strings.

## Features

- **`structural_search` tool** — AST-aware code pattern search
  - S-expression and code-snippet pattern syntax
  - `$META_VAR` for single AST node matching (e.g., `console.log($A)`)
  - `$$$MULTI` for zero-or-more AST nodes (e.g., `try { $$$BODY } catch (e) { $A }`)
  - Structured JSON output: `{ matches, results: [{ file, lines, snippet }] }`
- **Pattern validation** — Rejects single-word text patterns that belong on ripgrep (collision rule)
- **Snippet truncation** — Results capped at 120 characters per match
- **Prompt integration** — Injects `promptSnippet` and `promptGuidelines` so LLM knows when to use structural vs text search
- **Binary auto-detection** — Detects `ast-grep` vs `sg` binary name

## How it works

1. The LLM calls `structural_search` with a pattern and language
2. The extension validates the pattern — rejects text-only patterns (redirects to `ripgrep_search`)
3. Runs `ast-grep scan --pattern <pattern> --json=stream --lang <language>`
4. Parses NDJSON output into structured `SgMatch[]` results
5. Returns results with file paths, line ranges, and truncated snippets

## Install

```bash
pi install npm:@agentcastle/structural-analyzer
```

Then run `/reload` or restart pi.

## Usage

The LLM uses `structural_search` automatically. Example invocations:

```
structural_search(pattern="console.log($A)", language="ts")
structural_search(pattern="try { $$$BODY } catch (e) { $A }", language="js")
structural_search(pattern="function($A, $B)", language="go")
structural_search(pattern="class $A extends $B", language="py")
```

### Requirements

- Pi Coding Agent
- `ast-grep` installed globally: `npm i -g @ast-grep/cli`
- No npm dependencies — all peer deps are pi-provided

### Error handling

`structural_search` uses exit-code-based error detection. ast-grep conventions:

- **Exit code 0** — Success. Results parsed from JSONL output.
- **Exit code 1, empty stderr** — No matches found (legitimate, returns `matches: 0`).
- **Exit code 1, non-empty stderr** — ast-grep error (returns `isError: true` with the stderr message).
- **Exit code ≥ 2** — Process error (permission denied, segfault, OOM kill, etc.). Always returns `isError: true`.

This replaces the old keyword-heuristic approach that only caught stderr messages containing "unknown", "error", or "not found".

### When to use structural_search vs ripgrep_search

| Use case                                       | Tool                |
| ---------------------------------------------- | ------------------- |
| "Where is verify_token called with what args?" | `structural_search` |
| "Find all TODO comments"                       | `ripgrep_search`    |
| "Show me every try/catch block"                | `structural_search` |
| "Search for error message 'timeout exceeded'"  | `ripgrep_search`    |

## License

MIT
