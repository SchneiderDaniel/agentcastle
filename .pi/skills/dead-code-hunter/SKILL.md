---
name: dead-code-hunter
description: Systematic dead code detection for pi extensions. Picks random extension, analyzes for unused exports, unreachable paths, dead branches, orphaned utilities, and other dead code patterns. Validates with proof, creates GitHub issue. Use before releases or when auditing extension quality.
metadata:
  detection-techniques: unused-exports,unreachable-code,dead-branches,unnecessary-conditionals,duplicate-code,unused-params,orphaned-imports,empty-blocks,dead-event-handlers,redundant-paths,zombie-dependencies
  proof-standard: cross-reference-two-sources
  confidence-levels: 100pct-certain,90pct-strong,60pct-likely
---

# Dead Code Hunter

Systematic dead code hunter for pi extensions. **Hunt until dead code found.** Each invocation picks random extension, analyzes using structured techniques, validates with proof, files GitHub issue. If no dead code found in selected extension, discard it and pick another. Repeat until one finding is confirmed and filed.

## How It Works

### Phase 1 — Random Selection + Hunt Loop

This is a **hunt loop**. Core instruction: **keep hunting until you file at least one finding.**

```
loop:
  1. Pick random extension from .pi/extensions/ (skip previously picked)
  2. Run Phase 1.5 (knip preliminary scan)
  3. If knip found dead code → file GitHub issue (Phase 5) → exit loop
  4. If knip found nothing or errored → run Phase 2-4 (understand + hunt + validate)
  5. If dead code found AND proof confirmed → file GitHub issue (Phase 5) → exit loop
  6. If no dead code found → log reason, goto loop start (pick next extension)
  7. If ALL extensions exhausted with zero findings → output "Hunt complete: 0 dead code findings across all extensions"
```

**Critical rule:** Do NOT lower proof standards when hunt gets long. A finding without proof is not a finding. Skip and move on.

**Deterministic proof required:** All proof must come from deterministic tools (`ripgrep_search`, `structural_search`, manual code trace) — never from asking the LLM "is this code dead?" If you cannot find a `ripgrep_search` match or trace the control flow with certainty, the finding is speculative and must be skipped.

### Phase 1a — Random Selection

Pick one extension from `.pi/extensions/` using `bash ls`. Prefer subdirectory extensions (they contain multiple files, more surface area). Single-file `.ts` extensions also eligible. Do NOT pick same extension twice in a row within same invocation.

Selection method:

```bash
ls -d /home/miria/git/main/.pi/extensions/*/   # subdirectory extensions
ls /home/miria/git/main/.pi/extensions/*.ts     # single-file extensions
```

Pick randomly. Document which extension selected and why (e.g. "largest file count" or "most recently modified").

### Phase 1.5 — Knip Preliminary Scan

Before manual analysis, run Knip — an automated dead-code detection CLI. Knip analyzes the module graph (imports/exports) to find unused exports, unused dependencies, unused files, and duplicate exports. It runs in seconds and provides deterministic output that can be filed directly as an issue.

**Knip cannot detect:** unreachable code (after return/throw), dead branches (constant conditions), empty blocks, unnecessary conditionals, unused function parameters, orphaned imports within a file, dead event handlers, redundant code paths, or duplicate code blocks. These patterns require the manual Phase 2-4 detection techniques below.

#### Step 1: Run Knip

Run Knip against the selected extension directory using the root tsconfig:

```bash
npx knip --tsConfig /home/miria/git/main/tsconfig.json --include-entry-exports --directory /home/miria/git/main/.pi/extensions/<name>/
```

Flags:
- `--tsConfig /home/miria/git/main/tsconfig.json` — always use root tsconfig (extends `.pi/tsconfig.json`); extension directories do not have their own tsconfig
- `--directory` — scope analysis to the extension directory (knip v6 uses `--directory` flag, not positional argument)
- `--include-entry-exports` — also check exports of entry files, not just internal exports; ensures comprehensive coverage of extension internals
- No configuration file — knip uses defaults

#### Step 2: Parse Knip Exit Code and Output

Knip exit codes:
- **0** — no issues found. If exit 0 with no output → no findings. Fall through to Phase 2 (manual detection).
- **1** — lint issues found (unused exports, unused deps, etc.). Proceed to Step 3.
- **2** — execution error (bad input, missing dependency, internal failure). Fall back to Phase 2-4 manual detection. Do NOT abort the hunt.

Capture both exit code and stdout/stderr:

```bash
npx knip --tsConfig /home/miria/git/main/tsconfig.json --include-entry-exports --directory /home/miria/git/main/.pi/extensions/<name>/ 2>&1; echo "EXIT_CODE=$?"
```

#### Step 3: File Issue for First Finding

If knip exits with code 1 and produces findings:

1. **One finding per issue rule applies** — take only the FIRST finding from knip output (the first `file:line:col` line). Do NOT file multiple findings from a single knip run.
2. **Use the existing issue template** from Phase 5 — same structure, same severity guide (P0-P3).
3. **Technique** — set to `knip` (instead of a numbered technique).
4. **Confidence** — always **90%** for knip findings. Knip is reliable for statically-resolvable code (module graph analysis) but may have false positives for dynamically-invoked code (e.g., `Reflect.get()`, plugin loading by name string, dynamic import specifiers).
5. **Severity** — use the same severity guide (P0-P3) based on finding type and impact.
6. **Proof section** — replace the cross-reference search output with:
   ```
   ### Cross-Reference Proof

   Knip output:
   <raw knip output from stdout, first finding only>
   ```
7. **Issue creation** — follow Phase 5 instructions for `gh issue create`.

If knip produces multiple findings, file only the first one. Subsequent findings require separate hunt invocations.

#### Step 4: Fall Through to Manual Detection

If knip:
- Exits with code 0 (no findings), OR
- Exits with code 2 (execution error), OR
- Exits with code 1 but you choose to skip the finding (e.g., suspected false positive)

→ proceed to **Phase 2 (Code Understanding)** and continue with manual detection techniques. Knip only detects module-graph-level dead code; patterns like unreachable code, dead branches, empty blocks, unused parameters, orphaned imports, dead event handlers, and redundant paths require the manual techniques in Phase 3.

**Important:** If knip finds a finding and you file it, the hunt loop exits (per Phase 1: "keep hunting until you file at least one finding"). If you skip the knip finding, fall through to manual detection.

### Phase 2 — Code Understanding

Read the full extension before hunting. Use `read` to load all files.

For subdirectory extensions:

```bash
ls -la /home/miria/git/main/.pi/extensions/<name>/
read /home/miria/git/main/.pi/extensions/<name>/index.ts
read /home/miria/git/main/.pi/extensions/<name>/<other-files>.ts
```

For single-file extensions:

```bash
read /home/miria/git/main/.pi/extensions/<name>.ts
```

Understand:

- Purpose (what does it register? tool? command? event handler?)
- API surface (tool name, params, returns, events subscribed)
- Call graph (which functions call which, which exports consumed where)
- Dependencies (imports from pi packages, npm packages, node built-ins)
- Control flow (conditionals, loops, early returns, switch/case)
- Module structure (exports, re-exports, barrel files)
- **Package manifest** — check `package.json` for declared dependencies. These may have no actual imports (zombie deps).

**Dynamic code awareness:** Note any metaprogramming patterns (Reflect.construct, Proxy, dynamic imports with import(), Object.keys iteration over functions, getattr-like patterns). These can make statically-detected dead code actually alive at runtime. Flag at lower confidence when these patterns exist.

### Phase 3 — Dead Code Detection Techniques

Apply each technique below. For each, document what you checked and whether found anything. Assign a **confidence level** to each finding:

**Deterministic-first rule:** Every finding MUST be backed by either:

- A `ripgrep_search` showing zero references (for unused symbols/imports)
- A `structural_search` AST pattern match (for unreachable code / empty blocks)
- Manual traced control flow (line-by-line proof code path cannot execute)

Do NOT rely on asking the LLM "does this look dead to you?" — that is speculation, not evidence. If you cannot produce deterministic proof, skip the finding.

| Confidence | Meaning                                             | Typical for                                                     |
| ---------- | --------------------------------------------------- | --------------------------------------------------------------- |
| 100%       | Certain dead — code cannot execute or be referenced | Unreachable code after return/throw, function/method arg unused |
| 90%        | Strong evidence — dead unless dynamic invocation    | Unused import, zombie dependency                                |
| 60%        | Likely dead — may be framework-invoked              | Unused export, unused variable, empty block                     |

**Priority heuristic:** When multiple findings qualify, prefer filing:

1. Higher confidence first (100% > 90% > 60%)
2. Larger line count (more cleanup value)
3. More likely to cause confusion or bugs if modified

#### 1. Unused Exports / Functions / Variables

Check for exported symbols, functions, and variables that nothing references.

**Detection methods:**

```bash
# Check if a function/export is referenced outside its declaration file
ripgrep_search "myFunctionName" /home/miria/git/main/.pi/extensions/<name>/
```

- Search for each public function name — if only its declaration matches, it is unused
- Check private/helper functions — if only declaration + export line match, unused
- Module-level `const`, `let`, `var` not referenced outside initial assignment
- Parameters destructured but field never used in function body

**Patterns:**

```typescript
// UNUSED: exported but never imported by any other file
export function helper(data: string) { ... }

// UNUSED: variable assigned but never read
const MAX_RETRIES = 3;
// ... never referenced again

// UNUSED: destructured field never used
function process({ name, age, email }: User) {
  // only name and email used — age is dead
}
```

#### 2. Unreachable Code

Code paths that can never execute at runtime.

**Patterns:**

```typescript
// UNREACHABLE: after unconditional return
function getConfig() {
	return { color: "red" };
	const extra = loadExtra(); // never runs
}

// UNREACHABLE: after throw
function validate(input: string) {
	if (!input) throw new Error("required");
	return input.trim();
	console.log("validated"); // never runs
}

// UNREACHABLE: after break/continue in loop
for (const item of items) {
	if (item.skip) continue;
	process(item);
	break;
	cleanup(item); // never runs — break always before
}

// UNREACHABLE: both branches of if/else return
function getValue(n: number) {
	if (n > 0) return "positive";
	else return "non-positive";
	console.log("done"); // never runs
}

// UNREACHABLE: exhaustive switch with default before case
function handle(status: "ok" | "err") {
	switch (status) {
		default:
			return "unknown";
		case "ok":
			return "all good";
		case "err":
			return "error";
	}
	// switch always returns — anything after is dead
}
```

#### 3. Dead Branches — Conditionals That Never Vary

Conditions that are always true or always false, making one branch dead.

**Patterns:**

```typescript
// DEAD BRANCH: constant condition
const DEBUG = false;
if (DEBUG) {  // never enters — always false
  console.log("debug info");
}

// DEAD BRANCH: tautology / contradiction
if (items.length >= 0) {  // always true — length never negative

// DEAD BRANCH: always-true after null check chain
function process(items: string[]) {
  if (!items) return;  // items is string[], never undefined
}

// DEAD BRANCH: exhaustive enum/union check with impossible variant
type Status = "active" | "inactive";
function handle(s: Status) {
  if (s === "active") return "on";
  if (s === "inactive") return "off";
  if (s === "pending") return "wait";  // dead — not in type
}

// DEAD BRANCH: negated condition that's always false
function greet(name: string) {
  if (typeof name !== "string") {  // always false — TypeScript enforces
    return "invalid";
  }
}
```

#### 4. Unnecessary Conditionals

Conditions that always produce the same result.

**Patterns:**

```typescript
// REDUNDANT: identical branches
if (condition) {
	doSomething();
} else {
	doSomething(); // same as if branch
}
// Could be: doSomething()

// REDUNDANT: !! on boolean
function toggle(flag: boolean) {
	return !!flag; // !! is redundant on boolean-typed param
}

// REDUNDANT: ternary returning boolean literal
const result = condition ? true : false; // could be: const result = condition

// REDUNDANT: if-return-else-return
if (x > 0) return true;
else return false;
// Could be: return x > 0
```

#### 5. Duplicate Code

Identical or near-identical code blocks that should be unified.

**Patterns:**

```typescript
// DUPLICATE: same logic in two functions
function formatA(name: string): string {
	return `Hello, ${name}! Welcome.`;
}
function formatB(user: string): string {
	return `Hello, ${user}! Welcome.`;
}
// Only variable name differs — identical logic

// DUPLICATE: repeated condition chains
if (role === "admin") {
	grantAccess(role);
	return;
}
if (role === "admin") {
	auditLog(role);
}
// Two separate if-checks for same condition

// DUPLICATE: switch/case with same body
switch (color) {
	case "red":
	case "blue": // duplicate: both fall through to same handler expected
	case "green":
		processColor(color);
		break;
	case "red": // duplicate case
		processColor(color); // second copy of same handler
		break;
}
```

#### 6. Unused Parameters

Function parameters that are never read in the body. Also includes unused function/method arguments in callbacks, tool execute signatures, event handlers.

**Confidence: 100%** — If a parameter is declared but never read in the function body, it is certainly unused. Exception: only if the parameter is part of an interface/override contract where the parent signature requires it.

**Patterns:**

```typescript
// UNUSED PARAM: callback with unused context
function handler(event: Event, context: Context) {
  // context never read
  console.log(event.name);
}

// UNUSED PARAM: unused in tool execute signature
execute(toolCallId, params, signal, onUpdate, ctx) {
  // signal, onUpdate never used
  return process(params.name);
}

// UNUSED PARAM: unused in arrow function
items.map((item, index) => {
  // index never used
  return item.name;
});
```

#### 7. Orphaned Imports

Imports that are never referenced in the file body.

**Confidence: 90%** — Strong evidence but could be side-effect import (e.g. `import "module-alias"`) or re-exported. Verify both cases.

**Patterns:**

```typescript
// ORPHANED: import never used
import { readFile } from "fs/promises";
// ... never calls readFile

import path from "path";
// ... uses resolve but path import is for "path" — but if it's imported and
// no path.resolve() call exists, it's orphaned

// ORPHANED: type import with no type reference
import type { SomeConfig } from "./types";
// ... never uses SomeConfig in any type annotation
```

**Detection method:**

```bash
# For each import, search file for the imported symbol
ripgrep_search "symbolName" /home/miria/git/main/.pi/extensions/<name>/<file>.ts
# If only import line matches, it is orphaned
```

#### 8. Empty Blocks

Code blocks with no statements or only comments.

**Confidence: 60%** — Likely dead but may be intentional placeholder (TODO, future work, deliberate no-op). Check for explanatory comments before filing.

**Patterns:**

```typescript
// EMPTY: catch with no handling
try {
	await riskyOp();
} catch {
	// nothing
}

// EMPTY: if block with no body
if (condition) {
	// TODO
}

// EMPTY: function body empty
function noop() {}

// EMPTY: switch case with nothing
switch (x) {
	case 1:
	// intentional fallthrough (need comment)
	case 2:
		handleTwo();
}
```

#### 9. Dead Event Handlers / Tool Registrations

Event handlers or tool registrations that are never triggered or are overridden. Also includes code that is only invoked implicitly by pi framework (the pi-invocation pattern).

**Pi-specific whitelist:** The following patterns are pi framework invocations — do NOT flag code reachable only through these as dead:

- `pi.on(event, handler)` — handler invoked by pi runtime
- `pi.registerTool({ ... })` — tool execute invoked by pi runtime
- `pi.exec()` — child process execution
- `ctx.events.on(...)` — event listener set up by extension
- Any export consumed via pi extension manifest

**Confidence:**

- Event/tool handler body: 60% (framework-invoked, may be dead if never triggered)
- pi.on with non-existent event name: 100% (certainly dead)
- Tool with no prompt reference AND no external docs: 90% (very likely dead)

**Patterns:**

```typescript
// DEAD: handler registered but event never emitted by anything
pi.on("never_emitted_event", async (event, ctx) => { ... });

// DEAD: two handlers for same event, first is shadowed
pi.on("tool_call", handlerA);
pi.on("tool_call", handlerB);  // A is dead — B wins / both run but A's effect undone

// DEAD: tool registered but never used by any prompt or flow
pi.registerTool({ name: "old_feature", ... });
// No prompt references "old_feature"

// DEAD: subscription never cleaned up, handler no longer valid
const cleanup = ctx.events.on("message", handler);
// cleanup never called — handler still fires but should be dead
```

#### 10. Redundant / Dead Code Paths

Code that exists but has no functional effect.

**Confidence: 90%** — Strong evidence unless the dead computation is intentional (e.g. calling a function for side effect but discarding its return value).

**Patterns:**

```typescript
// DEAD PATH: assignment to local var that is never read
function compute(n: number) {
	let temp = n * 2;
	return n + 1; // temp never used
}

// DEAD PATH: reassignment before first read
let value = getDefault();
value = getReal(); // first assignment is dead — overwritten before read

// DEAD PATH: unused return value
function save(data: string): boolean {
	// ... persist ...
	return true;
}
save("hello"); // return value discarded — intentional? If so, why return?

// DEAD PATH: variable set but only mutated, never read
let cache = new Map<string, Result>();
function lookup(key: string) {
	// cache has entries set but never .get() called anywhere
	cache.set(key, compute(key));
	// never read from cache
}

// DEAD PATH: dead code in disabled conditional
if (false) {
	// This block never runs — deprecated feature?
	legacyProcess(data);
}
```

#### 11. Zombie Dependencies

Packages declared in `package.json` but never imported in any source file. These bloat install size, increase attack surface, and mislead developers about actual dependencies.

**Confidence: 90%** — Strong evidence. Only skip if the package is a build tool, type package (@types/\*), or used via CLI command (not import).

**Detection method:**

```bash
# List declared dependencies from package.json
grep -E '"@[a-z]|"\w+' /home/miria/git/main/.pi/extensions/<name>/package.json | grep -v devDependencies

# For each package, search all extension files for its import
ripgrep_search "from 'package-name'" /home/miria/git/main/.pi/extensions/<name>/
ripgrep_search "require('package-name')" /home/miria/git/main/.pi/extensions/<name>/
```

Also check if the package is referenced in any configuration file (tsconfig, webpack, jest config, etc.) or used via CLI in npm scripts.

**Patterns:**

```typescript
// ZOMBIE: package.json declares axios but no file imports it
// package.json: "axios": "^1.6.0"
// No "from 'axios'" or "require('axios')" anywhere

// ZOMBIE: devDependency with no usage
// package.json: { "devDependencies": { "mocha": "^10.0.0" } }
// But tests are in separate test dir or mocha not in scripts

// ZOMBIE: cli tool that could be npx
// "typescript": "^5.0.0" in dependencies when tsc is only run via npx

// ALIVE: @types/node — skip, type package
// ALIVE: rimraf used in scripts section only — skip if build-only
// ALIVE: package used only in CLI commands
```

### Phase 4 — Finding Validation (Proof Requirement)

Every suspected dead code finding MUST have deterministic proof. Rule: **"Cross-reference two sources"** — two independent confirmations before filing.

**No LLM-opinion evidence:** Evidence must come from deterministic sources — tool output (`ripgrep_search`, `structural_search`), code trace (control flow analysis), or file contents (import/export graph). Asking "does this look dead?" is not evidence. If both cross-references are LLM opinions, the finding does not meet the proof standard.

#### Proof Checklist

Each finding must include ALL of:

1. **Code evidence** — Exact line(s) showing dead code
   ```
   File: path/to/file.ts, line 42-45
   ```
2. **Why it is dead** — Explanation of why code never executes or is unreferenced
   ```
   Function `helper()` is defined at line 42 but never imported or called
   anywhere in the extension. ripgrep_search confirms zero references outside
   its declaration.
   ```
3. **Cross-reference proof** — Search result showing no callers / no reachability
   ```bash
   # grep for the symbol across the whole extension
   ripgrep_search "helper" /home/miria/git/main/.pi/extensions/<name>/
   # Output: only matches are declaration and export — no call sites
   ```
   Include the actual search output or summary in report.
4. **Confidence score** — Assign 60/90/100% based on technique type and verification depth
   ```
   Confidence: 90% — ripgrep_search confirms zero references outside declaration.
   ```
5. **Impact assessment** — Maintenance burden, confusion risk, bundle size, line count
   ```
   Impact: Low (12 lines) — unused export misleads future developers but no runtime harm.
   OR
   Impact: Medium (45 lines) — dead branch means safety check is never reached.
   ```

#### False Positive First Aid

Before filing, run through this checklist to reduce false positives:

1. **Is the code pi-framework-invoked?** — Check if the code is reached via `pi.on()`, `pi.registerTool()`, `ctx.events.on()`, or extension manifest exports. If yes, flag at 60% confidence or skip.
2. **Is it a side-effect import?** — `import "module-alias"` or `import "./polyfill"` intentionally has no symbol reference. Skip.
3. **Is it a dynamic invocation?** — `Reflect.get(obj, "methodName")`, `obj[methodName]()`, `Function.prototype.apply.call()`. These can make statically-dead code alive. Skip unless you can trace the dynamic call.
4. **Is it a debug flag pattern?** — `if (false)` should be `if (DEBUG)` where DEBUG is a configurable flag. Skip if the pattern is intentional for debugging.
5. **Is it an intentional placeholder?** — Empty function with TODO comment, empty catch with explanatory comment. Skip.
6. **Is it an override contract?** — Unused parameter in a function that implements an interface or overrides a parent class. Skip (convention: `_unused` prefix).
7. **Is it a forward reference for type annotations?** — `from __future__ import annotations` or string-type annotations `foo: "Sequence"`. Skip.
8. **Is it re-exported?** — Check if the symbol is re-exported via `export { symbol } from` or barrel file. If yes, the export is used even if the local reference is not.

#### When Proof Is Insufficient

If code is ambiguous (possible false positive), skip it. Do not file speculative findings. When unsure, re-read the full file to trace the execution path. If still unsure, skip.

Key validation rules:

- **Unused export**: Must grep entire extension directory. If found in tests or config, still counts (only non-test code matters). If found in another production file, it is used → skip.
- **Unreachable code**: Must trace control flow to prove no path reaches the line. Check all callers.
- **Dead branch**: Must prove condition never varies at runtime. Check if variable is ever assigned elsewhere.
- **Empty block**: Must confirm no side effects expected. Check TODO comments — if intentional placeholder, skip.
- **Orphaned import**: Must check import is not re-exported or used as type in another context.
- **Zombie dependency**: Must check all files in extension, not just one. A package may be imported in a different file than where it appears.

### Phase 5 — GitHub Issue Creation

Only create issue after proof is complete. Use `gh issue create` via `bash gh`.

#### Issue Template

```
**Extension:** <name>
**Technique:** <technique that found this>
**Confidence:** <60%/90%/100%>
**Severity:** <P0/P1/P2/P3>
**Lines:** <count of dead lines>

## Description
<clear description of the dead code, sorted by impact>

## Proof

### Code Evidence
```

File: path/to/file.ts, line N-M
<code snippet showing dead code>

```

### Why It Is Dead
<explanation of why this code is not reachable or not used>

### Cross-Reference Proof
```

<search output showing no references / no reachability>

```

### Confidence Assessment
<why this is 60/90/100% and what edge cases were ruled out>

### Impact
<maintenance burden, confusion risk, bundle size, line count>

## Suggested Fix
<optional: suggested code change — removal, refactor, or guard>
```

#### Severity Guide for Dead Code

| Severity | Criteria                                                                         |
| -------- | -------------------------------------------------------------------------------- |
| P0       | Dead code causes incorrect behavior (e.g. dead safety check, dead error handler) |
| P1       | Dead code creates security surface (e.g. unused API endpoint, dead auth check)   |
| P2       | Dead code creates maintenance burden or confusion (unused export, dead branch)   |
| P3       | Cosmetic / trivial (empty block with comment, unused private var)                |

#### Issue Creation Command

```bash
# Write body to temp file to avoid shell escaping issues
cat > /tmp/dead-code-report-<ext-name>.md << 'EOF'
<body content>
EOF

gh issue create \
  --repo "$(grep -o '"repo"[^,]*' /home/miria/git/main/.pi/settings.json | tail -1 | sed 's/.*"repo": *"\([^"]*\)".*/\1/')" \
  --title "Dead Code: <ext-name> - <short description>" \
  --label "dead-code" \
  --body-file /tmp/dead-code-report-<ext-name>.md

# Clean up
rm /tmp/dead-code-report-<ext-name>.md
```

Read repo from `.pi/settings.json`:

```bash
grep -o '"repo"[^,]*' /home/miria/git/main/.pi/settings.json | tail -1 | sed 's/.*"repo": *"\([^"]*\)".*/\1/'
```

#### Labels

Always add `dead-code` label. Add severity label if exists in repo: `severity:high`, `severity:medium`, `severity:low`. If `dead-code` label does not exist on repo, use `bug` instead.

#### Existing Issues Check

Before creating issue, check if similar dead code already reported:

```bash
gh issue list --repo <repo> --label dead-code --state open --json title --limit 30 \
  | grep -i "<keyword>"
```

If duplicate found, skip and note which issue. Also check `bug` label issues for keywords.

### Phase 6 — Report

After hunt loop completes (either finding filed or all extensions exhausted), output summary:

```
## Dead Code Hunt Report

**Extension:** <name>
**Files analyzed:** <count>
**Total lines:** <approximate>
**Techniques applied:** <all 11>

### Findings

| # | Technique | Type | Confidence | Severity | Lines | Filed? |
|---|-----------|------|------------|----------|-------|--------|
| 1 | unused-exports | Unused function | 90% | P2 | 15 | [#123](url) |
| 2 | unreachable-code | Code after return | 100% | P3 | 3 | [#124](url) |

### Summary
<total findings, total filed, any skips with reason>
```

## Rules

1. **Hunt until found** — Must loop through extensions until one finding filed or all exhausted. Do not stop after first extension if nothing found.
2. **ONE finding per issue** — No batching multiple dead code findings in one issue
3. **Proof or skip** — No speculative findings. Ambiguous = skip
4. **Cross-reference two sources** — code evidence + why dead + search proof minimum
5. **No duplicate** — Check existing open issues first
6. **File cleanup** — Delete temp files after issue creation
7. **Track picked extensions** — Maintain list of picked extensions this run. Never re-pick same extension within one invocation.
8. **LLM is the hunter** — Do NOT delegate analysis to tools. Read code directly, reason about it. However, use deterministic tools for proof — do not ask yourself "is this code dead?" and accept your own answer as evidence. That is speculation, not proof.
9. **Structural search allowed** — Use `structural_search` for AST patterns (try/catch, if/else, switch/case, unreachable after return)
10. **Literal search allowed** — Use `ripgrep_search` for text patterns (symbol references, import usage, function calls)
11. **No false positives** — If you cannot prove code is dead by tracing the code path, do not file it. Low bar means skip extension entirely.
12. **All exhausted = report** — If every extension checked and zero dead code found, output full report stating that. No fabricated findings.
13. **Orphaned import nuance** — Some imports are side-effect-only (e.g. `import "module-alias"` or `import "./polyfill"`). These are intentional and should be skipped.
14. **Zombie dependency nuance** — Check `package.json` for unused npm packages. A package declared but never imported in any file is a zombie. Cross-check with `ripgrep_search` across all extension files.
15. **Confidence not negotiable** — If you cannot confidently classify a finding, do not file it. Prefer 100% findings over lower confidence ones when multiple options exist.
16. **Sort by impact** — When multiple 100% findings exist, file the one with largest line count or most confusing semantics. Bigger cleanup = better issue.
17. **Deterministic over LLM** — Always use `ripgrep_search`, `structural_search`, or manual code tracing to prove dead code. Do NOT ask the LLM (yourself) "is this code dead?" — that is speculation. Real proof requires a tool output or traced control flow. The only exception is confidence scoring (60/90/100%), which is a heuristic, not evidence.

## Reference

See [references/dead-code-detection.md](references/dead-code-detection.md) for detailed technique descriptions with code patterns and search strategies.
