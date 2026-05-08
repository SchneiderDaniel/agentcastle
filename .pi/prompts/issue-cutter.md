---
description: Split a GitHub epic into smaller, ordered, independently testable sub-issues and create them on GitHub as children of the parent epic.
argument-hint: "<issue-number>"
---

# Issue Cutter

Split GitHub epic #$1 into small, ordered, independently testable sub-issues and create them on GitHub as **sub-issues (children) of the parent epic**.

## Prerequisites

- `gh` installed and authenticated (`gh auth status`).
- `.pi/settings.json` must contain `projectRepo` set to `owner/repo` (e.g. `SchneiderDaniel/agentcastle`).

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

⚠️ Save output to a **project-relative path** (e.g. `tmp/epic.json`). Do NOT use `/tmp/` — the bash tool blocks absolute paths outside the project directory.

```bash
gh issue view $1 --repo "$REPO" --json title,body,comments,labels > tmp/epic.json
```

Read the full output before proceeding (use `cat tmp/epic.json | jq '{title, body, labels: [.labels[].name]}'` for a readable summary).

### Step 1.5 — Refinement Gate

Check that the epic has the `refined` label. Extract labels from the JSON fetched in Step 1:

```bash
jq -r '.labels[].name' tmp/epic.json | grep -x 'refined'
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

Map the epic across these layers (only those actually needed). Each layer corresponds to a GitHub label that must exist in the repo:

| #   | Layer          | Title / Examples                                               |
| --- | -------------- | -------------------------------------------------------------- |
| 1   | infrastructure | Project scaffolding, dependencies, directory structure, config |
| 2   | database       | Schema changes, migrations, seed data, persistence             |
| 3   | backend        | Service logic, API routes, validation, business rules          |
| 4   | frontend       | Templates, forms, JS interactions, CSS, dashboard UI           |
| 5   | i18n           | Translation strings, locale files                              |
| 6   | testing        | Integration, E2E, smoke tests                                  |
| 7   | documentation  | README, inline docs                                            |

Fetch available labels once and reuse:

```bash
gh label list --repo "$REPO" --json name | jq -r '.[].name' | sort
```

### Step 4 — Derive Ordered Sub-Issues

Ordering rules:

1. **Foundation first**: data model before services that use them
2. **Backend before frontend**: endpoint exists before UI that calls it
3. **Infrastructure before services**: config/env vars needed by code come first
4. **i18n strings before they are referenced in templates**
5. **Testing sub-issues** go last (unless embedded in the slice)

For each sub-issue define:

- **Order number** (1, 2, 3…) — in body, NOT in title
- **Title**: short, imperative, descriptive on its own. **MUST NOT contain `/`** (see Bash Tool Constraints below).
- **Body**: User Story + Acceptance Criteria (template below)
- **Layer label** — exactly one from the table in Step 3 (e.g. `database`, `backend`, `frontend`). Must exist as a GitHub label in the repo.

### Step 5 — Confirm with User

Present the proposed breakdown as a numbered list:

```
Proposed breakdown for issue #$1:
1. Add recipe_tag column to database schema    → labels: `refined`, `database`
2. Implement tag service and API endpoint       → labels: `refined`, `backend`
3. Build tag filter UI component                → labels: `refined`, `frontend`
…

Create these as GitHub sub-issues?
```

Wait for user confirmation before creating.

### Step 6 — Create and Link Sub-Issues on GitHub

⚠️ **MANDATORY: Every sub-issue MUST be linked as a child of the epic. Creation alone is incomplete. Do not skip 6b.**

#### Bash Tool Constraints (READ BEFORE CREATING ISSUES)

The bash tool blocks any command containing a `/` that looks like an **absolute path** (e.g. `/foo`, `/nonexistent`, `/usr/...`). Specifically, any `/` preceded by space, `(`, `'`, `"`, or at line-start triggers path validation and blocks the command.

**Rules for issue titles and bodies:**

- **Titles**: MUST NOT contain standalone `/`. Replace `GET /` with `GET root`, `POST /api/users` with `POST api users`, `/path/:id` with `path by id`.
- **Bodies**: `/` inside longer tokens (e.g. `data/visits.db`, `flask_app/app.py`, `http://...`) is fine — only standalone `/` (preceded by space or punctuation) triggers the block. Avoid phrases like `curl http://localhost:3000/api/users` where `/api/users` appears standalone. Rewrite as `curl localhost:3000/api/users` (no space before `/api`).

#### 6a — Resolve the epic node ID (ONCE, before the loop)

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

echo "$EPIC_ID" > tmp/epic_id.txt
echo "Epic ID: $EPIC_ID"
```

#### 6b — For EACH sub-issue (loop): write body to file → create → capture number → resolve child ID → link

Every sub-issue gets exactly two labels: `refined` and its **layer label** (e.g. `database`, `backend`, `frontend`, `infrastructure`, `testing`, `i18n`, `documentation`). Do **not** add a `sliced` label.

**Step-by-step for each sub-issue:**

**Step 1: Write the body to a file first.** This avoids inline escaping issues and path validation on multi-line content. Use project-relative paths like `tmp/sub<N>_body.md`.

**Step 2: Create the issue, reading body from file.**

```bash
BODY=$(cat tmp/sub1_body.md)
CHILD_URL=$(gh issue create \
  --repo "$REPO" \
  --title "Your slash-free title here" \
  --body "$BODY" \
  --label "refined,database")
echo "Created: $CHILD_URL"
```

**Step 3: Extract the issue number from the URL.**

```bash
CHILD_NUM=$(echo "$CHILD_URL" | grep -oP '/issues/\K\d+')
echo "Child number: $CHILD_NUM"
```

**Step 4: Resolve the child issue's GraphQL node ID.**

```bash
CHILD_ID=$(gh api graphql \
  -F owner="$OWNER" \
  -F repo="$REPO_NAME" \
  -F num="$CHILD_NUM" \
  -f query='
    query($owner:String!, $repo:String!, $num:Int!) {
      repository(owner:$owner, name:$repo) {
        issue(number:$num) { id }
      }
    }' --jq '.data.repository.issue.id')
echo "Child ID: $CHILD_ID"
```

**Step 5: Link the child to the epic.**

```bash
EPIC_ID=$(cat tmp/epic_id.txt)
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
echo "Linked #$CHILD_NUM as sub-issue of Epic #$1"
```

⚠️ **Do ALL FIVE steps for each sub-issue before moving to the next one. Do NOT batch all creations and then try to link afterward.**

**Save each sub-issue number** for dependency references in later sub-issues:

```bash
echo "$CHILD_NUM" > tmp/sub<N>_num.txt
```

**Tip:** You can combine steps 2–5 into one chained command per sub-issue (using `&&`), but keep steps 1 (file write) separate since the body file won't change within a chained command after writing.

#### 6c — Print summary

```
✅ Sub-issues created and linked under Epic #$1:
  #101  [database]  (1) Add recipe_tag column to database schema
  #102  [backend]   (2) Implement tag service and API endpoint
  #103  [frontend]  (3) Build tag filter UI component
  …
```

Verify linkage:

```bash
gh api graphql \
  -F owner="$OWNER" -F repo="$REPO_NAME" -F num=$1 \
  -f query='query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){title subIssues(first:20){nodes{number title}}}}}' \
  --jq '.data.repository.issue | {title, children: [.subIssues.nodes[] | {number, title}]}'
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
- **Bash tool path validation**: titles must not contain standalone `/`. Bodies must avoid standalone `/` paths. Use project-relative paths for all file I/O (not `/tmp/`).
- **Write bodies to files first**, then create issues from files. Never inline multi-line bodies in the `gh issue create` command.

## Quality Checklist

Before creating any sub-issue, verify mentally:

- [ ] Work is **not already implemented** (verified in Step 2)
- [ ] Describes **one** coherent unit of work
- [ ] Has at least **2** concrete, testable acceptance criteria
- [ ] Developer could start **today** without waiting for unclear decisions
- [ ] Does not duplicate work in another sub-issue
- [ ] Order number reflects valid implementation sequence
- [ ] **How to Validate** section has step-by-step instructions executable without reading code
- [ ] **Every created sub-issue is linked** to the parent epic (Step 6b completed for each)
- [ ] Title contains no standalone `/` characters

## Troubleshooting

| Symptom                                                 | Likely Cause                                                      | Fix                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Blocked: absolute path "/..."`                         | Command contains a standalone `/` (in title, body, or file path). | Remove `/` from issue titles. Replace standalone `/paths` in body with inline equivalents. Use project-relative file paths. |
| Body not appearing in created issue                     | Inline body in single quotes contains unescaped characters.       | Always write body to file first (`tmp/sub<N>_body.md`), then read via `BODY=$(cat file)`.                                   |
| `gh issue create` fails with "422 Unprocessable Entity" | Label does not exist in the repo.                                 | Run `gh label list --repo "$REPO"` to verify labels exist.                                                                  |
| Sub-issues not appearing under epic                     | Step 6b (link) was skipped or failed silently.                    | Run the verification GraphQL query from Step 6c. Re-link any unlinked sub-issues manually.                                  |
