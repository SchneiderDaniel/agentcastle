---
description: Design a new pi extension or refactor an existing one through automatic analysis, research best practices from pi docs and defined extension best practices, then produce a detailed PRD with implementation spec.
---

# Extension Spec — New & Existing Extension Design PRD

⚠️ **YOU ARE A SYSTEMS DESIGNER. NOT A CODE WRITER.** You research best practices from pi extension docs, the TypeScript best practices audit defined below, and external references. You analyze the request and produce a detailed PRD with implementation spec. Only then do you offer to implement or file a GitHub issue.

## Mode Detection

Determine the mode:

| Input                                                | Mode         | Action                                                                                                  |
| ---------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `refactor:<name>` or `update:<name>` or `fix:<name>` | **Refactor** | Read the existing extension file(s), audit against best practices, then produce PRD with migration plan |
| `$@` mentions a file path in `.pi/extensions/`       | **Refactor** | Same as above — read, audit, produce PRD                                                                |
| Any other `$@` or no argument                        | **New**      | Analyze the description, research, then design from scratch                                             |

In **refactor mode**, you MUST read the existing extension before designing. Run:

```bash
ls -la .pi/extensions/<name>.ts .pi/extensions/<name>/index.ts 2>/dev/null
```

Read the file(s), compute line count, and note anti-patterns. Produce a brief audit summary and proceed to PRD with migration plan.

---

## Core Principles

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

| #       | Rule                                                                         | Explanation                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------- |
| **C1**  | **Never use `any`**                                                          | `any` disables all type checking. Use `unknown` with type guards. Every API response, CLI output, session entry, event payload — all must have typed interfaces.                                                                                                                                                                                                                                                      |
| **C2**  | **`details: {}` is wrong**                                                   | `{}` means "any non-nullish value" in TypeScript, not "empty object." Use `details: {} as Record<string, unknown>` or define a shared `ToolResultDetails` type.                                                                                                                                                                                                                                                       |
| **C3**  | **Create shared type modules**                                               | Extract duplicated types into `.pi/extensions/types.ts`. Create domain-specific type files for GitHub API, LSP protocol, etc.                                                                                                                                                                                                                                                                                         |
| **C4**  | **Encapsulate mutable state in closure**                                     | Module-level mutable state (timers, streams, flags, caches) leaks on hot-reload or double-load. Put all state inside the exported function's closure or a class instance.                                                                                                                                                                                                                                             |
| **C5**  | **Add explicit return type annotations**                                     | `export default function (pi: ExtensionAPI)` needs `: void` or `: Promise<void>`. Saves compiler work, prevents accidental type drift.                                                                                                                                                                                                                                                                                |
| **C6**  | **No sync I/O at module init**                                               | `fs.existsSync`, `fs.readFileSync`, `process.cwd()` at module load blocks the event loop. Defer to first tool call, use `fs.promises`, or compute paths lazily.                                                                                                                                                                                                                                                       |
| **C7**  | **`import()` not `require()`**                                               | CommonJS `require()` synchronously blocks event loop and prevents tree-shaking. Use dynamic `import()` in async contexts.                                                                                                                                                                                                                                                                                             |
| **C8**  | **Use discriminated unions for events**                                      | Instead of `event: any`, model `{role: "user"                                                                                                                                                                                                                                                                                                                                                                         | "assistant" | "tool"} & ...` for pattern-matched type narrowing. |
| **C9**  | **Prefer interfaces over type intersections**                                | Interfaces create flat object types with conflict detection and cached type relationships. Intersections recursively merge and can produce `never`.                                                                                                                                                                                                                                                                   |
| **C10** | **Use `.ts` extension for all local imports**                                | With `moduleResolution: bundler` + `allowImportingTsExtensions: true` (already in `.pi/tsconfig.json`), the canonical import style is `from "./module.ts"`. This matches the source file extension, avoids ambiguity between `.ts`, `.js`, and no-extension imports, and ensures consistency across all extensions. Existing codebase: caveman/check-extensions/lsp-auditor/ask-user already use `.ts` (60+ imports). |
| **C11** | **Use `satisfies` for object literals matching an interface**                | TypeScript 4.9+ `satisfies` operator validates an expression matches a type without widening to that type. Preserves literal types for discriminated unions and narrows property types. Use when constructing an object that must conform to an interface but retain its literal types for downstream narrowing. Existing use: `supervisor/pipeline.ts:429`.                                                          |
| **C12** | **Dynamic `import()` returns module namespace — double-cast to target type** | `await import("pkg")` returns `typeof import("pkg")` (module namespace), not the default/interface type. Single `as T` cast fails. Pattern: `(await import("pkg")) as unknown as MyInterface`. Existing use: `lsp-auditor/lsp-client.ts:44`, `check-extensions/index.ts:162`, `caveman/command.ts:132`.                                                                                                               |
| **C13** | **Underscore prefix for unused callback parameters**                         | TypeScript `noUnusedParameters` (part of `strict`) flags unused function parameters. Use `_param` naming convention (`_event`, `_ctx`) to signal intentional omission. Do NOT use `// eslint-disable-next-line` or suppress compiler errors with `any`. Existing use: `session-logger/index.ts:109` (15+ instances across codebase).                                                                                  |
| **C14** | **Inline type annotation for destructured object parameters**                | `noImplicitAny` requires explicit parameter type annotations. Destructured object params need inline type: `renderResult(result, { expanded, isPartial }: { expanded?: boolean; isPartial?: boolean }, ...)`. Avoid separate interface when the type is only used once and is small. Existing use: `ripgrep-search.ts:710-713`.                                                                                       |

---

### 📐 Modular Architecture Best Practices (from supervisor.ts refactoring audit)

| #      | Rule                                                                                   | Explanation                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** | **Target < 300 lines per file**                                                        | Files over 300 lines become too large for agents to reason about. Entry point (`index.ts`) should be < 100 lines.                                                                                                                                                                                                                                                                                                      |
| **M2** | **Dependency layering: types → pure utils → dependent modules → orchestrator → entry** | `types.ts` has zero internal deps. Pure helpers import only types. Orchestrator imports everything. Entry point imports only orchestrator and renderer. **No circular imports.**                                                                                                                                                                                                                                       |
| **M3** | **Use directory structure: `.pi/extensions/<name>/index.ts`**                          | Pi auto-discovers `index.ts` inside a directory. Pi uses [jiti](https://github.com/unjs/jiti) to transpile at load — no build step needed. Sibling `import` from `./module` works natively.                                                                                                                                                                                                                            |
| **M4** | **Entry point is thin — only registrations**                                           | `index.ts` exports `default function(pi: ExtensionAPI)` and delegates to modules. No logic, no types, no helpers. Only `pi.registerCommand()`, `pi.registerTool()`, `pi.registerMessageRenderer()`.                                                                                                                                                                                                                    |
| **M5** | **Extraction order: types → pure → dependent → orchestrator → entry**                  | When splitting a monolith: extract types first (zero deps), then pure utility modules, then modules with internal deps, then the orchestrator/command handler, then clean up `index.ts`. Verify after each step.                                                                                                                                                                                                       |
| **M6** | **Preserve external contracts during refactoring**                                     | When restructuring, do NOT change: config format, security model, CLI flags, message renderer `customType`, completion markers, or external integrations (LSP hooks, dynamic imports).                                                                                                                                                                                                                                 |
| **M7** | **Re-export for testability**                                                          | Entry point may re-export pure functions from sub-modules so tests import from a single path without breaking encapsulation.                                                                                                                                                                                                                                                                                           |
| **M8** | **Parameter count/type changes in signatures must update all consumers**               | When refactoring function signatures, changing parameter count or types silently breaks all callers and re-exported types. Lazy-import wrappers and interface re-exports fail at compile time when signatures diverge. Before removing or adding a parameter, grep for all references to the function across all extensions. Existing breakage: `tsc-checkpoint.ts` param removal broke `supervisor/tsc-decisions.ts`. |

### ♻️ Reuse Pi Built-in APIs

| #      | Rule                                                                | Explanation                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | **Prefer `pi.exec()` over raw `child_process`**                     | `pi.exec()` is async (non-blocking), integrates with Pi abort signals (`ctx.signal`), streams output, and never blocks the event loop. Do NOT use `execFileSync`, `execSync`, `exec`, or `spawn` (for short-lived processes). Use raw `spawn` only for long-running daemon processes (LSP servers, watchers). |
| **R2** | **Prefer `pi.appendEntry()` over raw file I/O for persistence**     | Extension state that should survive restarts gets stored in the session JSONL file. Queryable via `ctx.sessionManager.getEntries()`. Use raw `fs` only for config files that must outlive sessions or be shared across projects.                                                                              |
| **R3** | **Prefer `ctx.sessionManager` over manual session file parsing**    | SessionManager provides tree navigation (`getBranch`, `getTree`, `getChildren`), entry access (`getEntries`, `getEntry`), and context building (`buildSessionContext`). Do not `fs.readFileSync` the session file directly.                                                                                   |
| **R4** | **Prefer `ctx.ui.*` over building custom TUI for standard dialogs** | `ctx.ui.confirm()`, `ctx.ui.select()`, `ctx.ui.input()`, `ctx.ui.notify()`, `ctx.ui.setStatus()` cover 90% of user-interaction needs. Use `ctx.ui.custom()` only for complex multi-step interactions.                                                                                                         |
| **R5** | **Prefer `pi.sendUserMessage()` over manual message construction**  | Handles delivery modes (`steer`, `followUp`, `nextTurn`), session integration, and trigger-turn logic. Do not manually construct message objects and append to session.                                                                                                                                       |
| **R6** | **Prefer `ctx.cwd` over `process.cwd()`**                           | `process.cwd()` captured at module load is stale if directory changes. `ctx.cwd` is always current. Compute paths lazily at call time. (See also [C6](#-common-issues-apply-to-all-extensions) and [P7](#-common-pitfalls--do-not-repeat-these) on stale `process.cwd()`.)                                    |

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

| #       | Pitfall                                                                                                                                                                                                       | Correct Approach                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------- |
| **P1**  | **`any` disables all type checking** — `(data as any).foo` suppresses errors but eliminates compiler safety.                                                                                                  | Use `unknown` + type guards: `function isFoo(x: unknown): x is Foo { ... }`                                                                                                                                                              |
| **P2**  | **`{}` means "any non-nullish value"**, not "empty object" — `{}` is assignable from everything except `null`/`undefined`.                                                                                    | Use `Record<string, unknown>` for open objects, `Record<string, never>` for truly empty.                                                                                                                                                 |
| **P3**  | **Type assertions (`as`) on untrusted data** — `(entry.data as { level: Level })` bypasses runtime checks.                                                                                                    | Use type guards: `typeof x === "object" && x !== null && "level" in x`                                                                                                                                                                   |
| **P4**  | **`catch (err: any)` discards type safety** — `err` in catch blocks is `unknown` in TS 4.0+ with `useUnknownInCatchVariables`.                                                                                | Use `err instanceof Error ? err.message : String(err)`                                                                                                                                                                                   |
| **P5**  | **Operator precedence with `??` and `+`** — `a ?? b + c ?? d` evaluates as `a ?? (b + c) ?? d`, not `(a ?? b) + (c ?? d)`. `+` binds tighter than `??`.                                                       | Always parenthesize: `(a ?? 0) + (b ?? 0)`                                                                                                                                                                                               |
| **P6**  | **`spawn({ timeout })` is silently ignored** on older Node — the `timeout` option in `child_process.spawn` didn't exist before v14.18.0.                                                                      | Use `AbortController` + `signal` in spawn options, then `setTimeout(() => controller.abort(), ms)`. This is portable across all Node versions.                                                                                           |
| **P7**  | **Module-level `process.cwd()` paths become stale** — if cwd changes between module load and function execution, cached paths are wrong.                                                                      | Compute lazily at call time using `ctx.cwd` or `process.cwd()`.                                                                                                                                                                          |
| **P8**  | **`require()` synchronously blocks event loop** — CommonJS `require` in async contexts defeats tree-shaking and blocks.                                                                                       | Use dynamic `import()`.                                                                                                                                                                                                                  |
| **P9**  | **Empty child process `error` event handler** — `child.on("error", (err) => { /* comment only */ })` silently discards crash errors.                                                                          | ALWAYS push to error tracking: `child.on("error", (err) => errors.push(err))`                                                                                                                                                            |
| **P10** | **`onUpdate` callback signature duplicated across extensions** — copy-pasted inline types drift.                                                                                                              | Define shared `OnUpdateCallback` type in `.pi/extensions/types.ts`.                                                                                                                                                                      |
| **P11** | **String matching on agent output** — `output.includes("APPROVED")` is fragile. If agent echoes the instruction text, heuristic workarounds break.                                                            | Use structured markers on their own line, e.g., `<!-- STATUS: APPROVED -->` or a JSON envelope.                                                                                                                                          |
| **P12** | **Sync I/O in async handlers** — `writeFileSync`, `execSync` inside `async` functions block the event loop.                                                                                                   | Use `fs.promises.writeFile`, `execFile` with promise wrapper.                                                                                                                                                                            |
| **P13** | **Child process spawned without enforceable timeout** — unbounded child processes accumulate, consuming system resources.                                                                                     | Always use `AbortController` + `child.kill()` pattern.                                                                                                                                                                                   |
| **P14** | **`StringEnum` vs `Type.Union([Type.Literal(...)])`** — Google API doesn't support `Type.Union` for string enums.                                                                                             | Always use `StringEnum(["a", "b"] as const)` from `@earendil-works/pi-ai`.                                                                                                                                                               |
| **P15** | **`timer.unref()` type mismatch** — `NodeJS.Timeout` may not expose `.unref()` in strict TS types depending on `@types/node` version.                                                                         | Safe escape: `(timer as any)?.unref?.()`. Double optional chain + `any` cast handles both the type mismatch and null safety. Existing use: `caveman/animation.ts:80`, `lsp-auditor/lsp-client.ts:303`.                                   |
| **P16** | **`readdirSync(dir, { withFileTypes: true })` returns `Dirent[]` not `string[]`** — typing the result as `string[]` fails under strict TS.                                                                    | Import `type Dirent` from `node:fs` and declare: `let entries: Dirent[]`. Existing use: `check-extensions/ast-scanner.ts:12`, `extension-scanner.ts:8`.                                                                                  |
| **P17** | \*\*`ctx.ui.notify()` level param union is `"info"                                                                                                                                                            | "error"                                                                                                                                                                                                                                  | "warning"`, not `"success"`** — passing `"success"` causes TS error under strict typing.                                                              | Use one of the valid literals: `ctx.ui.notify(msg, "info")`. Existing fix: `check-extensions/index.ts:371`, `session-advice/index.ts:100`. |
| **P18** | \*\*Optional fields that can be `null` must be `T                                                                                                                                                             | null`, not just `T?`** — The `?`syntax adds`                                                                                                                                                                                             | undefined`, not `                                                                                                                                     | null`. When an API returns `null`, the type must include `null`.                                                                           | Use `{ tokens?: number | null }`instead of`{ tokens?: number }`. Existing fix: `context-info/telemetry.ts:16`. |
| **P19** | **Non-standard error property access — `(err as NodeJS.ErrnoException).stderr` fails** — `useUnknownInCatchVariables` means `err` is `unknown`, and `NodeJS.ErrnoException` may not be in scope.              | Use `(err as any).stderr` for non-standard error properties. `err instanceof Error ? (err as any).stderr : String(err)` for safe access. Existing use: `lsp-auditor/run-pre-audit.ts:54`.                                                |
| **P20** | **Theme API type limitations — `theme.fg()` second param may require literal union, not `string`** — computed color strings fail type checking.                                                               | Safe escape: `theme.fg(tColor as any, text)`. Document that this is an accepted boundary where pi SDK types are the constraint, not the extension. Existing use: `context-info/footer.ts:88`.                                            |
| **P21** | **Literal union widening — when runtime values exceed declared union, member-by-member union expansion is fragile** — If a union `"read"                                                                      | "write"` doesn't cover actual runtime values, adding every runtime value to the union is impractical.                                                                                                                                    | Widen to `string` when the API returns values outside the declared union and the union cannot be changed. Existing fix: `session-logger/types.ts:35`. |
| **P22** | **Non-null assertion (`!`) should only be used when API contract guarantees non-null at call site** — `sessionFile!` suppresses null checks but can cause runtime `undefined` access if the contract changes. | Only use `!` when you have documented proof (API spec, schema) that the value is always present at call time. Include a `/* guaranteed by API contract */` comment explaining the guarantee. Existing use: `session-logger/index.ts:51`. |
| **P23** | **Property rename in interface breaks all consumers silently** — when a type field is renamed (e.g. `description` → `changelogVersion`), all files using the old name fail at compile time.                   | Before renaming a field in a shared type/interface, grep for the old key name across ALL extensions and update every usage. Existing breakage: `check-extensions/issue-builder.ts` (`description` → `changelogVersion`).                 |
| **P24** | **`pi.sendMessage()` / `pi.sendUserMessage()` may require `customType` field** — omitting required fields causes TS error.                                                                                    | Consult the pi docs or the `sendMessage` type signature before constructing messages. Include all required fields including `customType` when mandated by the type. Existing fix: `lsp-auditor/index.ts:43-46`.                          |

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

| Priority                 | What                                                                                     | When to flag                                 |
| ------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| 🔴 **P0 — Blocker**      | `any` on security-critical paths, silent error swallowing, zombie processes              | Design is rejected until fixed               |
| 🟠 **P1 — Must Fix**     | `any` on API boundaries, module-level mutable state, `details: {}`                       | Must be addressed in PRD before approval     |
| 🟡 **P2 — Should Fix**   | Missing return type annotations, sync I/O at init, `require()` usage                     | Should be documented in PRD with plan to fix |
| 🟢 **P3 — Nice to Have** | Shared type module consolidation, magic number documentation, target file size adherence | Document in PRD, fix during implementation   |

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
- [ ] `pi.exec()` used instead of raw `child_process` for subprocess execution
- [ ] `pi.appendEntry()` used for session-persistent state (not raw file I/O)
- [ ] `ctx.sessionManager` used instead of direct session file parsing
- [ ] `ctx.ui.*` dialogs used for standard user interactions (not custom TUI)
- [ ] `pi.sendUserMessage()` used for sending messages to the conversation
- [ ] `ctx.cwd` used in place of `process.cwd()` for current working directory
- [ ] C10: All local imports use `.ts` extension (`from "./module.ts"`)
- [ ] C11: `satisfies` used for object literals that must match an interface without type widening
- [ ] C12: Dynamic `import()` uses double-cast pattern (`as unknown as T`)
- [ ] C13: Unused callback parameters prefixed with underscore (`_event`, `_ctx`)
- [ ] C14: Destructured object parameters have inline type annotations
- [ ] P15: `timer.unref()` uses safe escape pattern (`(timer as any)?.unref?.()`)
- [ ] P16: `readdirSync` with `withFileTypes: true` uses `Dirent[]` type (import `type Dirent` from `node:fs`)
- [ ] P17: `ctx.ui.notify()` level param uses valid literal (`"info" | "error" | "warning"`, never `"success"`)
- [ ] P18: Optional nullable fields typed as `T | null`, not just `T?`
- [ ] P19: Non-standard error properties accessed via `(err as any).stderr`, not `NodeJS.ErrnoException`
- [ ] P20: Theme API type limitations handled with `as any` escape, documented as pi SDK boundary
- [ ] P21: Literal unions widened to `string` when runtime values exceed declared union
- [ ] P22: Non-null assertions (`!`) used only with API-contract guarantee and explanatory comment
- [ ] P23: Property renames in interfaces include grep for old key name across all extensions
- [ ] P24: `pi.sendMessage()` / `pi.sendUserMessage()` includes all required fields including `customType`
- [ ] M8: Parameter count/type changes in signatures updated across all consumers including re-exports

---

## PHASES

### PHASE 0 — ANALYZE SCOPE

#### New extension mode

Analyze the request automatically. Determine from context:

1. **Problem & users**: What problem does it solve? Who uses it? (Infer from extension name/description or `$@` argument.)
2. **Scope**: Single tool? Tool + commands? Lifecycle hooks? UI components? (Analyze based on what problem the extension solves — choose appropriate APIs.)
3. **Dependencies**: npm packages needed? External services? System binaries? (Research based on the extension's domain.)
4. **Persistence**: State across sessions? Disk files? Session entries? (Decide based on extension purpose.)
5. **Happy path**: Derive the typical user interaction flow from the extension's purpose.

#### Refactor mode

1. Read the existing extension thoroughly. Produce an audit summary: line count, file count, anti-patterns found, current structure.
2. Determine what needs to change based on audit findings: extract modules, fix anti-patterns, improve types, split monolith.
3. Check backward compatibility: identify config keys, CLI flags, message types, session entries, file formats the extension uses. Preserve unless breaking change is justified.
4. Define scope of refactor: full restructure? targeted fixes? module split? rename? new features alongside restructuring?
5. Derive the happy path after refactor — what should work the same, what will be better.

**Research during this phase:** Read relevant pi extension examples similar in scope. Note patterns and APIs used. In refactor mode, also read sibling extensions in `.pi/extensions/` to understand shared patterns.

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

````markdown
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

| Event              | Action |
| ------------------ | ------ |
| `session_start`    | ...    |
| `tool_call`        | ...    |
| `session_shutdown` | ...    |

### State Management

- What state, where stored, how rehydrated.

### Error Handling

| Error Scenario | Handling |
| -------------- | -------- |
| ...            | ...      |

## Implementation Details

### Dependencies

- npm packages with versions
- System binaries required

### Key TypeScript Interfaces

```typescript
// shared types
```
````

### File-by-file Breakdown

| File | Purpose | ~Lines |
| ---- | ------- | ------ |
| ...  | ...     | ...    |

### Test Strategy

- Unit tests for pure helpers
- Integration tests for extension adapter
- Bug regression tests

## Best Practices Compliance

| Rule                                     | Status   | Notes |
| ---------------------------------------- | -------- | ----- |
| No `any` on API boundaries               | ✅/⚠️/❌ | ...   |
| `details` uses `Record<string, unknown>` | ✅       | ...   |
| State encapsulated in closure            | ✅       | ...   |
| Explicit return type annotations         | ✅       | ...   |
| No sync I/O at module init               | ✅       | ...   |
| `AbortController` for spawn timeout      | ✅       | ...   |
| Child process `error` events handled     | ✅       | ...   |
| `catch` uses `instanceof Error`          | ✅       | ...   |
| `import()` not `require()`               | ✅       | ...   |
| Discriminated unions for events          | ✅       | ...   |
| Files < 300 lines, entry < 100 lines     | ✅/⚠️/❌ | ...   |
| No circular imports                      | ✅       | ...   |
| Entry point is registrations only        | ✅       | ...   |

````

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
````

### PHASE 4 — DELIVERY

After the PRD is complete, produce the output:

- **If `$@` included `--implement` flag or the extension is trivially small**: write the extension code immediately after the PRD.
- **Otherwise**: Display the complete PRD. Then offer to implement or create a GitHub issue. Default action is to write the PRD to `.pi/specs/<extension-name>-prd.md` for review.

---

## Prerequisites

- `.pi/settings.json` must contain `supervisor.repo` set to `owner/repo` (for GitHub issue creation).
- `gh` installed and authenticated (for GitHub issue creation).

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

## Step 3 — Run PHASE 0 (Analyze Scope)

Proceed through all phases automatically. Never skip phases.

For **new extension mode**: Use the `$@` argument as the extension idea. Analyze the name and description to infer purpose, scope, dependencies, and happy path. If `$@` is empty, analyze the user's input context.

For **refactor mode**: Read the existing extension files, audit against best practices, and derive the refactoring plan from the audit findings.

---

## Important Rules

1. **The PRD is a design document, not code.** Write code only after the PRD is complete. If `--implement` flag is passed, write code immediately after the PRD.
2. **Always consult the best practices audit before making a design decision.** If a design would introduce an anti-pattern, flag it immediately.
3. **The PRD must be self-contained.** Someone reading it should understand the full design without scrolling through the conversation.
4. **Be specific about TypeScript types.** Vague "params: any" is unacceptable. Every tool parameter must have a TypeBox schema.
5. **When creating a GitHub issue**, use the `refined` label and include the full PRD in the issue body. The title should be the extension name.
6. **In refactor mode, always read the existing files first.** Never propose changes without reading the actual code.
7. **In refactor mode, preserve external contracts by default.** Breaking changes (config format, CLI flags, message types) must be explicit, documented, and justified.
8. **In refactor mode, if renaming the extension**, document every location that references the old name and include it in the migration plan.
9. **In refactor mode, propose an incremental migration strategy.** The extension must remain functional after each extraction step. Verify at every step.
