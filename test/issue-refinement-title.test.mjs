import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const PROMPT = fs.readFileSync(
  path.resolve(import.meta.dirname, "..", ".pi", "prompts", "issue-refinement.md"),
  "utf-8"
);

// ── 1. Title Generation Instruction ──────────────────────────────────

test("1.1 — Phase 2 contains title generation section", () => {
  // Look for the 2.1a heading near the Phase 2 area
  const afterPhase2 = PROMPT.slice(PROMPT.indexOf("## PHASE 2: WRITE"));
  assert.ok(
    afterPhase2.includes("2.1a") || afterPhase2.includes("Generate the Issue Title"),
    "Expected a title generation section (2.1a or 'Generate the Issue Title') after PHASE 2"
  );
});

test("1.2 — Title must be imperative verb phrase", () => {
  assert.ok(
    PROMPT.includes("imperative") || PROMPT.includes("imperative mood"),
    "Expected prompt to require imperative mood for the title"
  );
});

test("1.3 — Title stored in variable $TITLE", () => {
  assert.ok(
    PROMPT.includes("$TITLE") || PROMPT.includes("TITLE="),
    "Expected title to be stored in a TITLE variable"
  );
});

// ── 2. Title Constraints ────────────────────────────────────────────

test("2.1 — Max 72 characters", () => {
  assert.ok(
    PROMPT.includes("72"),
    "Expected prompt to enforce ≤72 character limit"
  );
});

test("2.2 — Plain ASCII only, no quotes/backticks/emoji/shell-breakers", () => {
  assert.ok(
    PROMPT.includes("ASCII") || PROMPT.includes("shell-breaking"),
    "Expected prompt to ban shell-breaking characters"
  );
});

test("2.3 — Truncate/rephrase if over limit", () => {
  assert.ok(
    PROMPT.includes("Truncat") || PROMPT.includes("truncat") || PROMPT.includes("rephras"),
    "Expected prompt to instruct truncation or rephrasing if constraints are violated"
  );
});

test("2.4 — Always generate new title even if current looks fine", () => {
  assert.ok(
    PROMPT.includes("Always") || PROMPT.includes("always"),
    "Expected prompt to state title is always generated fresh"
  );
});

// ── 3. Title Application via `gh issue edit --title` ─────────────────

test("3.1 — `gh issue edit --title \"$TITLE\"` present", () => {
  assert.ok(
    PROMPT.includes('--title "$TITLE"') || PROMPT.includes("--title $TITLE"),
    "Expected prompt to contain --title $TITLE in gh issue edit command"
  );
});

test("3.2 — Retry on failure — exactly once", () => {
  assert.ok(
    PROMPT.includes("Retrying"),
    "Expected retry message 'Retrying...' in prompt"
  );
});

test("3.3 — Failure message after second attempt", () => {
  assert.ok(
    PROMPT.includes("failed after retry"),
    "Expected failure message after retry exhaustion"
  );
});

test("3.4 — Body update runs regardless of title outcome", () => {
  // Body update must be a separate command, not gated behind title success
  assert.ok(
    PROMPT.includes("always runs regardless") ||
    PROMPT.includes("Body will still be updated") ||
    PROMPT.includes("regardless of title"),
    "Expected body update to run independently of title update outcome"
  );
});

test("3.5 — Body update line still exists (existing behavior preserved)", () => {
  assert.ok(
    PROMPT.includes("--body"),
    "Expected --body flag present for body update"
  );
});

// ── 4. Safety & Constraints Update ───────────────────────────────────

test("4.1 — Old 'Suggest title changes' removed", () => {
  assert.ok(
    !PROMPT.includes("Suggest title changes"),
    "Expected old 'Suggest title changes' text to be removed"
  );
});

test("4.2 — New 'Auto-apply generated title' present", () => {
  assert.ok(
    PROMPT.includes("Auto-apply") || PROMPT.includes("auto-apply"),
    "Expected 'Auto-apply generated title' text to be present"
  );
});
