# PRD: Supervisor Refactor — Modularization & Anti-Pattern Fixes

## Summary

Refactor the supervisor extension to reduce file sizes, eliminate `any` on API boundaries, replace raw `child_process.exec` with `pi.exec()`, and fix minor anti-patterns. The supervisor manages a Kanban-driven multi-agent workflow for GitHub issues. It works today — the refactoring targets maintainability and TypeScript hygiene without changing external behavior.

## Current State Audit

### File Overview

| File                      | Lines     | Issues                                                 |
| ------------------------- | --------- | ------------------------------------------------------ |
| `pipeline.ts`             | 861       | 🔴 >300 lines, raw `exec` wrapper, sync I/O in handler |
| `github.ts`               | 751       | 🔴 >300 lines, `Promise<any>` returns on API boundary  |
| `agent-session-runner.ts` | 362       | 🟡 >300 lines, `as any` cast                           |
| `agent-stream.ts`         | 315       | 🟡 >300 lines                                          |
| `agent-runner.ts`         | 296       | 🟢 borderlines okay                                    |
| `session-events.ts`       | 297       | 🟢 borderline, `(ev: any)` param type                  |
| `session-widget.ts`       | 210       | 🟢 OK                                                  |
| `session-result.ts`       | 174       | 🟢 OK                                                  |
| `extensions.ts`           | 190       | 🟢 OK                                                  |
| `ci-gating.ts`            | 229       | 🟢 OK                                                  |
| `workflow.ts`             | 121       | 🟢 OK                                                  |
| `config.ts`               | 222       | 🟢 OK (sync I/O at call time, acceptable)              |
| `types.ts`                | 222       | 🟢 OK                                                  |
| Others                    | <180 each | 🟢 OK                                                  |
| **Total**                 | **5,375** | ~2000 lines in files >300                              |

### Anti-Patterns Found

| #   | Rule                        | Location                        | Severity | Detail                                                                                        |
| --- | --------------------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| C1  | `any` on API boundary       | `github.ts:37`                  | 🟠 P1    | `ghJson()` returns `Promise<any>` — propagates to all callers                                 |
| C1  | `any` on API boundary       | `github.ts:44`                  | 🟠 P1    | `ghGraphQL()` returns `Promise<any>` — all GraphQL callers untyped                            |
| C1  | `any` on param type         | `session-events.ts:28`          | 🟡 P2    | `processSessionEvent(ev: any, state)` — event param untyped                                   |
| C1  | `as any` cast               | `agent-session-runner.ts:96`    | 🟡 P2    | `getModel(modelInfo.provider as any, modelInfo.modelId as any)`                               |
| C1  | `as any` cast               | `pipeline-audit.ts:138`         | 🟡 P2    | `(e.data as any)?.issueNum === issueNum`                                                      |
| R1  | Raw `child_process`         | `pipeline.ts:16-22`             | 🟠 P1    | `exec` from `node:child_process` wrapped as `execWithSignal` instead of `pi.exec()`           |
| M1  | File >300 lines             | `pipeline.ts` (861)             | 🟠 P1    | Monolithic handler: worktree mgmt, PR creation, status loop, hooks, error handling all in one |
| M1  | File >300 lines             | `github.ts` (751)               | 🟠 P1    | GraphQL queries, project ops, dep checks, git helpers in one file                             |
| M1  | File >300 lines             | `agent-session-runner.ts` (362) | 🟡 P2    | In-process runner logic                                                                       |
| M1  | File >300 lines             | `agent-stream.ts` (315)         | 🟡 P2    | Stream helpers                                                                                |
| P12 | Sync I/O in async handler   | `pipeline.ts:293`               | 🟡 P2    | `existsSync()` in middle of async handler                                                     |
| P12 | Sync I/O in async handler   | `pipeline.ts:638`               | 🟡 P2    | `writeFileSync()` in middle of async handler                                                  |
| P7  | `process.cwd()` fallback    | `extensions.ts:44-45,67,133`    | 🟢 P3    | Used inside functions (computed at call time) but `ctx.cwd` preferred (R6)                    |
| P4  | `catch (err)` no `:unknown` | `agent-runner.ts:43`            | 🟢 P3    | Missing `err: unknown` annotation (TS 4.0+ may infer this)                                    |
| C10 | `.ts` extension             | —                               | ✅       | Already used on all local imports ✓                                                           |
| C11 | `satisfies`                 | `pipeline.ts`                   | ✅       | `details satisfies SupervisorMessageDetails` ✓                                                |
| C9  | Interfaces over types       | —                               | ✅       | All types use `interface` ✓                                                                   |
| C7  | Dynamic `import()`          | —                               | ✅       | `await import(...)` used, no `require()` ✓                                                    |
| R2  | `pi.appendEntry()`          | —                               | ✅       | Used in pipeline.ts for state persistence ✓                                                   |
| C4  | Closure state               | —                               | ✅       | Module-level mutable state minimal (`_extToolsCache` only) ✓                                  |

## User Stories

- **As a maintainer**, I want files <300 lines so the LLM and I can reason about them without scrolling.
- **As a maintainer**, I want `ghJson`/`ghGraphQL` to return typed results so consumers don't need `as any` casts.
- **As a maintainer**, I want `pi.exec()` used everywhere so abort signals and output capture are consistent.
- **As a contributor**, I want related concerns grouped into purpose-named files so I find what I need faster.

## Architecture

### Proposed Structure

```
.pi/extensions/supervisor/
├── index.ts                     # Entry — registrations only (17 lines, no change)
├── types.ts                     # Shared interfaces (no change)
├── config.ts                    # Config loading (no change)
├── workflow.ts                  # Workflow step definitions (no change)
├── formatting.ts                # Pure format helpers (no change)
├── agent-loader.ts              # Agent file parser (no change)
├── agent-task.ts                # Task builder (no change)
├── agent-runner.ts              # Agent runner (orchestrates in-process + subprocess)
├── agent-stream.ts              # Stream helper (pure, no change)
├── session-events.ts            # SDK event → state processor (fix `any` type)
├── session-result.ts            # AgentRunResult builder (no change)
├── session-model.ts             # Model + tool resolution (no change)
├── session-widget.ts            # TUI widget builder (no change)
├── message-renderer.ts          # Custom TUI renderers (no change)
│
├── github/                      # NEW: split from github.ts
│   ├── index.ts                 # Re-exports all github submodules
│   ├── types.ts                 # NEW: typed wrappers for ghJson/ghGraphQL
│   ├── gh-client.ts             # NEW: gh/ghJson/ghGraphQL with typed return pattern
│   ├── project.ts               # Project board: fields, items, status, id
│   ├── deps.ts                  # Dependency gate, block detection
│   ├── pr.ts                    # PR conflict detection, creation
│   ├── comment.ts               # Issue comment posting
│   └── git.ts                   # commitChanges, pushBranch, commitAndPush
│
├── pipeline/                    # NEW: split from pipeline.ts
│   ├── index.ts                 # registerSupervisorCommand (thin entry)
│   ├── handler.ts               # Main /supervisor command handler (status loop)
│   ├── stages.ts                # Stage transition logic (per-status dispatch)
│   ├── worktree.ts              # Worktree create/cleanup/install-deps
│   ├── pr-creation.ts           # PR creation logic (decoupled from handler)
│   ├── hooks.ts                 # CI/TSC/LSP hook wiring
│   └── notifications.ts        # Pipeline status notifications + summary
│
├── agent-session-runner.ts      # In-process agent runner (no structural change)
├── ci-gating.ts                 # CI polling (no change)
├── pipeline-audit.ts            # Pre-audit TSC/LSP checks (no change)
├── pipeline-merge.ts            # Merge conflict handling (no change)
└── pipeline-output.ts           # Summary builders (no change)
```

### Split Rationale

**`github.ts` (751 → 7 files)**: GitHub operations are 6 distinct concerns — CLI wrapper, GraphQL client (types), project board, dependency gate, PR operations, comments, git commands. Each has its own data shapes and error modes. Splitting makes each file a focused <130 lines module.

**`pipeline.ts` (861 → 6 files)**: The monolithic handler contains worktree lifecycle, agent dispatch, status transitions, hook wiring, PR creation, and notification building. Extracting into focused modules with a thin orchestrator keeps each file <180 lines.

### Typed GitHub Client

Replace the `Promise<any>` returns with a typed pattern:

```typescript
// github/types.ts
export interface GhClient {
	gh(
		pi: ExtensionAPI,
		args: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string>;
	ghJson<T = unknown>(
		pi: ExtensionAPI,
		args: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<T | null>;
	ghGraphQL<T = unknown>(
		pi: ExtensionAPI,
		query: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<T | null>;
}
```

Each GraphQL query defines a result interface. Callers use `ghGraphQL<ProjectFieldsResponse>(pi, query)` and get typed results. No `as any` needed at call sites.

### Tools

No new tools. The `/supervisor` command remains the sole entry point. No tool signature changes.

### Lifecycle Hooks

No changes. The extension only registers two message renderers and one command — all stay intact.

| Event | Action                                                                          |
| ----- | ------------------------------------------------------------------------------- |
| —     | No lifecycle subscriptions. `registerMessageRenderer` + `registerCommand` only. |

### State Management

No changes. State persists via `supervisor-summary` and `supervisor` customType messages through `pi.sendMessage()`. Session entries not used.

### Error Handling

| Error Scenario                     | Handling                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GraphQL parse/network failure      | `catch (err: unknown)` → `err instanceof Error ? err.message : String(err)` → notify user + stop pipeline |
| gh CLI error (auth missing, scope) | `gh()` throws with stderr → caught, scopes checked, user notified                                         |
| Worktree creation failure          | Retry without `-b` flag, then idempotent if exists                                                        |
| CI timeout                         | Configurable `ciGatingTimeoutSec`, default 300s, graceful skip                                            |
| Agent budget exceeded              | Pipeline stops, no retry, result collected                                                                |
| Agent failure                      | One retry, then pipeline stops                                                                            |

## Implementation Details

### Dependencies

No new npm packages. Existing imports unchanged:

- `@earendil-works/pi-coding-agent` — ExtensionAPI, SDK utilities
- `@earendil-works/pi-ai` — model resolution
- `node:fs`, `node:path`, `node:os`, `node:util` — Node built-ins

### Key TypeScript Interfaces (New or Changed)

```typescript
// github/types.ts — typed GraphQL response wrappers
export interface ProjectFieldsResponse {
	data?: {
		viewer?: {
			projectV2?: {
				fields?: {
					nodes?: Array<{
						id: string;
						name: string;
						dataType?: string;
						options?: Array<{ id: string; name: string }>;
					}>;
				};
			};
		};
	};
	errors?: Array<{ message: string }>;
}

export interface ProjectItemsResponse {
	data?: {
		viewer?: {
			projectV2?: {
				items?: {
					pageInfo: { hasNextPage: boolean; endCursor: string | null };
					nodes?: Array<{
						id: string;
						content?: { url?: string; number?: number };
						fieldValues?: {
							nodes?: Array<{
								name?: string;
								text?: string;
								field?: { id: string; name: string };
							}>;
						};
					}>;
				};
			};
		};
	};
	errors?: Array<{ message: string }>;
}

// session-events.ts — typed event param
export interface SessionEvent {
	type: string;
	toolName?: string;
	toolCallId?: string;
	args?: Record<string, unknown>;
	partialResult?: unknown;
	result?: unknown;
	isError?: boolean;
	// ... other fields as needed
}
```

### File-by-File Breakdown

#### Phase 1: `github/` extraction

| File                  | Purpose                                                                                                            | ~Lines | Depends On                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ------ | ------------------------------- |
| `github/types.ts`     | GhClient interface, GraphQL response types                                                                         | 60     | none                            |
| `github/gh-client.ts` | `gh()`, `ghJson<T>()`, `ghGraphQL<T>()` with typed returns                                                         | 50     | `./types.ts`                    |
| `github/project.ts`   | getProjectFields, getProjectItems, getProjectId, findIssueItem, getItemStatusName, findStatusOption, setItemStatus | 150    | `./gh-client.ts`, `../types.ts` |
| `github/deps.ts`      | checkBlockedByDependencies, parseTimelineResponse                                                                  | 70     | `./gh-client.ts`, `../types.ts` |
| `github/pr.ts`        | checkPrConflicts, createPullRequest                                                                                | 80     | `./gh-client.ts`, `../types.ts` |
| `github/comment.ts`   | postIssueComment, extractAgentCommentBody, extractStructuredAuditOutput, buildAuditCommentFallback                 | 90     | `./gh-client.ts`                |
| `github/git.ts`       | commitChanges, pushBranch, commitAndPush                                                                           | 60     | `../types.ts`                   |

#### Phase 2: `pipeline/` extraction

| File                        | Purpose                                              | ~Lines | Depends On                                              |
| --------------------------- | ---------------------------------------------------- | ------ | ------------------------------------------------------- |
| `pipeline/index.ts`         | `registerSupervisorCommand()` — thin entry           | 15     | `./handler.ts`                                          |
| `pipeline/worktree.ts`      | createWorktree, cleanupWorktree, installWorktreeDeps | 80     | `github/git.ts`, `config.ts`                            |
| `pipeline/stages.ts`        | Agent dispatch, marker matching, status transition   | 120    | `./worktree.ts`, `github/project.ts`, `agent-runner.ts` |
| `pipeline/hooks.ts`         | CI/TSC/LSP pre-transition checks                     | 60     | `pipeline-audit.ts`, `ci-gating.ts`                     |
| `pipeline/pr-creation.ts`   | PR creation after audit → Done                       | 100    | `github/pr.ts`, `github/git.ts`, `pipeline-output.ts`   |
| `pipeline/notifications.ts` | Build summary, status updates, bell                  | 70     | `formatting.ts`, `pipeline-output.ts`                   |
| `pipeline/handler.ts`       | Main loop orchestrator (imports all above)           | 180    | All `pipeline/*` modules, `github/` modules             |

#### Phase 3: Fix anti-patterns

| File                      | Change                                                                                 | ~Lines          |
| ------------------------- | -------------------------------------------------------------------------------------- | --------------- |
| `github/types.ts`         | Add typed return wrappers                                                              | +60             |
| `session-events.ts`       | Change `(ev: any)` → `(ev: SessionEvent)`                                              | <5              |
| `agent-session-runner.ts` | Replace `as any` with typed cast or type guard                                         | <5              |
| `pipeline-audit.ts`       | Replace `as any` with typed accessor                                                   | <5              |
| `pipeline/handler.ts`     | Replace `execWithSignal` with `pi.exec()`                                              | -30 (less code) |
| `pipeline/handler.ts`     | Replace `existsSync` → `fs.promises.access`, `writeFileSync` → `fs.promises.writeFile` | <10             |
| `config.ts`               | Keep `readFileSync` (module-level config loading, acceptable pattern)                  | no change       |

### Test Strategy

| Area                   | Strategy                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- |
| `github/types.ts`      | Unit test typed GraphQL response parsing (mock JSON in, typed interface out) |
| `github/gh-client.ts`  | Integration test with gh CLI mock                                            |
| `pipeline/stages.ts`   | Unit test marker matching, status resolution (pure logic, no io)             |
| `pipeline/worktree.ts` | Minimal — git worktree ops are inherently integration. Mock `pi.exec()`      |
| `session-events.ts`    | Unit test typed event processing (already has test pattern in test files)    |

### Backward Compatibility

| Contract                                       | Preserved? | Notes                          |
| ---------------------------------------------- | ---------- | ------------------------------ |
| `/supervisor <issue-number>` command           | ✅         | Same name, same args           |
| `supervisor` config key                        | ✅         | Same shape                     |
| `customType: "supervisor"` messages            | ✅         | Same renderer                  |
| `customType: "supervisor-summary"` messages    | ✅         | Same renderer                  |
| Status markers (`ARCHITECTURE_COMPLETE`, etc.) | ✅         | No change                      |
| Agent file format (`.md` frontmatter)          | ✅         | No change                      |
| Worktree directory structure                   | ✅         | Same path logic                |
| Output formatting                              | ✅         | Same text, same TUI            |
| `gh` CLI auth                                  | ✅         | Same `pi.exec("gh",...)` calls |

## Best Practices Compliance

| Rule                                       | Status  | Notes                                                                             |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------------- |
| No `any` on API boundaries                 | ⚠️ → ✅ | Fix `ghJson`/`ghGraphQL` returns + `session-events.ts` param                      |
| `details` uses `Record<string, unknown>`   | ✅      | Already uses `satisfies SupervisorMessageDetails`                                 |
| State encapsulated in closure              | ✅      | Minimal module state (`_extToolsCache` only)                                      |
| Explicit return type annotations           | ✅      | All functions annotated                                                           |
| No sync I/O at module init                 | ⚠️      | `readFileSync` in `config.ts` but only at call time, not module load — acceptable |
| `AbortController` for spawn timeout        | ✅      | Already uses AbortController pattern                                              |
| Child process `error` events handled       | ✅      | Through `pi.exec()` error checking                                                |
| `catch` uses `instanceof Error`            | ⚠️      | Fix `agent-runner.ts:43` `catch (err)` → `catch (err: unknown)`                   |
| `import()` not `require()`                 | ✅      | Already compliant                                                                 |
| Discriminated unions for events            | ⚠️      | Add typed `SessionEvent` union instead of `any`                                   |
| Files < 300 lines, entry < 100 lines       | ⚠️ → ✅ | Split `pipeline.ts` (861) and `github.ts` (751)                                   |
| No circular imports                        | ✅      | Tree flows types → utils → modules → orchestrator → entry                         |
| Entry point is registrations only          | ✅      | `index.ts` already 17 lines, pure registrations                                   |
| M8: Signature changes update all consumers | ✅      | No param changes planned — new modules re-export same signatures                  |

## Migration Plan

### Step-by-Step

```
Phase 1: github/ extraction (no functional change)
  1. Create `github/types.ts` — GhClient interface + response types
  2. Create `github/gh-client.ts` — typed ghJson<T>/ghGraphQL<T>
  3. Extract `github/project.ts` — project board ops
  4. Extract `github/deps.ts` — dependency gate
  5. Extract `github/pr.ts` — PR operations
  6. Extract `github/comment.ts` — comment posting
  7. Extract `github/git.ts` — git operations
  8. Create `github/index.ts` — re-export all
  9. Update `pipeline.ts` imports to `./github/project.ts` etc.
  10. Verify: `/supervisor <issue>` works
  11. Delete `original github.ts`

Phase 2: pipeline/ extraction (no functional change)
  1. Create `pipeline/worktree.ts`
  2. Create `pipeline/stages.ts`
  3. Create `pipeline/hooks.ts`
  4. Create `pipeline/pr-creation.ts`
  5. Create `pipeline/notifications.ts`
  6. Create `pipeline/handler.ts` — thin orchestrator
  7. Update `pipeline/index.ts` — re-export handler
  8. Verify: `/supervisor <issue>` works

Phase 3: Anti-pattern fixes (no functional change)
  1. Fix `ghJson<T>` / `ghGraphQL<T>` — typed generic returns
  2. Fix `session-events.ts` — typed event union
  3. Fix `agent-session-runner.ts` — replace `as any`
  4. Fix `pipeline-audit.ts` — replace `as any`
  5. Replace `execWithSignal` with `pi.exec()` in handler
  6. Replace sync I/O (`existsSync` → `fs.promises.access`)
  7. Verify: type check passes (`npm run tsc:extensions`)
```

### Rollback Plan

- Keep original `github.ts` and `pipeline.ts` until Phase 1 and 2 verification pass
- If type check fails: diff the new module against original, fix imports
- If runtime breaks: revert by restoring old files, removing new directories
- Each phase is independently verifiable — do not merge phases

## Delivery

PRD complete. Ready to implement or create GitHub issue.

What next?
