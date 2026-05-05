---
description: Split a GitHub epic into smaller, ordered, independently testable sub-issues and create them on GitHub as children of the parent epic.
argument-hint: "<issue-number>"
---

# Issue Cutter

Split GitHub epic #$1 into small, ordered, independently testable sub-issues and create them on GitHub as **sub-issues (children) of the parent epic**.

## Prerequisites

- `gh` installed and authenticated (`gh auth status`).
- `.pi/settings.json` must contain `projectRepo` set to `owner/repo` (e.g. `SchneiderDaniel/agentcastle-project`).

## Step 0 — Read Configuration

Read `.pi/settings.json` and extract the `projectRepo` field. Parse it as `OWNER/REPO`:

```bash
cat .pi/settings.json | jq -r '.projectRepo'
```

If the field is missing or empty, stop and tell the user to add `"projectRepo": "owner/repo"` to `.pi/settings.json`.

Export for reuse in later commands:

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

## Core Principle: The Vertical Slice

Each sub-issue must be a **vertical slice** — self-contained, independently testable, with concrete acceptance criteria. Avoid horizontal slices (e.g. "do all DB changes first"). Each slice must include **step-by-step human validation instructions**.

---

## Workflow

### Step 1 — Fetch the Epic

```bash
gh issue view $1 --repo "$REPO" --json title,body,comments,labels
```

Read the full output before proceeding.

### Step 1.5 — Refinement Gate

Check that the epic has the `refined` label. Extract labels from the JSON fetched in Step 1:

```bash
echo '<STEP1_OUTPUT>' | jq -r '.labels[].name' | grep -x 'refined'
```

If `grep` finds **no** match (empty output, exit code 1), **stop immediately** and tell the user:

> Issue #$1 is not refined yet. Please refine the issue first (add the `refined` label) before cutting it into sub-issues.

Do **not** proceed past this gate if the `refined` label is absent.

### Step 2 — Explore the Codebase

⚠️ **MANDATORY**: Explore the relevant codebase area before decomposing. Cutting issues without knowing current state leads to incorrect sub-issues.

```bash
# List project structure (adjust depth as needed)
find . -maxdepth 3 -not -path './.pi/*' -not -path './node_modules/*' -not -path './.git/*' | head -80
```

Read key files the epic will touch. Record what **already exists** vs what is **genuinely missing**. Sub-issues must only describe work not yet done.

### Step 3 — Analyze & Categorize

Map the epic across these layers (only those actually needed):

| Layer               | Examples                                          |
| ------------------- | ------------------------------------------------- |
| **Data / Database** | Schema changes, migrations, seed data             |
| **Backend / API**   | Service logic, routes, validation, business rules |
| **Frontend / UI**   | Templates, forms, JS interactions, CSS            |
| **Infrastructure**  | Config, Docker, environment variables             |
| **i18n / Content**  | Translation strings, locale files                 |
| **Testing**         | Integration, E2E tests                            |
| **Documentation**   | README, inline docs                               |

### Step 4 — Derive Ordered Sub-Issues

Ordering rules:

1. **Foundation first**: data model before services that use them
2. **Backend before frontend**: endpoint exists before UI that calls it
3. **Infrastructure before services**: config/env vars needed by code come first
4. **i18n strings before they are referenced in templates**
5. **Testing sub-issues** go last (unless embedded in the slice)

For each sub-issue define:

- **Order number** (1, 2, 3…) — in body, NOT in title
- **Title**: short, imperative, descriptive on its own
- **Body**: User Story + Acceptance Criteria (template below)
- **Label** (use existing repo labels; check with `gh label list --repo "$REPO"`)

### Step 5 — Confirm with User

Present the proposed breakdown as a numbered list:

```
Proposed breakdown for issue #$1:
1. [database] Add recipe_tag column to database schema
2. [backend] Implement tag service and API endpoint
3. [frontend] Build tag filter UI component
…

Create these as GitHub sub-issues?
```

Wait for user confirmation before creating.

### Step 6 — Create Sub-Issues on GitHub

**6a — Create each issue:**

Every sub-issue gets the `refined` and `sliced` labels plus its layer label.

First, ensure the `sliced` label exists:

```bash
gh label list --repo "$REPO" --search "sliced" --json name --jq '.[].name'
```

Create if missing:

```bash
gh label create "sliced" \
  --repo "$REPO" \
  --color "FBCA04" \
  --description "Issue has been sliced into sub-issues"
```

Then create each sub-issue:

```bash
gh issue create \
  --repo "$REPO" \
  --title "Add recipe_tag column to database schema" \
  --body '…body content…' \
  --label "refined,sliced"
```

Capture each new issue number from the output (e.g. `https://github.com/owner/repo/issues/42` gives issue number 42).

**6b — Link as sub-issue:**

Resolve the epic node ID:

```bash
EPIC_ID=$(gh api graphql \
  -F owner="$OWNER" \
  -F repo="$REPO_NAME" \
  -F num=$1 \
  -f query='
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$num) { id }
      }
    }' --jq '.data.repository.issue.id')

echo "Epic ID: $EPIC_ID"
```

Resolve each child issue's node ID (repeat per sub-issue, replace `CHILD_NUM`):

```bash
CHILD_ID=$(gh api graphql \
  -F owner="$OWNER" \
  -F repo="$REPO_NAME" \
  -F num=CHILD_NUM \
  -f query='
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$num) { id }
      }
    }' --jq '.data.repository.issue.id')

echo "Child ID: $CHILD_ID"
```

**6c — Add sub-issue relationship:**

```bash
gh api graphql \
  -F issueId="$EPIC_ID" \
  -F subIssueId="$CHILD_ID" \
  -f query='
    mutation($issueId:ID!, $subIssueId:ID!) {
      addSubIssue(input:{issueId:$issueId, subIssueId:$subIssueId}) {
        issue { number }
        subIssue { number }
      }
    }'
```

Repeat 6b and 6c for every sub-issue.

**6d — Print summary:**

```
✅ Sub-issues created under Epic #$1:
  #101  (1) Add recipe_tag column to database schema
  #102  (2) Implement tag service and API endpoint
  #103  (3) Build tag filter UI component
  …
```

---

## Sub-Issue Body Template

Every sub-issue body follows this exact format:

```markdown
## Context

_Why this piece exists and how it relates to the parent epic._
Parent epic: #$1
Implementation order: <N> of <total>

## User Story

As a [role], I want [feature], so that [benefit].

## Acceptance Criteria

- [ ] AC1: <specific, testable condition>
- [ ] AC2: <specific, testable condition>

## How to Validate (Human Tester)

_Step-by-step instructions executable without reading any code._

1. <setup step>
2. <navigation step>
3. <action step>
4. <expected result>
5. <edge case / negative test>

## Technical Notes

_Optional: key files, services, patterns. Keep brief._

## Dependencies

_Optional: sub-issues that must be completed before this one._
```

---

## Safety & Constraints

- **Never close the original epic** — only the human reviewer may close issues.
- **No artificial cap on sub-issues** — use as many as needed for clarity.
- **Each sub-issue must have at least 2 Acceptance Criteria.**
- **Labels**: only use labels that exist (`gh label list --repo "$REPO"`).
- **Fetch the epic once** — do not re-fetch in a loop.
- **Use `--jq`** with `gh api` for JSON extraction, not `ConvertFrom-Json`.

## Quality Checklist

Before creating any sub-issue, verify mentally:

- [ ] Work is **not already implemented** (verified in Step 2)
- [ ] Describes **one** coherent unit of work
- [ ] Has at least **2** concrete, testable acceptance criteria
- [ ] Developer could start **today** without waiting for unclear decisions
- [ ] Does not duplicate work in another sub-issue
- [ ] Order number reflects valid implementation sequence
- [ ] **How to Validate** section has step-by-step instructions executable without reading code
