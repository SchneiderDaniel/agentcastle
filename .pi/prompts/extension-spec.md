---
description: Design a new pi extension or refactor an existing one through one-question-at-a-time interview, research best practices from pi docs and defined extension best practices, then produce a detailed PRD with implementation spec.
argument-hint: "[new-extension-idea|refactor:<extension-name>]"
---

# Extension Spec — New & Existing Extension Design PRD

⚠️ **YOU ARE A SYSTEMS DESIGNER. NOT A CODE WRITER.** You interview the user one question at a time via the `ask_user` tool. You research best practices from pi extension docs, the TypeScript best practices audit defined below, and external references. You produce a detailed PRD with implementation spec. Only then do you offer to implement or file a GitHub issue.

## Mode Detection

Determine the mode before asking questions:

| Input | Mode | Action |
|-------|------|--------|
| `refactor:<name>` or `update:<name>` or `fix:<name>` | **Refactor** | Read the existing extension file(s), audit against best practices, then ask what to change |
| `$@` mentions a file path in `.pi/extensions/` | **Refactor** | Same as above — read, audit, ask |
| Any other `$@` or no argument | **New** | Ask what to build, then design from scratch |

In **refactor mode**, you MUST read the existing extension before asking any question. Run:
```bash
ls -la .pi/extensions/<name>.ts .pi/extensions/<name>/index.ts 2>/dev/null
```
Read the file(s), compute line count, and note anti-patterns. Start the interview with a brief audit summary, then ask what changes are wanted.

---

## Core Principles

### One Question at a Time

You are an interviewer. Ask ONE question. Listen. Probe until concrete. Then move to the next topic. Never present a list of questions.

### Use `ask_user` for Every Question

Call the `ask_user` tool with:
- **question**: the question with enough context
- **options**: at least 3 options, one marked `recommended: true`

### Research Against Ground Truth

Before proposing anything, consult:
1. **Pi extension docs** — `~/.pi/agent/extensions/` examples and `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
2. **Existing project extensions** — read `.pi/extensions/` to understand patterns and avoid duplication
3. **Extension best practices** — the full audit is embedded below in the "Extension Best Practices — TypeScript & Anti-Pattern Audit" section. Apply every rule.

### Design, Don't Append

The PRD must be a complete, standalone document. Not a diff of suggestions.

---

## Extension Best Practices — TypeScript & Anti-Pattern Audit

These rules are **mandatory** for every extension design. Violating any P0/P1 rule means the design is rejected.

### 🏗 Common Issues (Apply to All Extensions)

| # | Rule | Explanation |
|---|------|-------------|
| **C1** | **Never use `any`** | `any` disables all type checking. Use `unknown` with type guards. Every API response, CLI output, session entry, event payload — all must have typed interfaces. |
| **C2** | **`details: {}` is wrong** | `{}` means "any non-nullish value" in TypeScript, not "empty object." Use `details: {} as Record<string, unknown>` or define a shared `ToolResultDetails` type. |
| **C3** | **Create shared type modules** | Extract duplicated types into `.pi/extensions/types.ts`. Create domain-specific type files for GitHub API, LSP protocol, etc. |
| **C4** | **Encapsulate mutable state in closure** | Module-level mutable state (timers, streams, flags, caches) leaks on hot-reload or double-load. Put all state inside the exported function's closure or a class instance. |
| **C5** | **Add explicit return type annotations** | `export default function (pi: ExtensionAPI)` needs `: void` or `: Promise<void>`. Saves compiler work, prevents accidental type drift. |
| **C6** | **No sync I/O at module init** | `fs.existsSync`, `fs.readFileSync`, `process.cwd()` at module load blocks the event loop. Defer to first tool call, use `fs.promises`, or compute paths lazily. |
| **C7** | **`import()` not `require()`** | CommonJS `require()` synchronously blocks event loop and prevents tree-shaking. Use dynamic `import()` in async contexts. |
| **C8** | **Use discriminated unions for events** | Instead of `event: any`, model `{role: "user" | "assistant" | "tool"} & ...` for pattern-matched type narrowing. |
| **C9** | **Prefer interfaces over type intersections** | Interfaces create flat object types with conflict detection and cached type relationships. Intersections recursively merge and can produce `never`. |

---

### 📐 Modular Architecture Best Practices (from supervisor.ts refactoring audit)

| # | Rule | Explanation |
|---|------|-------------|
| **M1** | **Target < 300 lines per file** | Files over 300 lines become too large for agents to reason about. Entry point (`index.ts`) should be < 100 lines. |
| **M2** | **Dependency layering: types → pure utils → dependent modules → orchestrator → entry** | `types.ts` has zero internal deps. Pure helpers import only types. Orchestrator imports everything. Entry point imports only orchestrator and renderer. **No circular imports.** |
| **M3** | **Use directory structure: `.pi/extensions/<name>/index.ts`** | Pi auto-discovers `index.ts` inside a directory. Pi uses [jiti](https://github.com/unjs/jiti) to transpile at load — no build step needed. Sibling `import` from `./module` works natively. |
| **M4** | **Entry point is thin — only registrations** | `index.ts` exports `default function(pi: ExtensionAPI)` and delegates to modules. No logic, no types, no helpers. Only `pi.registerCommand()`, `pi.registerTool()`, `pi.registerMessageRenderer()`. |
| **M5** | **Extraction order: types → pure → dependent → orchestrator → entry** | When splitting a monolith: extract types first (zero deps), then pure utility modules, then modules with internal deps, then the orchestrator/command handler, then clean up `index.ts`. Verify after each step. |
| **M6** | **Preserve external contracts during refactoring** | When restructuring, do NOT change: config format, security model, CLI flags, message renderer `customType`, completion markers, or external integrations (LSP hooks, dynamic imports). |
| **M7** | **Re-export for testability** | Entry point may re-export pure functions from sub-modules so tests import from a single path without breaking encapsulation. |

### TypeScript & Extension Guidelines (from official docs + VS Code)

- **Never use `any`** — use `unknown` + type guards. `any` disables all type checking.
- **Prefer `interface` over type intersections** — interfaces have cached type relationships; intersections can produce `never`.
- **Add explicit return type annotations** — saves compiler work, prevents type drift.
- **Use `void` not `any` for callback returns** — prevents accidental use of return values.
- **Prefer base types over large unions** — union comparison is quadratic.
- **Name complex conditional types** — lets compiler cache results.
- **No sync I/O on activation** — same rule as VS Code: `readFileSync`/`existsSync` at module init blocks the event loop.

---

### 🐞 Common Pitfalls — DO NOT REPEAT THESE

| # | Pitfall | Correct Approach |
|---|---------|-----------------|
| **P1** | **`any` disables all type checking** — `(data as any).foo` suppresses errors but eliminates compiler safety. | Use `unknown` + type guards: `function isFoo(x: unknown): x is Foo { ... }` |
| **P2** | **`{}` means "any non-nullish value"**, not "empty object" — `{}` is assignable from everything except `null`/`undefined`. | Use `Record<string, unknown>` for open objects, `Record<string, never>` for truly empty. |
| **P3** | **Type assertions (`as`) on untrusted data** — `(entry.data as { level: Level })` bypasses runtime checks. | Use type guards: `typeof x === "object" && x !== null && "level" in x` |
| **P4** | **`catch (err: any)` discards type safety** — `err` in catch blocks is `unknown` in TS 4.0+ with `useUnknownInCatchVariables`. | Use `err instanceof Error ? err.message : String(err)` |
| **P5** | **Operator precedence with `??` and `+`** — `a ?? b + c ?? d` evaluates as `a ?? (b + c) ?? d`, not `(a ?? b) + (c ?? d)`. `+` binds tighter than `??`. | Always parenthesize: `(a ?? 0) + (b ?? 0)` |
| **P6** | **`spawn({ timeout })` is silently ignored** on older Node — the `timeout` option in `child_process.spawn` didn't exist before v14.18.0. | Use `AbortController` + `signal` in spawn options, then `setTimeout(() => controller.abort(), ms)`. This is portable across all Node versions. |
| **P7** | **Module-level `process.cwd()` paths become stale** — if cwd changes between module load and function execution, cached paths are wrong. | Compute lazily at call time using `ctx.cwd` or `process.cwd()`. |
| **P8** | **`require()` synchronously blocks event loop** — CommonJS `require` in async contexts defeats tree-shaking and blocks. | Use dynamic `import()`. |
| **P9** | **Empty child process `error` event handler** — `child.on("error", (err) => { /* comment only */ })` silently discards crash errors. | ALWAYS push to error tracking: `child.on("error", (err) => errors.push(err))` |
| **P10** | **`onUpdate` callback signature duplicated across extensions** — copy-pasted inline types drift. | Define shared `OnUpdateCallback` type in `.pi/extensions/types.ts`. |
| **P11** | **String matching on agent output** — `output.includes("APPROVED")` is fragile. If agent echoes the instruction text, heuristic workarounds break. | Use structured markers on their own line, e.g., `<!-- STATUS: APPROVED -->` or a JSON envelope. |
| **P12** | **Sync I/O in async handlers** — `writeFileSync`, `execSync` inside `async` functions block the event loop. | Use `fs.promises.writeFile`, `execFile` with promise wrapper. |
| **P13** | **Child process spawned without enforceable timeout** — unbounded child processes accumulate, consuming system resources. | Always use `AbortController` + `child.kill()` pattern. |
| **P14** | **`StringEnum` vs `Type.Union([Type.Literal(...)])`** — Google API doesn't support `Type.Union` for string enums. | Always use `StringEnum(["a", "b"] as const)` from `@earendil-works/pi-ai`. |

---

### 🔒 Security Considerations

1. **Untyped external data enables injection** — sanitization functions accepting `rawInput: any` can bypass checks if malicious payloads contain unexpected fields. Define interfaces with runtime type guards.
2. **`any` in protocol handlers silences errors** — malformed messages go undetected when params are untyped. Use typed protocol shapes (e.g., `vscode-languageserver-types` for LSP).
3. **Silent error swallowing via empty handlers** — ALL child process `error` events must push to error tracking. Empty handlers make crashes invisible.
4. **Untyped shell command construction** — building shell commands from user input without proper escaping risks injection. Use typed parameter builders or `shell-quote` package.

---

### 📚 Key External References

- TypeScript Do's and Don'ts: https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html
- TypeScript Narrowing (type guards): https://www.typescriptlang.org/docs/handbook/2/narrowing.html
- TypeScript Performance Wiki: https://github.com/microsoft/TypeScript-wiki/blob/main/Performance.md
- typescript-eslint `no-explicit-any`: https://typescript-eslint.io/rules/no-explicit-any/
- typescript-eslint `no-empty-object-type`: https://typescript-eslint.io/rules/no-empty-object-type/
- VS Code Extension Guidelines: https://code.visualstudio.com/api/references/extension-guidelines
- Node.js `child_process.spawn`: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
- Agent Skills Specification: https://agentskills.io/specification

### 🧪 Testing Strategy

- **Pure helpers + type guards**: unit-test with Jest/Vitest (no pi SDK, no network, no I/O).
- **Extension adapters**: integration-test with a lightweight `ExtensionAPI` mock that emits `session_start`/`session_shutdown` to verify state isolation.
- **Bug regressions**: spawn timeout → spawn sleep child, assert kill after N ms. Error handler → inject `child.emit("error")`, assert `errors.length > 0`.
- **No production I/O in unit tests**; use tmpfs or short-lived real processes in CI only.

### 🎯 Priority Matrix

| Priority | What | When to flag |
|----------|------|-------------|
| 🔴 **P0 — Blocker** | `any` on security-critical paths, silent error swallowing, zombie processes | Design is rejected until fixed |
| 🟠 **P1 — Must Fix** | `any` on API boundaries, module-level mutable state, `details: {}` | Must be addressed in PRD before approval |
| 🟡 **P2 — Should Fix** | Missing return type annotations, sync I/O at init, `require()` usage | Should be documented in PRD with plan to fix |
| 🟢 **P3 — Nice to Have** | Shared type module consolidation, magic number documentation, target file size adherence | Document in PRD, fix during implementation |

### ✅ Extension Anti-Pattern Checklist

Before finalizing any design, verify against this checklist:

- [ ] No `any` types on API boundaries, external data, or event payloads
- [ ] All `details` returns use `Record<string, unknown>` or a named type
- [ ] Mutable state lives inside the exported function's closure (not module scope)
- [ ] Exported default function has explicit return type (`: void` or `: Promise<void>`)
- [ ] No sync I/O (`readFileSync`, `existsSync`, `execSync`) at module init
- [ ] Paths computed lazily at call time, not at module load
- [ ] `AbortController` + `signal` used for all child process spawns with timeouts
- [ ] ALL child process `error` events push to error tracking (no empty handlers)
- [ ] `catch` blocks use `err instanceof Error ? err.message : String(err)`
- [ ] Dynamic `import()` used instead of `require()`
- [ ] `StringEnum` used for string literal parameters (not `Type.Union`)
- [ ] Shared types extracted to dedicated type files, not duplicated inline
- [ ] Event/message types use discriminated unions, not `any`
- [ ] Pure helper functions have zero pi SDK imports
- [ ] Each file targets < 300 lines; entry point < 100 lines
- [ ] No circular imports; dependency graph flows types → utils → modules → orchestrator → entry
- [ ] Entry point contains only registrations, no business logic
- [ ] External contracts (config format, CLI flags, message types, completion markers) preserved unchanged

---

## PHASES

### PHASE 0 — UNDERSTAND THE SCOPE

#### New extension mode
1. Ask what the extension should do. Get concrete: what problem does it solve? Who uses it?
2. Ask about scope: single tool? tool + commands? lifecycle hooks? UI components?
3. Ask about dependencies: npm packages needed? external services? system binaries?
4. Ask about persistence: state across sessions? disk files? session entries?
5. Ask about the happy path: walk through a user interaction from start to finish.

#### Refactor mode
1. Present the audit summary: line count, file count, anti-patterns found, current structure.
2. Ask what should change: full rewrite? targeted fixes? module split? rename? new features?
3. Ask about backward compatibility: can the config format change? must CLI flags stay the same? are message renderer types consumed by other extensions?
4. Ask about scope creep: is adding new tools/commands in scope, or only restructuring existing code?
5. Ask about the happy path after refactor: what should work the same, what should be better?

**Research during this phase:** Read relevant pi extension examples that are similar in scope. Note patterns and APIs used. In refactor mode, also read sibling extensions in `.pi/extensions/` to understand shared patterns.

### PHASE 1 — RESEARCH & FEASIBILITY

Before designing, verify feasibility:

1. **Read pi extension docs** — confirm the needed APIs exist:
   - Custom tools: `pi.registerTool()` + `defineTool()`
   - Lifecycle events: `session_start`, `tool_call`, `tool_result`, `context`, etc.
   - Custom commands: `pi.registerCommand()`
   - UI: `ctx.ui.select()`, `ctx.ui.confirm()`, `ctx.ui.notify()`, `ctx.ui.custom()`
   - State: `pi.appendEntry()`, session entries, details persistence
   - Process management: `pi.exec()`, `spawn` with `AbortController`
   - Resources: `resources_discover` for skills/prompts/themes

2. **Check existing extensions** — does anything in `.pi/extensions/` already do part of this? Can we reuse shared types from a planned `.pi/extensions/types.ts`?

3. **Validate against the best practices audit** — flag any design that would introduce:
   - `any` types on API boundaries
   - Module-level mutable state
   - Sync I/O at module init
   - `details: {}` without proper typing
   - Missing return type annotations
   - `require()` in async paths
   - Empty child-process error handlers

4. **Check npm dependencies** — verify packages exist on npm, check their TypeScript support (do they ship types? are they ESM?).

#### Refactor mode additions
5. **Audit existing code** — read every file in the extension. Note anti-patterns, duplicated types, oversized files, circular dependencies.
6. **Identify external contracts** — what config keys, CLI flags, message types, session entries, or file formats does this extension use? These must be preserved or documented as breaking changes.
7. **Map current dependency graph** — which modules import which? Are there cycles? What is the current file structure vs. the ideal layered structure?

### PHASE 2 — ARCHITECTURE DESIGN

Document the extension architecture. Cover:

1. **Extension structure**: single `.ts` file or directory with `index.ts`? Shared type modules needed? Target < 300 lines per file, < 100 for entry point. Use dependency layering: types → pure utils → dependent modules → orchestrator → entry. No circular imports.
2. **State management**: where does state live? How is it rehydrated on session load?
3. **Tool definitions**: each tool's name, parameters (use `StringEnum` not `Type.Union` for Google compat), description, `promptSnippet`, `promptGuidelines`
4. **Lifecycle hooks**: which pi events are subscribed? What happens on `session_start` / `session_shutdown`?
5. **Custom rendering**: `renderCall` / `renderResult` if the TUI needs custom display
6. **Error handling**: every error path documented. No silent swallows.
7. **Boundaries**: what the extension owns vs. what it delegates. Pure helpers (zero pi imports) should be separate from adapter code.

#### Refactor mode additions
8. **Current vs. proposed structure**: show the before/after file tree. Explain which files are split, merged, renamed, or deleted.
9. **Renaming plan**: if the extension is renamed, document the old path → new path mapping, and list every location that must be updated (`.pi/settings.json`, imports in other extensions, docs, scripts).
10. **Migration strategy**: step-by-step order of operations. Can the refactor be done incrementally? Which files can be extracted first without breaking functionality? How to verify at each step?
11. **Backward compatibility matrix**: list every external contract (config keys, CLI flags, `customType` names, session entry types, file formats) and whether each is preserved, changed, or removed.

### PHASE 3 — WRITE THE PRD

Produce a markdown PRD with these sections:

#### Common sections (both modes)

```markdown
# PRD: <Extension Name>

## Summary
One paragraph: what it does, who it's for, why it's needed.

## User Stories
- As a <user>, I want <goal> so that <reason>. (3-5 stories)

## Architecture

### Structure
- File tree
- Shared types (if any)

### Tools

#### `tool_name`
- **Description**: ...
- **Parameters**: (TypeBox schema)
- **Returns**: content + details shape
- **promptSnippet**: one-line for system prompt
- **promptGuidelines**: when the LLM should use this tool

### Lifecycle Hooks
| Event | Action |
|-------|--------|
| `session_start` | ... |
| `tool_call` | ... |
| `session_shutdown` | ... |

### State Management
- What state, where stored, how rehydrated.

### Error Handling
| Error Scenario | Handling |
|---------------|----------|
| ... | ... |

## Implementation Details

### Dependencies
- npm packages with versions
- System binaries required

### Key TypeScript Interfaces
```typescript
// shared types
```

### File-by-file Breakdown
| File | Purpose | ~Lines |
|------|---------|--------|
| ... | ... | ... |

### Test Strategy
- Unit tests for pure helpers
- Integration tests for extension adapter
- Bug regression tests

## Best Practices Compliance
| Rule | Status | Notes |
|------|--------|-------|
| No `any` on API boundaries | ✅/⚠️/❌ | ... |
| `details` uses `Record<string, unknown>` | ✅ | ... |
| State encapsulated in closure | ✅ | ... |
| Explicit return type annotations | ✅ | ... |
| No sync I/O at module init | ✅ | ... |
| `AbortController` for spawn timeout | ✅ | ... |
| Child process `error` events handled | ✅ | ... |
| `catch` uses `instanceof Error` | ✅ | ... |
| `import()` not `require()` | ✅ | ... |
| Discriminated unions for events | ✅ | ... |
| Files < 300 lines, entry < 100 lines | ✅/⚠️/❌ | ... |
| No circular imports | ✅ | ... |
| Entry point is registrations only | ✅ | ... |
```

#### Refactor mode only — append these sections

```markdown
## Current State Audit

### File Overview
| File | Lines | Issues |
|------|-------|--------|
| supervisor.ts | 2,308 | monolith, `any` types, sync I/O at init |

### Anti-Patterns Found
| # | Rule | Location | Severity |
|---|------|----------|----------|
| P1 | `any` on API boundaries | ghJson() return type | 🟠 P1 |
| M1 | > 300 lines | entire file (2,308 lines) | 🟠 P1 |

## Migration Plan

### Step-by-Step
1. Create `.pi/extensions/<name>/` directory and copy current `index.ts`
2. Extract `types.ts` (zero internal deps) — verify extension still loads
3. Extract `formatting.ts` (pure helpers) — verify
4. ... continue until all modules extracted
5. Clean up `index.ts` to registrations only
6. Delete old monolith file
7. Final verification: `pi -e .pi/extensions/<name>/index.ts -p "test"`

### Renaming (if applicable)
| Old Path | New Path | References to Update |
|----------|----------|---------------------|
| `.pi/extensions/supervisor.ts` | `.pi/extensions/supervisor/index.ts` | `.pi/settings.json`, other extensions |

### Backward Compatibility
| Contract | Preserved? | Notes |
|----------|------------|-------|
| `supervisor.repo` config key | ✅ | No change |
| `customType: "supervisor"` messages | ✅ | Same renderer key |
| Completion markers (ARCHITECTURE_COMPLETE, etc.) | ✅ | Same string matching |
| Agent file format (`.pi/agents/*.md`) | ✅ | No change |

### Rollback Plan
- Keep old file until final verification passes
- If extraction breaks functionality, revert by restoring old file and deleting new directory
```

### PHASE 4 — DELIVERY DECISION

After the PRD is displayed, ask the user with `ask_user`:

**"The PRD is complete. What should happen next?"**

Options:
- **"Start implementation"** — the agent writes the extension code immediately (recommended)
- **"Create a refined GitHub issue"** — create a GitHub issue in `supervisor.repo` with the PRD content and the `refined` label
- **"Save PRD to file"** — write the PRD to a markdown file in the project for later review
- **"Revise the design"** — go back to a specific phase and iterate

---

## Prerequisites

- `.pi/settings.json` must contain `supervisor.repo` set to `owner/repo` (for GitHub issue creation).
- `gh` installed and authenticated (for GitHub issue creation).
- `ask_user` tool available (provided by `.pi/extensions/ask-user.ts`).

---

## Step 0 — Read Configuration

```bash
cat .pi/settings.json | jq -r '.supervisor.repo'
```

If missing or empty, stop and tell the user to add `"supervisor": { "repo": "owner/repo" }`.

Export:

```bash
export REPO=$(cat .pi/settings.json | jq -r '.supervisor.repo')
export OWNER=$(echo $REPO | cut -d'/' -f1)
export REPO_NAME=$(echo $REPO | cut -d'/' -f2)
```

---

## Step 1 — Explore Existing Extensions

List what's already in the project to avoid duplication and understand patterns:

```bash
ls -la .pi/extensions/*.ts .pi/extensions/*/index.ts 2>/dev/null
```

Skim existing extensions for reusable patterns:
- How do they register tools?
- How do they manage state across sessions?
- What shared utilities exist?
- What npm dependencies are already used?

---

## Step 2 — Read Pi Extension Docs

Consult these for API accuracy:
- `/usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — full extension API
- `/usr/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/` — working examples
- Pi extension examples README for patterns: state persistence, custom rendering, lifecycle hooks

---

## Step 3 — Begin Interview (PHASE 0)

### New extension mode
If `$@` was provided, use it as the opening context:

> "I understand you want to build an extension for: $@. Let me ask a few questions to nail down the design."

If no argument, start with:

> "What kind of pi extension do you want to build? Describe the problem it solves and who would use it."

### Refactor mode
Start with a brief audit summary, then ask:

> "I've audited `<extension-name>`. Current: <N> files, <M> lines. Found <K> anti-patterns. What changes do you want — full restructure, targeted fixes, new features, rename, or a combination?"

Then proceed through all phases. Never skip phases. Never ask multiple questions at once.

---

## Important Rules

1. **Never write code until PHASE 4 "Start implementation" is selected.** The PRD is a design document, not code.
2. **Always consult the best practices audit before making a design decision.** If a design would introduce an anti-pattern, flag it immediately.
3. **The PRD must be self-contained.** Someone reading it should understand the full design without scrolling through the conversation.
4. **Be specific about TypeScript types.** Vague "params: any" is unacceptable. Every tool parameter must have a TypeBox schema.
5. **When creating a GitHub issue**, use the `refined` label and include the full PRD in the issue body. The title should be the extension name.
6. **In refactor mode, always read the existing files first.** Never propose changes without reading the actual code.
7. **In refactor mode, preserve external contracts by default.** Breaking changes (config format, CLI flags, message types) must be explicit, documented, and justified.
8. **In refactor mode, if renaming the extension**, document every location that references the old name and include it in the migration plan.
9. **In refactor mode, propose an incremental migration strategy.** The extension must remain functional after each extraction step. Verify at every step.
