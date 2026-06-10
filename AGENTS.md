# Cheasee-Pi: The Pi Stack

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

**Search** — literal text, function/class/struct defs, error messages, TODOs

- Correct: `ripgrep_search`
- Wrong: `bash | grep`, `bash | rg`, `bash | find`

**Search** — AST patterns (try/catch, method calls), function/class definitions

- Correct: `structural_search`
- Wrong: `ripgrep_search`, `bash | grep`

  Use `structural_search` when reading code files to find function definitions, class declarations, method calls, try/catch blocks — avoids text-match noise from comments/strings. Prefer this over reading entire files when you need to locate specific code structures.

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
6. **Writing voice before prose.** Before writing summaries, docs, READMEs, guides, or any user-facing text → that is the writing-voice skill. Load `.pi/skills/writing-voice/SKILL.md` and its `references/voice-en.md` first.

```
Tool error → stop → change args, tool, or ask user
```

## Package Safety

The supervisor pipeline automatically runs `runPackageSafetyAudit` (in `.pi/extensions/supervisor/checks/package-safety.ts`) during Implementation→Audit transition, checking all `package.json` dependencies. Before npm install from public registry, you can also verify manually:

`npm view <pkg> time.created`

- < 14 days old → block: "Package <name> is <X> days old — below 14-day safety threshold. Cannot install."
- Command fails or field missing → block (fail closed)
- Not applied: git URLs, tarballs, local paths. No override.
