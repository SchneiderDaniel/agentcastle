---
description: Refine a GitHub issue by challenging it against the codebase, sharpening language, replacing vague requirements with concrete acceptance criteria, and updating the issue in-place.
argument-hint: "<issue-number>"
---

# Issue Refinement

Fetch GitHub issue #$1, grill it against the live codebase, sharpen its language and requirements, then **replace the original issue body** with the refined version and add the `refined` label.

## Prerequisites

- `gh` installed and authenticated (`gh auth status`).
- `.pi/settings.json` must contain `projectRepo` set to `owner/repo` (e.g. `SchneiderDaniel/agentcastle-project`).

## Step 0 — Read Configuration

Read `.pi/settings.json` and extract the `projectRepo` field. Parse it as `OWNER/REPO`:

```bash
cat .pi/settings.json | jq -r '.projectRepo'
```

If the field is missing or empty, stop and tell the user to add `"projectRepo": "owner/repo"` to `.pi/settings.json`.

Export for reuse:

```bash
export REPO=$(cat .pi/settings.json | jq -r '.projectRepo')
export OWNER=$(echo $REPO | cut -d'/' -f1)
export REPO_NAME=$(echo $REPO | cut -d'/' -f2)
```

Verify the repo exists:

```bash
gh repo view "$REPO" --json name --jq '.name'
```

---

## Core Principles

### Grill Against Reality

The issue is a proposal. The codebase is ground truth. Every claim in the issue must be verified against what actually exists. If the code already does what the issue asks for — the issue is wrong. If the code contradicts a claim — surface the contradiction.

### Replace, Don't Append

The refined issue **replaces** the original body. No `--- UPDATE ---` sections, no append-only edits. The LLM reading the refined issue should see one coherent, final specification. The old version is dead.

### Sharpen, Don't Soften

Vague language ("make it better", "add support for X", "improve the thing") becomes concrete. Every requirement gets acceptance criteria. Every acceptance criterion is testable by a human without reading code.

---

## Workflow

### Step 1 — Fetch the Issue

```bash
gh issue view $1 --repo "$REPO" --json title,body,comments,labels,state
```

Read the full output. Understand what the issue is asking for and what state it's in.

### Step 2 — Explore the Codebase

⚠️ **MANDATORY**: Before challenging anything, understand the current state.

**2a — Map the area the issue touches:**

```bash
# Find files by name pattern relevant to the issue domain
find . -maxdepth 4 -not -path './.pi/*' -not -path './node_modules/*' -not -path './.git/*' -iname '*<keyword>*' | head -60
```

```bash
# Search for symbols mentioned in the issue
codebase_search --name_pattern '<function_or_class_from_issue>'
```

**2b — Read existing documentation (if any):**

Check for `CONTEXT.md`, `docs/adr/`, or `CONTEXT-MAP.md` at the repo root. If any exist, read them. They may define canonical terminology that the issue should use.

**2c — Trace relevant code paths:**

For each feature or change mentioned in the issue, trace the relevant code:

- If the issue mentions a function/class, use `codebase_trace` to see what calls it and what it calls.
- If the issue mentions an endpoint, find the route handler and trace its inbound/outbound calls.

**2d — Identify what already exists vs what's genuinely missing:**

Record a clear list. The refined issue must only describe work NOT yet done.

### Step 3 — Grill the Issue

Challenge the issue systematically. For each finding, prepare a concrete recommendation.

#### 3a — Cross-reference claims with code

- Does the code already do what the issue asks? → Recommend closing or reducing scope.
- Does the code contradict a claim in the issue? → Surface the contradiction.
- Does the issue use terms that conflict with existing `CONTEXT.md` definitions? → Flag and propose canonical term.
- Is the issue silent about something the code already handles? → Recommend acknowledging existing behaviour.

#### 3b — Sharpen vague language

For each vague phrase, propose a concrete replacement:

| Vague                  | Sharp                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| "add support for tags" | "Add a `tags` JSONB column to `recipes`, expose via `GET /recipes?tag=:name`, render tag chips on recipe cards" |
| "improve performance"  | "Reduce `GET /recipes` p99 latency from 800ms to 200ms by adding a covering index on `(category, created_at)`"  |
| "make it better"       | Reject — ask what "better" means, or derive from context                                                        |
| "handle edge cases"    | List specific edge cases with expected behaviour                                                                |

#### 3c — Probe missing details

For each gap in the issue, formulate a question. If the answer is discoverable in the codebase, answer it from the code. Otherwise, flag it as a question for the user:

- Missing acceptance criteria → propose at least 2 per requirement
- Missing validation steps → write step-by-step human-validation instructions
- Missing dependencies → identify them from code (e.g. "depends on PR #42 which adds the `tags` migration")
- Missing error states → list them ("what happens when the tag doesn't exist?")
- Missing scope boundary → define what's IN and OUT

#### 3d — Stress-test with scenarios

Invent concrete scenarios that probe the boundaries:

- "A user adds a tag with 500 characters — what happens?"
- "Two users edit the same recipe simultaneously — what's the expected behaviour?"
- "The tag filter returns zero results — what does the UI show?"

Use these to verify the issue's requirements are complete.

### Step 4 — Write the Refined Issue

⚠️ **Do NOT write yet.** Present findings to the user first (Step 5). Only write after confirmation.

The refined issue body follows this structure:

```markdown
## Summary

_1–3 sentences: what this issue asks for, in precise language using canonical terms from CONTEXT.md if available._

## Context

_Why this change matters. How it relates to existing code. What problem it solves._

**Current state** (verified in code):

- <thing that exists and works>
- <thing that exists and works>

**What's missing:**

- <thing to build or change>
- <thing to build or change>

## Requirements

### R1: <Short imperative title>

As a [role], I want [feature], so that [benefit].

**Acceptance Criteria:**

- [ ] AC1: <specific, testable condition>
- [ ] AC2: <specific, testable condition>

### R2: <Short imperative title>

...

## How to Validate (Human Tester)

_Step-by-step instructions executable without reading any code. Covers happy path AND edge cases._

1. <setup step>
2. <navigation step>
3. <action step>
4. <expected result>

**Edge cases:**

- <scenario>: <expected behaviour>
- <scenario>: <expected behaviour>

## Out of Scope

_Explicitly list what this issue does NOT cover, to prevent scope creep._

- <thing intentionally excluded>
- <thing intentionally excluded>

## Dependencies

- <dependency if any>
- <dependency if any>

## Technical Direction

_Optional: key files to touch, services involved, patterns to follow. Keep brief — point the developer, don't prescribe the implementation._

- <file/path.ts> — <what it does and how it relates>
- <file/path.ts> — <what it does and how it relates>
```

### Step 5 — Present Findings & Get Confirmation

Before modifying anything on GitHub, present a summary:

```
Refinement findings for issue #$1:

🔴 CONTRADICTIONS:
- Issue claims X, but code at src/foo.ts:42 does Y

🟡 VAGUE — SHARPENED:
- "add tag support" → "Add tags JSONB column, GET /recipes?tag= filter, tag chips in UI"

🟢 ALREADY EXISTS:
- Tag filtering already works in GET /recipes?tag= (src/routes/recipes.ts:88)

❓ QUESTIONS FOR YOU:
- What's the max tag length?
- Should tags be case-sensitive?

📋 PROPOSED REQUIREMENTS:
1. Add tags column to recipes table
2. Expose tag filter on GET /recipes
3. Render tag chips on recipe cards
…

Replace issue #$1 with this refined version?
```

Wait for user confirmation before proceeding.

If the findings show the issue is entirely already implemented, recommend closing instead:

```
Issue #$1 appears fully implemented:
- X: src/foo.ts:42 already does this
- Y: src/bar.ts:88 already handles this

Recommend closing this issue. Proceed?
```

### Step 6 — Update the Issue on GitHub

**6a — Update the issue body:**

```bash
gh issue edit $1 \
  --repo "$REPO" \
  --body '…refined body content…'
```

**6b — Add the `refined` label:**

First check if the label exists:

```bash
gh label list --repo "$REPO" --search "refined" --json name --jq '.[].name'
```

If it doesn't exist, create it:

```bash
gh label create "refined" \
  --repo "$REPO" \
  --color "1D76DB" \
  --description "Issue has been refined with concrete acceptance criteria"
```

Then apply it:

```bash
gh issue edit $1 --repo "$REPO" --add-label "refined"
```

**6c — Add a comment** (optional, keep brief):

```bash
gh issue comment $1 --repo "$REPO" --body "Refined. [Details of what changed — 1 sentence.]"
```

**6d — Print confirmation:**

```
✅ Issue #$1 refined.
   Label: refined added.
   View: https://github.com/$REPO/issues/$1
```

---

## Quality Checklist

Before updating the issue, verify:

- [ ] Every claim in the original issue was checked against the codebase
- [ ] Vague language was replaced with concrete, testable requirements
- [ ] Every requirement has at least 2 acceptance criteria
- [ ] Acceptance criteria are testable by a human without reading code
- [ ] "How to Validate" covers both happy path and edge cases
- [ ] "Out of Scope" is explicit about what is NOT included
- [ ] Terminology matches `CONTEXT.md` if one exists (or a note was added if new terms were introduced)
- [ ] Work described does NOT already exist in the codebase
- [ ] Dependencies are identified and listed
- [ ] The refined issue body is a complete replacement — no reader needs to see the original

---

## Safety & Constraints

- **Never close the issue** — only add the `refined` label and update the body. The human decides when to close.
- **Never delete comments.** Only add one comment summarizing the refinement.
- **The refined body replaces the original.** No append-only "updates" section.
- **If the original title is vague, suggest a better title** — but only change it after user confirmation.
- **Use `--jq`** with `gh api` for JSON extraction, not `ConvertFrom-Json`.
- **Fetch the issue once** — do not re-fetch in a loop.
