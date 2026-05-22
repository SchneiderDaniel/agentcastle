---
description: Surface architectural friction in a codebase or submodule and file as a GitHub issue with deepening opportunities.
argument-hint: "<target>"
---

# Improve Codebase Architecture

Find shallow modules in a target codebase and propose deepening refactors. Creates an **umbrella GitHub issue** listing all candidates with Mermaid diagrams, plus one **sub-issue per candidate** with full card (dependency category, testing strategy).

## Glossary

Use these terms exactly in every suggestion. See [HTML-REPORT.md](../reference/improve-codebase-architecture/HTML-REPORT.md) for vocabulary rules.

- **Module** — anything with an interface and an implementation.
- **Interface** — everything a caller must know (types, invariants, error modes, ordering, config).
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: much behaviour behind a small interface.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place.
- **Adapter** — concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth.
- **Deletion test** — imagine deleting the module. If complexity vanishes it was a pass-through. If complexity reappears across callers, it earned its keep.

## Target

The argument after the command specifies what to analyze.

```
/improve-codebase-architecture <target>
```

| Target | What it analyzes |
|--------|-----------------|
| `root` (or omitted) | Main repo (agentcastle) |
| `<submodule-name>` | Submodule by name (resolved from `.gitmodules`) |
| `<any-path>` | Arbitrary directory |

**Resolution:** The user message will contain the target as `User: <target>`. Parse it. If `target` matches a submodule name in `.gitmodules`, resolve to that submodule's `path`. Otherwise treat as relative directory from repo root.

## Workflow

### 1. Resolve target

Read `.gitmodules` from project root. Parse submodules. Match target against submodule `name` entries. Resolve to the submodule's `path`.

If target is `root` or omitted, use project root (`.`).

### 2. Explore

Use Pi tools to walk the target codebase:

- `map_codebase` — symbol tree: classes, functions, variables
- `ripgrep_search` — hardcoded strings, magic numbers, leaky dependencies
- `structural_search` — call chains, tightly-coupled patterns, deep nesting
- `read` — inspect module interfaces directly

Explore organically. Note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal.

### 3. Create umbrella issue with all candidates

Create one umbrella GitHub issue listing all candidates.

**Issue title:** `Architecture Review: <target-name> — <YYYY-MM-DD>`

**Issue labels:** Always `architecture`. If target is a submodule (resolved from `.gitmodules`), also add the submodule name as a label — create it with `gh label create <name>` if it doesn't exist.

**Issue body (umbrella):** One candidate per `###` section with summary card (files, problem, solution, wins, Mermaid diagram) plus top recommendation at the end. See [HTML-REPORT.md](../reference/improve-codebase-architecture/HTML-REPORT.md) for diagram patterns, style guidance, and vocabulary rules.

```markdown
## Candidates

### 1. <short title> [Strong]
**Files:** `path/to/file1.py`
**Problem:** One sentence.
**Solution:** One sentence.
**Wins:** Bullets in glossary terms.

```mermaid
flowchart LR
  subgraph Before ...
  subgraph After ...
```

---

### 2. <short title> [Worth exploring]
...

## Top Recommendation
...
```

### 4. Create one sub-issue per candidate

For each candidate, create a separate GitHub issue with its **full card** — everything from the umbrella entry plus:
- **Dependency category** (from [DEEPENING.md](../reference/improve-codebase-architecture/DEEPENING.md)) — e.g. `in-process`, `local-substitutable`, `ports & adapters`, `mock`
- **Testing strategy** — what old tests become waste, what new tests look like, where the test surface sits
- Title prefix: `ICA: <candidate short title>`
- Body begins: `Part of **Architecture Review: <target-name>** (#N)` where N is the umbrella issue number
- Same labels as umbrella (`architecture` + submodule name)

### 5. Link and board

1. Comment on umbrella issue with table listing all sub-issues
2. Add all issues (umbrella + sub-issues) to project board with status `Research`
3. Use `gh project item-edit` or GraphQL mutation to set status field

### 6. Completion

Print all issue URLs. Tell the user:

> Architecture review filed. Umbrella: **#N**. Sub-issues: **#A**, **#B**, **#C**, **#D**. Use `/issue-refinement <number>` on any candidate, then `/supervisor <number>` to implement.

## Reference files

- [DEEPENING.md](../reference/improve-codebase-architecture/DEEPENING.md) — Dependency categories, seam discipline, testing strategy
- [HTML-REPORT.md](../reference/improve-codebase-architecture/HTML-REPORT.md) — Report format, diagram patterns, style guidance, vocabulary rules
