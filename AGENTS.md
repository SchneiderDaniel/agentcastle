# Agent Castle: The Pi Stack

Pi coding agent for multiple git submodules.
Core philosophies: 
- Tool output is evidence. LLM opinion is speculation.
- Prefer deterministic code before putting is to LLM, if possible.


## Rules
- Read/edit `.pi` folder: consult https://pi.dev/docs/latest, update @README.me
- Temp files: save to `ignore/` folder, delete after use
- GitHub issues: use repo from `.pi/settings.json` (supervisor.repo), never git remote
- TypeScript: root `tsconfig.json` extends `.pi/tsconfig.json`. Run `npm run tsc:extensions` or `tsc --noEmit` for type checks.

## Tool Reference

**Search** — literal text, error messages, TODOs
- Correct: `ripgrep_search`
- Wrong: `bash | grep`, `bash | rg`, `bash | find`

**Search** — function/class/struct defs
- Correct: `ranked_map` (omit query for full dump on small repos)
- Wrong: `bash | grep`, `ripgrep_search`

**Search** — AST patterns (try/catch, method calls)
- Correct: `structural_search`
- Wrong: `ripgrep_search`, `bash | grep`

**Read** file contents
- Correct: `read(path, offset?, limit?)`
- Wrong: `bash cat`, `bash head`, `bash tail`

**Write** new file
- Correct: `write`
- Wrong: `bash cat >`, `bash echo >`

**Edit** existing file
- Correct: `edit` (precise text replacement)
- Wrong: `bash sed`, `write` (full overwrite)

**Execute** command
- Correct: `bash`

**List** directory
- Correct: `bash ls`


## Discipline

1. **Pick right tool first time.** Wrong first choice cascades.
2. **Batch same-tool calls.** 3+ consecutive `bash` → combine with `&&`. 3+ `read` → larger chunk or offset. 3+ `write`/`edit` → batch.
3. **Read once, page with offset.** Don't re-read same file within 3 turns.
4. **Error = change approach.** Stop → change args, tool, or ask user. Don't retry same tool+args twice.
5. Never commit to main

```
Tool error → stop → change args, tool, or ask user
```

## Package Safety

Before npm install from public registry: `npm view <pkg> time.created`
- < 14 days old → block: "Package <name> is <X> days old — below 14-day safety threshold. Cannot install."
- Command fails or field missing → block (fail closed)
- Not applied: git URLs, tarballs, local paths. No override.
