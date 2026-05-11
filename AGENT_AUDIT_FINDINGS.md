# Agent Definition Contradiction Audit

**Date**: 2026-05-11  
**Scope**: `.pi/agents/` — all five agent definitions  
**Purpose**: Identify and fix contradictions in agent definitions that would cause incorrect agent behavior.

---

## Summary

| # | Agent | Severity | Type | Core Issue | Fixed |
|---|-------|----------|------|------------|-------|
| 1 | Auditor | 🔴 Critical | Contradiction | Extracts only first test block, told to run all | ✅ |
| 2 | TestDesigner | 🔴 Critical | Contradiction | Vertical slice vs layered structure conflict | ✅ |
| 3 | Auditor | 🟡 Warning | Undefined ref | "N+" threshold not defined in rejection template | ✅ |
| 4 | Researcher | 🟡 Warning | Role tension | "Validate" vs "never judge" boundary fuzzy | ✅ |
| 5 | Architect | 🟡 Warning | Scope tension | "Apply always" vs conditional "when to apply" | ✅ |
| 6 | Developer | 🟡 Warning | Hardcoded assumption | `flask_blogs` submodule assumed, no fallback | ✅ |
| 7 | Researcher | 🟡 Warning | Workflow gap | Validates final architecture, can't influence it | ✅ |
| 8 | TestDesigner | 🟡 Warning | Coordination gap | 5s core target + 60s total timeout, no coordination | ✅ |
| 9 | Auditor | 🟢 Suggestion | Naming | "Security" used for "Correctness & Safety" dimension | ✅ |
| 10 | Architect | 🟢 Suggestion | Redundancy | 3-way overlapping checklist items | Noted |
| 11 | Researcher | 🟢 Suggestion | Tool access | web_crawl via bash vs function call ambiguity | ✅ |
| 12 | TestDesigner | 🟢 Suggestion | Missing edge case | No instruction if architecture comment absent | ✅ |

**Total**: 12 findings — 2 critical, 6 warnings, 4 suggestions. All fixed except #10 (intentional multi-angle verification, kept as-is).

---

## Detailed Findings & Fixes

---

### 🔴 1. Auditor: Test command extraction vs execution contradiction

**File**: `auditor.md`, Step 3 ("Execute Tests")  
**Severity**: Critical

**Symptom**: Extraction logic says "find the **first** fenced code block... Extract the command(s) inside **it**." Then the same step says "If the test plan has multiple fenced code blocks... run **ALL** of them." Blocks 2+ are never extracted.

**Consequence**: Multi-suite test plans (domain + adapter + E2E) would only run one suite. Auditor approves implementations with untested layers.

**Fix**: Changed "find the first fenced code block" → "find ALL fenced code blocks." Changed "Extract the command(s) inside it" → "Extract the command(s) from each one." Added "Run ALL extracted commands. If multiple code blocks exist, execute each one in order."

```diff
-1. **Extract the test command:** Read the test plan comment and find the first fenced code block...
-   Extract the command(s) inside it.
+1. **Extract the test commands:** Read the test plan comment and find ALL fenced code blocks...
+   Extract the command(s) from each one.
...
-   - If the test plan has multiple fenced code blocks (for different test layers), run ALL of them
+   - Run ALL extracted commands. If the test plan has multiple code blocks (for different test layers),
+     execute each one in order.
```

---

### 🔴 2. TestDesigner: Vertical slice vs layered structure

**File**: `test-designer.md`  
**Severity**: Critical

**Symptom**: BMAD-METHOD principle demands "vertical slice testing — test each feature slice end-to-end before moving to the next slice." But the task template forces a layered structure (Entity → Use-case → Adapter → E2E). These are mutually exclusive organizational schemes.

**Consequence**: TestDesigner produces ambiguous plans. Developer gets conflicting test ordering guidance.

**Fix**: 
1. Renamed section "Test plan structure must reflect architecture layers" → "Test types by architecture layer (use these categories within each phase)" — keeps the taxonomy but removes the structural mandate.
2. Added: "Organize the test plan by implementation phase (vertical slices), not by layer."
3. Restructured the task template from layered sections to phase-gated sections with layer annotations within each phase.
4. Added fallback: "If no architecture comment is present... design tests based on issue requirements alone."

```diff
-**Test plan structure must reflect architecture layers:**
+**Test types by architecture layer (use these categories within each phase):**
 1. **Entity/domain tests** — pure logic, no I/O, instant
 2. **Use-case tests** — orchestration with faked ports, fast
 3. **Adapter/integration tests** — real infrastructure at seams, slower
 4. **End-to-end tests** — full stack, reserved for critical happy paths only
+
+Organize the test plan by implementation phase (vertical slices), not by layer.
+Within each phase, specify which layer-level test types apply.
```

Template changed from:
```
**Test plan structure (layered by architecture):**
- Entity/Domain tests — ...
- Use-case/Service tests — ...
- Adapter/Integration tests — ...
- End-to-end tests — ...
```

To:
```
**Test plan structure (phase-gated, vertical slices):**
Organize tests by implementation phase. Each phase is a vertical slice tested 
progressively before moving to the next.

For each phase, describe:
- Phase goal — what capability this phase delivers
- Domain/Entity tests (if phase touches domain)
- Use-case/Service tests (if phase touches orchestration)
- Adapter/Integration tests (if phase touches infrastructure)
- End-to-end smoke test (if phase delivers user-visible behavior)
```

---

### 🟡 3. Auditor: "N+" undefined in rejection template

**File**: `auditor.md`, rejection format  
**Severity**: Warning

**Symptom**: Rejection template says "Warnings (should fix — N+ warnings trigger rejection)" but N is never defined in that section. Threshold (3+) defined earlier but far from template.

**Fix**: Changed "N+ warnings" → "3+ warnings" directly in the template.

---

### 🟡 4. Researcher: "Validate" vs "never judge" boundary

**File**: `researcher.md`, role description + rules  
**Severity**: Warning

**Symptom**: Role says "You validate the architectural proposal" (implies judgment). Rules say "NEVER make architectural judgments." Boundary between "finding" and "judgment" is undefined.

**Fix**:
1. Role description changed from "validate" to "research" — "You research the architectural proposal's topic... You present findings that may confirm, challenge, or add context to the proposal — without making judgments."
2. Added workflow context: "If your findings reveal issues with the architecture, the supervisor may re-invoke the Architect to revise the design. You do not control this flow — you only provide data."
3. Rules expanded with concrete boundary: "Present findings as factual observations with source citations. If a finding conflicts with the architecture (e.g., deprecated library, known anti-pattern), present it as a verifiable fact with its source — the supervisor and Architect will decide how to act on it. Do not phrase findings as 'the architecture should change' or 'this approach is wrong.'"

---

### 🟡 5. Architect: "Apply always" vs conditional scoping

**File**: `architect.md`, Guiding Principles intro  
**Severity**: Warning

**Symptom**: "Apply them in every architecture proposal" is universal, but each principle has a conditional "When to apply" clause. Infrastructure-only changes don't trigger Clean Architecture concerns.

**Fix**: Changed intro to: "Consider every principle in each proposal. Apply with weight proportional to how strongly the change triggers that principle's scoping condition. Infrastructure-only changes need lighter application of Clean Architecture; domain-heavy changes need all three."

---

### 🟡 6. Developer: Hardcoded `flask_blogs` submodule

**File**: `developer.md`, Steps 4 and 6  
**Severity**: Warning

**Symptom**: "Branch the submodule" hardcodes `cd flask_blogs` with no existence check. Fails on projects without that submodule. Misses other submodules.

**Fix**: Replaced hardcoded submodule with iteration over `git submodule status`:
```bash
git submodule status | awk '{print $2}' | while read submodule; do
  cd "$submodule"
  git checkout -b <branch-name> 2>/dev/null || git checkout <branch-name>
  git push -u origin <branch-name>
  cd ..
done
```
Added: "If no submodules exist (command produces no output), skip this step."

Same fix applied to the push step (Step 6A).

---

### 🟡 7. Researcher: Workflow timing gap

**File**: `researcher.md`, role description  
**Severity**: Warning

**Symptom**: Researcher "validates the architectural proposal" implying it runs AFTER Architect. But Architect outputs `ARCHITECTURE_COMPLETE` as final. Researcher findings that contradict architecture can't influence it without a supervisor loop-back that isn't specified anywhere.

**Fix**: Added to role description: "If your findings reveal issues with the architecture, the supervisor may re-invoke the Architect to revise the design. You do not control this flow — you only provide data."

**Note**: This is a partial fix. The supervisor implementation needs to actually handle this loop-back. The agent definition now documents the expectation.

---

### 🟡 8. TestDesigner: Timeout coordination gap

**File**: `test-designer.md`, Clean Architecture Testing Discipline  
**Severity**: Warning

**Symptom**: TestDesigner says core tests "under 5 seconds." Auditor has 60-second total timeout. No coordination on whether integration tests might push total over 60s.

**Fix**: Added: "**Total test suite runtime:** All test commands combined should complete within 60 seconds (the Auditor's timeout). If integration tests need more time, split them into separately-timed commands or note the expected duration so the Auditor can adjust timeout expectations."

---

### 🟢 9. Auditor: "Security" vs "Correctness & Safety"

**File**: `auditor.md`, APPROVE checklist  
**Severity**: Suggestion

**Symptom**: The six review dimensions define "Correctness & Safety" but the checklist item says `- Security: ✓`. Security is a subset, not the whole dimension.

**Fix**: Changed checklist item to `- Correctness & Safety: ✓`.

Also fixed sibling line `- Tests passed: ✓ (ran: <test command>)` → `<test commands>` (plural) to support multi-suite test plans.


---

### 🟢 11. Researcher: `web_crawl` tool access ambiguity

**File**: `researcher.md`, Step 3  
**Severity**: Suggestion

**Symptom**: Instructions said "invoke `web_crawl` via `bash`" — ambiguous whether it's a CLI command or function call. The tool is available via the crawl4ai extension.

**Fix**: Changed to: "For each query, use the `web_crawl` tool to crawl a relevant public web page. The tool accepts a URL and optional maxPages parameter."

---

### 🟢 12. TestDesigner: Missing architecture comment edge case

**File**: `test-designer.md`, Your Task step 1  
**Severity**: Suggestion

**Symptom**: TestDesigner must "Review the architecture comment to understand the implementation approach" but no instruction exists for when the architecture comment is absent (e.g., pipeline ordering issue).

**Fix**: Added fallback: "If no architecture comment is present in the provided issue data, state this in your test plan comment and design tests based on the issue requirements alone. Flag that the test plan may need revision once architecture is finalized."

---

## Cross-Agent Consistency Checks (No Issues Found)

These aspects were checked and found consistent across all agents:

| Aspect | Result |
|--------|--------|
| "NEVER change issue status — supervisor handles" | ✅ All 5 agents have this rule |
| "NEVER fetch issue from GitHub — use task data only" | ✅ All 5 agents have this rule |
| Developer NEVER creates PRs, Auditor creates PRs | ✅ Clear separation |
| All agents have identical extensions | ✅ `caveman,crawl4ai,piignore,codebase-memory` |
| Tool access matches role (only Developer has write/edit) | ✅ |
| Test-first sequence: Architect → TestDesigner → Developer → Auditor | ✅ Consistent ordering |
| Test command format: TestDesigner specifies, Auditor executes | ✅ Now consistent (after fix #1) |
| Architecture dependency: TestDesigner uses Architect's output | ✅ Now with fallback (after fix #12) |

---

## Files Modified

| File | Changes |
|------|---------|
| `.pi/agents/auditor.md` | 5 edits: test extraction, N+→3+, Security→Correctness & Safety, test commands plural, replace text |
| `.pi/agents/test-designer.md` | 3 edits: layered→phase-gated structure, timeout coordination, missing architecture fallback |
| `.pi/agents/architect.md` | 1 edit: "apply always"→"consider with proportional weight" |
| `.pi/agents/researcher.md` | 3 edits: role description, judgment boundary, web_crawl invocation |
| `.pi/agents/developer.md` | 2 edits: submodule iteration (branch + push) |

---

## Remaining Risks

1. **Supervisor loop-back not implemented**: Fix #7 documents that the Researcher's findings may trigger Architect re-invocation, but the supervisor must actually implement this logic. Without it, Researcher findings that contradict the architecture are ignored.

2. **Phase-gated test plan is a new convention**: Fix #2 changes the TestDesigner's output structure. The Developer and Auditor both consume the test plan. They should be aware of the new phase-gated format. The Developer's instructions say "Read the test plan from the TestDesigner comment" — generic enough to handle the new format. The Auditor's instructions say "find ALL fenced code blocks" — also handles the new format. No further changes needed.



# Descisions 

- We switch the order of the researcher and the archtiect. we do not want to add a backloop. The archtiect then build it sarchtiecture on a well researched prd. without creation contradictions.
- make sure that things like in 6. are not present. we want the agents to be neutral to the repositories so that the agents can also be used in other repositories.
-
