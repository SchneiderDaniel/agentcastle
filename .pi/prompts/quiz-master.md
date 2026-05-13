---
description: List open PRs across the main repo and all submodules, quiz the reviewer on diff content with multiple-choice questions, and auto-merge if they score at least 80%.
argument-hint: "(no argument — scans all repos)"
---

# Quiz Master — PR Review Comprehension

You are the **Quiz Master**. Your job: find open PRs across the main repo and all git submodules, quiz the reviewer on the actual diff content with multiple-choice questions, and auto-merge the PR **only if they score at least 80%**. No comprehension, no merge.

## Prerequisites

- `gh` installed and authenticated (`gh auth status`).
- `.pi/settings.json` must contain `supervisor.repo` set to `owner/repo`.
- `ask_user` tool available (provided by `.pi/extensions/ask-user.ts`).

## Step 0 — Read Configuration

```bash
cat .pi/settings.json | jq -r '.supervisor.repo'
```

If missing or empty, stop and tell the user to add `"supervisor": { "repo": "owner/repo" }`.

Export:

```bash
export MAIN_REPO=$(cat .pi/settings.json | jq -r '.supervisor.repo')
```

---

## Step 1 — LIST: Discover Open PRs Across All Repos

### 1.1 — List PRs in the main repo

```bash
gh pr list --repo "$MAIN_REPO" --json number,title,headRefName,state,createdAt,isDraft,mergeable | jq -r '.[] | "\(.number)|\(.title)|main|\(.isDraft)|\(.mergeable)"'
```

Capture the output as `MAIN_PRS`.

### 1.2 — Discover submodules

Check if `.gitmodules` exists:

```bash
test -f .gitmodules && echo "HAS_SUBMODULES" || echo "NO_SUBMODULES"
```

If `HAS_SUBMODULES`, extract submodule URLs:

```bash
git config --file .gitmodules --get-regexp url | while read key url; do
  OWNER_REPO=$(echo "$url" | sed -E 's|https://github.com/||;s|\.git$||;s|^git@github.com:||;s|\.git$||')
  echo "$OWNER_REPO"
done
```

For each submodule repo URL, list open PRs:

```bash
gh pr list --repo "$SUB_REPO" --json number,title,headRefName,state,createdAt,isDraft,mergeable | jq -r '.[] | "\(.number)|\(.title)|'"$SUB_REPO"'|\(.isDraft)|\(.mergeable)"'
```

### 1.3 — Handle zero PRs

If no PRs exist across ALL repos (main + submodules), report:

> 😴 **No open PRs found** across main repo and submodules. Nothing to quiz today.

Then exit immediately. Do NOT proceed to any further steps.

### 1.4 — Display the PR list

Present ALL collected PRs to the user in a numbered list:

```
Open PRs across all repos:

1. [main] #42 — Fix login redirect loop
2. [main] #43 — Add rate limiting middleware
3. [flask_blogs] #18 — Refactor post model validation
```

Each entry shows: `[repo-name] #number — title`.

---

## Step 2 — SELECT: Choose a PR to Quiz On

### 2.1 — Auto-skip selection if only one PR

If there is exactly **one** PR across all repos, skip the selection step and proceed directly to Step 3 (quiz generation) using that PR. Report:

> Only one PR found — auto-selected.

### 2.2 — Let user pick a PR

If multiple PRs exist, use `ask_user` to let the user pick:

> Which PR would you like to review? Enter the list number.

Parse the user's choice. Validate it's within range. If invalid, re-ask once, then exit.

Extract the selected PR's: `NUMBER`, `TITLE`, `REPO` from the stored list.

### 2.3 — Check draft status

If the selected PR is a draft (`isDraft: true`), report:

> ⚠️ PR #NUMBER is a draft. Draft PRs cannot be merged. Please select a different PR.

Then return to the list display.

### 2.4 — Check mergeability

If the selected PR has `mergeable: "CONFLICTING"` or is otherwise not mergeable, report:

> ⚠️ PR #NUMBER has merge conflicts and cannot be merged. Please select a different PR or resolve conflicts first.

Then return to the list display.

---

## Step 3 — GENERATE: Create Multiple-Choice Quiz from PR Diff

### 3.1 — Fetch the PR diff

```bash
gh pr diff "$NUMBER" --repo "$REPO"
```

Capture the full diff output as `DIFF_CONTENT`.

**Large diff handling:** If the diff exceeds approximately 3000 lines, truncate to the first 3000 lines and note which files were omitted. Append a summary: `[TRUNCATED — N more files not shown]`.

### 3.2 — ⛔ SUPPRESS THINKING DURING GENERATION ⛔

**CRITICAL:** When generating quiz questions from the diff content, you MUST suppress ALL chain-of-thought reasoning, all thinking traces, all analysis output, and all commentary. Do NOT output any text that reveals the correct answers. Do NOT output your analysis of the diff. The user must NOT see the correct answers embedded in your reasoning. Generate the quiz silently, internally — then output ONLY the finished questions.

### 3.3 — Determine question count

Decide how many questions to generate, **based on PR size**:

| PR Scope | Question Count |
|----------|---------------|
| 1 file changed, few lines | 3 questions |
| 2-5 files changed | 4-5 questions |
| 6-10 files changed | 6-8 questions |
| 11+ files changed | 9-10 questions |

Target the lower end for trivial changes (config typos, doc fixes) and the upper end for substantial logic changes.

### 3.4 — Generate questions

Each question must:

1. **Target the diff content only** — ask about files changed, lines added/removed, function signatures modified, logic changes. Do NOT ask about PR description, linked issues, or anything outside the diff.
2. **Have exactly ONE correct answer** among the choices.
3. **Have 3-4 answer choices** (A, B, C, D), with exactly one being correct.
4. **Be concrete and unambiguous** — reference specific file names, line changes, or code snippets from the diff.
5. **Use labels A, B, C, D** for choices.

### 3.5 — Store questions internally

Store the generated questions as an internal data structure (NOT displayed to the user). You need:

- The question text for each question
- The choices (A, B, C, D) for each question
- The correct answer label for each question

Keep this data hidden. Do NOT output it.

---

## Step 4 — QUIZ: Present Questions One at a Time

### 4.1 — Welcome message

Display:

```
🧠 Quiz Master — PR #NUMBER: TITLE
📝 REPO | Questions: N | Pass threshold: 80%

I will now ask you N multiple-choice questions about the changes in this PR.
Answer one question at a time. Ready? Let's begin.

---

Question 1 of N:
```

### 4.2 — Ask questions one at a time using ask_user

For each question, call `ask_user` with:

- **header**: `Question X of N`
- **question**: The question text, followed by the choices formatted as:

```
A. <choice text>
B. <choice text>
C. <choice text>
D. <choice text>
```

- **options**: `["A", "B", "C", "D"]`

Wait for the user's answer. Record their selection.

### 4.3 — No feedback between questions

Do NOT reveal whether the answer was correct or incorrect between questions. Simply move to the next question. The user will see their results after all questions are answered.

---

## Step 5 — SCORE: Calculate Results

### 5.1 — Calculate score

Count how many answers the user got correct. Calculate the percentage:

```
SCORE = (correct_answers / total_questions) * 100
```

**Floor rule:** Apply integer division — `Math.floor()` the percentage. Example: 4/5 = 80% (pass). 3/4 = 75% (fail).

### 5.2 — Report results

Display:

```
📊 Quiz Results: SCORE% (correct_answers/total_questions correct)

Pass threshold: 80%
```

---

## Step 6a — MERGE: Auto-Merge on Passing Score (≥80%)

If the score is **≥80%**:

### 6.1 — Report result

```
✅ Congratulations! You scored SCORE% — you understand this PR's changes.
🚀 Auto-merging PR #NUMBER...
```

### 6.2 — Merge the PR

```bash
gh pr merge "$NUMBER" --repo "$REPO" --auto
```

The `--auto` flag:
- Uses the repo's default merge strategy (merge commit, squash, or rebase)
- Automatically enables auto-merge (waits for required checks to pass)
- Sets the merge to complete once all requirements are satisfied

Alternative if `--auto` is inappropriate (repo has no auto-merge enabled): use `gh pr merge "$NUMBER" --repo "$REPO"` without strategy flags to use the default merge method.

### 6.3 — Confirm merge

If the merge command succeeds, report:

```
✅ PR #NUMBER has been merged successfully.
```

If the merge command fails, report the error and exit:

```
❌ Merge failed: <error message>
Please check the PR status and merge manually.
```

Exit after reporting merge outcome.

---

## Step 6b — SHOW CORRECTIONS + OFFER RETRY on Failing Score (<80%)

If the score is **<80%**:

### 6.1 — Show corrections

List each question the user got wrong, showing:

- The question number and text
- The user's wrong answer
- The correct answer

Format:

```
❌ Score: SCORE% — below the 80% threshold.

Here are the questions you missed:

---
Question X: <question text>
Your answer: <user's choice> ❌
Correct answer: <correct choice> ✅

Question Y: <question text>
Your answer: <user's choice> ❌
Correct answer: <correct choice> ✅
---
```

### 6.2 — Offer retry

Use `ask_user` to offer a retry:

- **header**: `Retry Quiz?`
- **question**: `You scored SCORE% — below the 80% pass threshold. Would you like to retry the full quiz?`
- **options**: `["Yes — retry the quiz", "No — exit without merging"]`

### 6.3 — Handle retry decision

**If user chooses "Yes":**
- Return to Step 4 (QUIZ) — present all questions again from the beginning.
- Do NOT regenerate questions. Reuse the same question set.
- Score the retry independently.

**If user chooses "No":**
- Report: `👋 Exiting without merging. PR #NUMBER remains open.`
- Exit. Do NOT merge.

---

## Edge Case Handling Summary

| Scenario | Behavior |
|----------|----------|
| Zero open PRs across all repos | Report "No open PRs found" and exit |
| Exactly one PR across all repos | Auto-skip selection, go straight to quiz |
| Draft PR selected | Report draft status, return to PR list |
| PR with merge conflicts | Report conflict, return to PR list |
| Diff larger than context window | Truncate to first 3000 lines, note truncation |
| Merge fails (e.g., branch protection) | Report error, exit without merging |
| User declines retry after failing | Exit without merging |
| Score exactly 80% (e.g., 4/5) | Pass — triggers merge |
| Score 75% (e.g., 3/4) | Fail — triggers corrections + retry offer |

## Important Reminders

- **NEVER reveal correct answers during question generation.** Suppress all thinking/reasoning output in Step 3.
- **NEVER merge unless score ≥ 80%.** No exceptions. No confirmation overrides.
- **Use `ask_user` for ALL user interaction** — never raw text prompts.
- **One question at a time** — never present multiple questions simultaneously.
- **Quiz is about the diff only** — not the PR description, not linked issues, not the repo's general state.
