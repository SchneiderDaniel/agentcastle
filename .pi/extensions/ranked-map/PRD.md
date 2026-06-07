# PRD: ranked-map — Extension Refactor

## Summary

Refactor the `ranked-map` extension from a single 877-line monolith file at `.pi/extensions/ranked-map.ts` into a modular directory structure at `.pi/extensions/ranked-map/index.ts` with clean dependency layering (types → pure utils → dependent modules → orchestrator → entry). Fix anti-patterns: replace `execSync` with async `pi.exec()`, add `AbortController` for timeouts, extract shared types, enforce module boundaries. All external contracts preserved — tool name, parameters, config schema, and output shape unchanged.

## User Stories

- **As a developer auditing the extension**, I want clear module boundaries so I can understand, test, and modify each concern independently.
- **As a maintainer fixing a bug in keyword scoring**, I want to find the scoring logic in one small file without scrolling past ctags parsing, git helpers, and cache management.
- **As a consumer of the test suite**, I want to import pure functions from a clean module graph so tests are fast and focused.
- **As the pi agent using the tool**, I want subprocess execution to be non-blocking and abort-aware so the tool respects cancellation and doesn't stall the event loop.

## Current State Audit

### File Overview

| File                           | Lines | Issues                                                                                       |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------- |
| `.pi/extensions/ranked-map.ts` | 877   | Monolith: types, ctags, git, scoring, caching, formatting, tool registration all in one file |

### Anti-Patterns Found

| #   | Rule                                            | Location                                                                                     | Severity |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| M1  | Files > 300 lines                               | Entire file (877 lines)                                                                      | 🟠 P1    |
| M4  | Entry not thin                                  | Tool registration mixed with pure logic                                                      | 🟠 P1    |
| M2  | No dependency layering                          | One flat file, no module graph                                                               | 🟡 P2    |
| R1  | Uses `execSync` instead of async `pi.exec()`    | `runKeywordSearch`, `runGitRecency`, `getGitHead`                                            | 🟠 P1    |
| P13 | No `AbortController` for child process timeouts | `execSync({ timeout })` does not support abort                                               | 🟠 P1    |
| P9  | Empty error handlers on child processes         | `execSync` catch blocks re-throw or swallow                                                  | 🟡 P2    |
| C1  | `any` used in catch blocks                      | `catch { continue }` discards type info                                                      | 🟡 P2    |
| C3  | Types not shared                                | `SymbolEntry`, `RankedFileScore` etc. defined locally, could be in `.pi/extensions/types.ts` | 🟢 P3    |
| C10 | No `.ts` extension on imports                   | No local imports currently (single file) — will need after split                             | 🟢 P3    |
| C4  | Module-level mutable state                      | `DEFAULT_CONFIG` at module scope — safe since const, but worth noting                        | 🟢 P3    |
| C13 | Unused params                                   | `buildCtagsArgs` returns unused `command` field                                              | 🟢 P3    |

### External Contracts (All Preserved)

| Contract                                                                                                                  | Type              | Preserved?                         |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------------------------- |
| Tool name `ranked_map`                                                                                                    | Tool name         | ✅ No change                       |
| Parameters: `query`, `tokenBudget`, `directory`                                                                           | Tool params       | ✅ No change                       |
| Output: `files`, `total_tokens`, `budget`, `truncated`, `mode`                                                            | Tool output shape | ✅ No change                       |
| Config key `rankedMap` in `.pi/settings.json`                                                                             | Config            | ✅ No change                       |
| Config fields: `tokenBudget`, `recencyWindowDays`, `cacheTtlHours`, `autoThreshold`, `weights.keyword`, `weights.recency`, `weights.fileSize` | Config            | ✅ No change                       |
| Cache file `.pi/cache/ranked-map-index.json`                                                                              | Cache format      | ✅ No change                       |
| Exported pure functions for testing                                                                                       | Test imports      | ✅ All re-exported from `index.ts` |

## Architecture

### Module Dependency Graph

```
types.ts ─────► config.ts ──┐     (zero pi SDK imports)
  │               │          │
  ├──────────────► ctags.ts ─┤     (pure: parseCtagsOutput, buildCtagsArgs, buildSymbolIndex)
  │               │          │
  ├──────────────► search.ts ─┤     (pi.exec-based: runKeywordSearch)
  │               │          │
  ├──────────────► git.ts ───┤     (pi.exec-based: runGitRecency, getGitHead)
  │               │          │
  ├──────────────► cache.ts ─┘     (pure: loadCachedIndex)
  │
  ├──────────────► scoring.ts      (pure: computeKeywordScores, computeRecencyScores, rankFiles)
  │
  └──────────────► format.ts       (pure: estimateTokens, selectMode, dumpAllFiles, formatSymbols, formatOutput)
                        │
                        ▼
                   index.ts        (orchestrator: tool registration, execute handler)
                   (entry, < 100 lines)
```

### Structure

```
.pi/extensions/ranked-map/
├── index.ts      # Entry point: tool registration + execute handler (< 100 lines)
├── types.ts      # All shared types + interfaces
├── config.ts     # Config loading from settings.json
├── ctags.ts      # Ctags parsing and symbol index building
├── search.ts     # Keyword search via rg
├── git.ts        # Git recency and HEAD helpers
├── cache.ts      # Cache read/write
├── scoring.ts    # Keyword + recency scoring + ranking
└── format.ts     # Output formatting, mode selection, full dump
```

### Expected Line Counts

| File         | Est. Lines | Purpose                                                      |
| ------------ | ---------- | ------------------------------------------------------------ |
| `types.ts`   | ~60        | All interfaces and type definitions                          |
| `config.ts`  | ~90        | Config loading with validation                               |
| `ctags.ts`   | ~130       | Ctags parsing, command building, symbol index construction   |
| `search.ts`  | ~60        | Keyword search via rg                                        |
| `git.ts`     | ~60        | Git recency and HEAD                                         |
| `cache.ts`   | ~50        | Cache management                                             |
| `scoring.ts` | ~100       | Scoring and ranking functions                                |
| `format.ts`  | ~80        | Output formatting, mode selection                            |
| `index.ts`   | ~90        | Entry point: tool registration + execute handler             |
| **Total**    | **~720**   | Slightly less than 877 (code deduplication from refactoring) |

### Tool Definition (Unchanged)

```typescript
// Single tool: ranked_map
// Parameters: query (optional string), tokenBudget (optional number), directory (optional string)
// Returns: { files: RankedFileScore[], total_tokens: number, budget: number, truncated: boolean, mode: "ranked" | "full_dump" }
```

### State Management

No state changes. Cache persists at `.pi/cache/ranked-map-index.json` — invalidated on HEAD change. No session-level state.

### Error Handling

| Error Scenario                      | Handling                                                     |
| ----------------------------------- | ------------------------------------------------------------ |
| ctags not installed or fails        | Return error content with message to install universal-ctags |
| rg not installed or fails per term  | Silently skip term (rg exit code 1 = no matches, not error)  |
| git log fails (no commits, no repo) | Return empty recency scores                                  |
| Cache corrupt or HEAD mismatch      | Rebuild from scratch                                         |
| Directory doesn't exist             | ctags will fail, return descriptive error                    |

### Pure vs. Adapter Split

**Pure modules** (zero pi imports, testable without pi SDK):

- `types.ts`, `config.ts`, `ctags.ts`, `cache.ts`, `scoring.ts`, `format.ts`

**Adapter module** (uses `pi.exec`):

- `search.ts`, `git.ts`

**Orchestrator** (ties everything together, tool registration):

- `index.ts`

## Implementation Details

### Dependencies

- **System binaries**: `universal-ctags` (with JSON output), `rg` (ripgrep), `git`
- **npm packages**: None new. Existing: `@earendil-works/pi-coding-agent`, `typebox`

### Key TypeScript Interfaces

All defined in `types.ts`:

```typescript
export interface RankedMapConfig {
	tokenBudget: number;
	recencyWindowDays: number;
	cacheTtlHours: number;
	autoThreshold: number;
	weights: { keyword: number; recency: number; fileSize?: number };
}

export interface CachedIndex {
	head: string;
	builtAt: number;
	symbols: Record<string, SymbolEntry[]>;
}

export interface SymbolEntry {
	type: string;
	name: string;
	line: number;
}

export interface RankedFileScore {
	path: string;
	score: number;
	symbols: string;
	preview: string;
}

export interface RankedMapResult {
	files: RankedFileScore[];
	total_tokens: number;
	budget: number;
	truncated: boolean;
	mode: "ranked" | "full_dump";
}

/** Raw ctags JSONL tag object (internal). */
export interface CtagsTag {
	_type: string;
	name: string;
	kind: string;
	path: string;
	pattern: string;
	line?: number;
}
```

### Key API Changes (Internal Only)

| Current (sync)                                          | New (async)                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `runKeywordSearch(query, dir, cwd)` sync via `execSync` | `runKeywordSearch(query, dir, cwd, signal?)` async via `pi.exec()` |
| `runGitRecency(windowDays, cwd)` sync via `execSync`    | `runGitRecency(windowDays, cwd, signal?)` async via `pi.exec()`    |
| `getGitHead(cwd)` sync via `execSync`                   | `getGitHead(cwd, signal?)` async via `pi.exec()`                   |

These are internal API changes affecting only the extension's own modules. No external contract changes.

### Migration Strategy (Incremental)

1. **Create types.ts** — Extract all interfaces. No dependencies. Verify extension still loads from old file.
2. **Create config.ts** — Extract `loadRankedMapConfig`, `DEFAULT_CONFIG`, `MAX_RECENCY_WINDOW_DAYS`. Depends only on `types.ts`. Verify.
3. **Create ctags.ts** — Extract `parseCtagsOutput`, `buildCtagsArgs`, `buildSymbolIndex`. Depends on `types.ts`.
4. **Create cache.ts** — Extract `loadCachedIndex`. Depends on `types.ts`.
5. **Create format.ts** — Extract `estimateTokens`, `selectMode`, `dumpAllFiles`, `formatSymbols`, `formatOutput`. Depends on `types.ts`.
6. **Create scoring.ts** — Extract `computeKeywordScores`, `computeRecencyScores`, `rankFiles`. Depends on `types.ts`, `format.ts`.
7. **Rewrite search.ts** — Extract `runKeywordSearch` as async. Depends on `types.ts`, uses `pi.exec()`.
8. **Rewrite git.ts** — Extract `runGitRecency`, `getGitHead` as async. Depends on `types.ts`, uses `pi.exec()`.
9. **Create index.ts** — Thin entry: tool registration + async execute handler importing all modules. Depends on everything above.
10. **Delete old monolith** — After verifying `/reload` works with new directory.
11. **Update test imports** — `test/ranked-map.test.mts` imports from new module paths.

Step 6-8 can be done in any order. Steps 1-5 have zero or one dependency and can be parallelized.

### Rollback

- Keep old `ranked-map.ts` until final verification passes.
- If new directory fails: delete `.pi/extensions/ranked-map/`, restore `.pi/extensions/ranked-map.ts`, run `/reload`.

## Best Practices Compliance

| Rule                                                 | Status | Notes                                                                                  |
| ---------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| No `any` on API boundaries                           | ✅     | All tool I/O typed. `(err as any).stderr` for non-standard error props (P19 exception) |
| `details` uses `Record<string, unknown>`             | ✅     | Already compliant                                                                      |
| State encapsulated in closure                        | ✅     | Cache lives on filesystem; no module-level mutable state                               |
| Explicit return type annotations                     | ✅     | All exported functions have return types                                               |
| No sync I/O at module init                           | ✅     | All I/O deferred to execute handler                                                    |
| `AbortController` for spawn timeout                  | ✅     | Replacing `execSync` with `pi.exec()` which supports `ctx.signal`                      |
| Child process `error` events handled                 | ✅     | `pi.exec()` handles internally; catch blocks use `instanceof Error`                    |
| `catch` uses `instanceof Error`                      | ✅     | `err instanceof Error ? err.message : String(err)`                                     |
| `import()` not `require()`                           | ✅     | No `require()` used                                                                    |
| Discriminated unions for events                      | N/A    | No event handlers in this extension                                                    |
| Files < 300 lines, entry < 100 lines                 | ✅     | Each module ≤ 130 lines; entry ∼90 lines                                               |
| No circular imports                                  | ✅     | Dependency graph is a DAG (types → everything → index)                                 |
| Entry point is registrations only                    | ✅     | `index.ts` delegates to orchestrator logic                                             |
| C10: `.ts` extension on imports                      | ✅     | All imports use `.ts`                                                                  |
| C13: Underscore for unused params                    | ✅     | `_toolCallId`, `_signal` etc.                                                          |
| C14: Inline type annotations for destructured params | ✅     | Where applicable                                                                       |
| R1: `pi.exec()` over raw `child_process`             | ✅     | Replacing `execSync` with `pi.exec()`                                                  |
| R6: `ctx.cwd` over `process.cwd()`                   | ✅     | Already using `ctx.cwd`                                                                |
| P13: Child process timeout via AbortController       | ✅     | Using `ctx.signal` from `pi.exec()`                                                    |
