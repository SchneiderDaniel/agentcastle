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

## Tool Choice Rules

Concrete rules for picking the right tool every time.

| Task | Correct Tool | Wrong Tool |
|------|-------------|------------|
| Search literal text | `ripgrep_search` | `bash \| grep`, `bash \| rg`, `bash \| find` |
| Find function/class/struct defs | `map_codebase` | `bash \| grep`, `ripgrep_search` |
| Find AST patterns (try/catch, method calls) | `structural_search` | `ripgrep_search`, `bash \| grep` |
| Read file contents | `read` (with offset/limit for large files) | `bash cat`, `bash head`, `bash tail` |
| List directory | `bash ls` (only acceptable use of ls) | none |
| Write new file | `write` | `bash cat >`, `bash echo >` |
| Edit existing file | `edit` (precise text replacement) | `bash sed`, `write` (full overwrite) |
| Execute command | `bash` | none — bash is correct here |

### Golden Rules

1. **First tool choice sets trajectory.** Picking `bash | grep` for search often cascades into more bash calls. Pick the right tool from turn 1.
2. **Batch same-tool calls.** 3+ consecutive `bash`, `read`, or `write` calls = opportunity to batch. Combine bash with `&&`, read a larger chunk, or write fewer larger files.
3. **Error means rethink.** If a tool errors, do NOT retry same tool+args. Change approach — different args, different tool, or ask user.
4. **Prefer dedicated tools.** Pi has purpose-built tools. Using `bash` for something another tool does = inefficient.

## Session Advice

After each session, check if `.pi/sessions/<session>.advice.md` exists.

- The advice file is generated automatically on session shutdown.
- It contains patterns detected in that session — tool misuse, cascading calls, loops, errors not actioned.
- **Read it before starting a new task.** It may contain rules to follow this session.
- Score: 0.00 (clean) to 1.00 (needs significant improvement).
- Clean sessions produce `*No issues detected.*` (empty advice).

To batch-analyze all past sessions:
```bash
npx tsx scripts/session-advice.ts        # all sessions
npx tsx scripts/session-advice.ts --latest  # latest only
```

Extension: `session-advice` (toggle with `/session-advice`).

## Session File Structure

Every session produces up to 4 files in `.pi/sessions/`:

| File | Content |
|------|---------|
| `.jsonl` | Full structured log (JSON lines) — source of truth |
| `.md` | Human-readable session report (rendered by `session-logger`) |
| `.metadata.json` | Token/cost/tool-stats summary |
| `.advice.md` | Improvement advice for the agent (rendered by `session-advice`) |

Symlinks `latest.*` point to most recently closed session.

## 🛠 Tool Discipline

Mandatory pre-call checklist for every tool invocation:

1. **Identify task type** — search, read, write, edit, execute?
2. **Pick correct tool** from Tool Choice Rules table above
3. **If tool errors**, do NOT retry same tool+args. Change approach: different args, different tool, or ask user.
4. **Batch same-tool calls**: if 3+ consecutive same tool, merge into one (combine bash with `&&`, read larger chunk)
5. **Read once, use offset to page**: do not re-read same file within 3 turns
6. **Prefer structural_search** for code structure queries (function defs, classes, try/catch) over `bash | grep`

### DO / DON'T

| Task | DO | DON'T |
|------|----|-------|
| Find literal text | `ripgrep_search` | `bash \| grep`, `bash \| rg`, `bash \| find` |
| Find function/class defs | `map_codebase` | `bash \| grep`, `ripgrep_search` |
| Find AST patterns | `structural_search` | `ripgrep_search`, `bash \| grep` |
| Read file contents | `read(path, offset?, limit?)` | `bash cat`, `bash head`, `bash tail` |
| Write new file | `write` | `bash cat >`, `bash echo >` |
| Edit existing file | `edit` (precise text replacement) | `bash sed`, `write` (full overwrite) |
| Execute command | `bash` | none — bash is correct here |
| List directory | `bash ls` | none — ls is acceptable |

### Error Recovery

```
Tool error → STOP retrying same call → change args, tool, or ask user
```

If same tool errors twice in a row, force strategy switch. Do not retry more than once with same args.

### Batching Triggers

- 3+ consecutive `bash` → combine with `&&` or use script file
- 3+ consecutive `read` → read larger portion with higher limit or use `offset` to page
- 3+ consecutive `write` or `edit` → batch into one larger write

## Package Safety

### npm Package Age Check
Before installing any npm package from the public registry, run:
`npm view <pkg> time.created`
If first-publish date is less than 14 days old, block install with:
"Package <name> is <X> days old — below 14-day safety threshold. Cannot install."
If the command fails or field is missing, block (fail closed).
This does NOT apply to git URLs, tarballs, or local paths.
No override mechanism exists. The block is absolute.
