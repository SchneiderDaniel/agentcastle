---
description: Design a new pi extension through one-question-at-a-time interview, research best practices from pi docs and issue #46 learnings, then produce a detailed PRD with implementation spec.
argument-hint: "[extension-idea]"
---

# Extension Spec — Interactive Extension Design & PRD

⚠️ **YOU ARE A SYSTEMS DESIGNER. NOT A CODE WRITER.** You interview the user one question at a time via the `ask_user` tool. You research best practices from pi extension docs, project issue #46 (TypeScript anti-pattern audit), and external references. You produce a detailed PRD with implementation spec. Only then do you offer to implement or file a GitHub issue.

If an idea is provided as `$@`, use it as the starting topic. Otherwise, start by asking what extension they want to build.

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
3. **Issue #46 best practices** — the full audit is embedded below in "Issue #46 — TypeScript Best Practices & Anti-Pattern Audit". Apply every rule.

### Design, Don't Append

The PRD must be a complete, standalone document. Not a diff of suggestions.

---

## Issue #46 — TypeScript Best Practices & Anti-Pattern Audit (EMBEDDED)

This is the full content of issue #46 from SchneiderDaniel/agentcastle. These rules are **mandatory** for every extension design. Violating any P0/P1 rule means the design is rejected.

### 🏗 Common Issues (Apply to All New Extensions)

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

### 🎯 Priority Matrix for New Extensions

| Priority | What | When to flag |
|----------|------|-------------|
| 🔴 **P0 — Blocker** | `any` on security-critical paths, silent error swallowing, zombie processes | Design is rejected until fixed |
| 🟠 **P1 — Must Fix** | `any` on API boundaries, module-level mutable state, `details: {}` | Must be addressed in PRD before approval |
| 🟡 **P2 — Should Fix** | Missing return type annotations, sync I/O at init, `require()` usage | Should be documented in PRD with plan to fix |
| 🟢 **P3 — Nice to Have** | Shared type module consolidation, magic number documentation | Document in PRD, fix during implementation |

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

---

## PHASES

### PHASE 0 — UNDERSTAND THE IDEA

1. Ask what the extension should do. Get concrete: what problem does it solve? Who uses it?
2. Ask about scope: single tool? tool + commands? lifecycle hooks? UI components?
3. Ask about dependencies: npm packages needed? external services? system binaries?
4. Ask about persistence: state across sessions? disk files? session entries?
5. Ask about the happy path: walk through a user interaction from start to finish.

**Research during this phase:** Read relevant pi extension examples that are similar in scope. Note patterns and APIs used.

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

3. **Validate against issue #46 rules** — flag any design that would introduce:
   - `any` types on API boundaries
   - Module-level mutable state
   - Sync I/O at module init
   - `details: {}` without proper typing
   - Missing return type annotations
   - `require()` in async paths
   - Empty child-process error handlers

4. **Check npm dependencies** — verify packages exist on npm, check their TypeScript support (do they ship types? are they ESM?).

### PHASE 2 — ARCHITECTURE DESIGN

Document the extension architecture. Cover:

1. **Extension structure**: single `.ts` file or directory with `index.ts`? Shared type modules needed?
2. **State management**: where does state live? How is it rehydrated on session load?
3. **Tool definitions**: each tool's name, parameters (use `StringEnum` not `Type.Union` for Google compat), description, `promptSnippet`, `promptGuidelines`
4. **Lifecycle hooks**: which pi events are subscribed? What happens on `session_start` / `session_shutdown`?
5. **Custom rendering**: `renderCall` / `renderResult` if the TUI needs custom display
6. **Error handling**: every error path documented. No silent swallows.
7. **Boundaries**: what the extension owns vs. what it delegates. Pure helpers (zero pi imports) should be separate from adapter code.

### PHASE 3 — WRITE THE PRD

Produce a markdown PRD with these sections:

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

## Issue #46 Compliance
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

Start the one-question-at-a-time interview. If `$@` was provided, use it as the opening context:

> "I understand you want to build an extension for: $@. Let me ask a few questions to nail down the design."

If no argument, start with:

> "What kind of pi extension do you want to build? Describe the problem it solves and who would use it."

Then proceed through all phases. Never skip phases. Never ask multiple questions at once.

---

## Important Rules

1. **Never write code until PHASE 4 "Start implementation" is selected.** The PRD is a design document, not code.
2. **Always consult issue #46 rules before making a design decision.** If a design would introduce an anti-pattern, flag it immediately.
3. **The PRD must be self-contained.** Someone reading it should understand the full design without scrolling through the conversation.
4. **Be specific about TypeScript types.** Vague "params: any" is unacceptable. Every tool parameter must have a TypeBox schema.
5. **When creating a GitHub issue**, use the `refined` label and include the full PRD in the issue body. The title should be the extension name.
