import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";

const PROMPT = fs.readFileSync(
  path.resolve(import.meta.dirname, "..", ".pi", "prompts", "issue-refinement.md"),
  "utf-8"
);

// Helper: extract content between two sections (by heading order)
function sectionBetween(afterHeading, beforeHeading) {
  const start = PROMPT.indexOf(afterHeading);
  if (start === -1) return "";
  // Find the next heading after start
  const remaining = PROMPT.slice(start + afterHeading.length);
  const end = remaining.indexOf(beforeHeading);
  if (end === -1) return remaining;
  return remaining.slice(0, end);
}

// ── Group 1: PHASE 0 — Frontend Detection (R1) ─────────────────────

test("1.1 — Instructions to inspect for frontend changes", () => {
  const phase0 = sectionBetween("## PHASE 0:", "## PHASE 1:");
  assert.ok(
    phase0.includes("HTML") && phase0.includes("CSS") && phase0.includes("browser-rendered"),
    "Expected PHASE 0 to mention HTML, CSS, and browser-rendered inspection"
  );
});

test("1.2 — Confident frontend -> flag + announce", () => {
  assert.ok(
    PROMPT.includes("frontend_flag=true") || PROMPT.includes("frontend_flag = true"),
    "Expected frontend_flag=true to be set when confident frontend detected"
  );
  assert.ok(
    PROMPT.includes("PHASE 1.5") && PROMPT.includes("after PHASE 1"),
    "Expected PHASE 1.5 to be announced to run after PHASE 1"
  );
});

test("1.3 — Unsure -> one confirmation question", () => {
  assert.ok(
    PROMPT.includes("Does this issue involve any UI changes"),
    "Expected confirmation question text for unsure detection"
  );
  assert.ok(
    PROMPT.includes("exactly one") || PROMPT.includes("exactly ONE") || PROMPT.includes("ONE confirmation"),
    "Expected exactly one confirmation question constraint"
  );
});

test("1.4 — Confident no frontend -> silent skip", () => {
  assert.ok(
    PROMPT.includes("frontend_flag=false") || PROMPT.includes("frontend_flag = false"),
    "Expected frontend_flag=false to be set when no frontend detected"
  );
  assert.ok(
    PROMPT.includes("skip") || PROMPT.includes("silent"),
    "Expected silent skip when no frontend detected"
  );
});

test("1.5 — Three detection outcomes defined", () => {
  assert.ok(
    PROMPT.includes("Confident frontend") || PROMPT.includes("confident"),
    "Expected 'Confident frontend' detection outcome"
  );
  assert.ok(
    PROMPT.includes("Unsure") || PROMPT.includes("unsure"),
    "Expected 'Unsure' detection outcome"
  );
  assert.ok(
    PROMPT.includes("Confident no frontend") || PROMPT.includes("no frontend"),
    "Expected 'Confident no frontend' detection outcome"
  );
});

// ── Group 2: PHASE 1.5 — Frontend Refinement Interview (R2) ─────────

test("2.1 — PHASE 1.5 exists between PHASE 1 and PHASE 2", () => {
  const idxPhase1 = PROMPT.indexOf("## PHASE 1:");
  const idxPhase1_5 = PROMPT.indexOf("## PHASE 1.5:");
  const idxPhase2 = PROMPT.indexOf("## PHASE 2:");
  assert.ok(idxPhase1_5 > idxPhase1, "PHASE 1.5 must appear after PHASE 1");
  assert.ok(idxPhase1_5 < idxPhase2, "PHASE 1.5 must appear before PHASE 2");
});

test("2.2 — Conditional on frontend_flag", () => {
  const phase1_5 = sectionBetween("## PHASE 1.5:", "## PHASE 2:");
  assert.ok(
    phase1_5.includes("frontend_flag"),
    "PHASE 1.5 must reference frontend_flag for gating"
  );
  assert.ok(
    phase1_5.includes("Only execute") || phase1_5.includes("only execute") || phase1_5.includes("skip this entire"),
    "PHASE 1.5 must have conditional execution language"
  );
});

test("2.3 — All 5 aspects listed", () => {
  assert.ok(
    PROMPT.includes("Layout / Placement") || PROMPT.includes("Layout/Placement"),
    "Expected Layout/Placement aspect"
  );
  assert.ok(
    PROMPT.includes("Visual Style"),
    "Expected Visual Style aspect"
  );
  assert.ok(
    PROMPT.includes("Interactions"),
    "Expected Interactions aspect"
  );
  assert.ok(
    PROMPT.includes("Responsive Behavior") || PROMPT.includes("Responsive Behaviour"),
    "Expected Responsive Behavior aspect"
  );
  assert.ok(
    PROMPT.includes("Accessibility"),
    "Expected Accessibility aspect"
  );
});

test("2.4 — Skip with justification allowed", () => {
  assert.ok(
    PROMPT.includes("Skip any aspect") || PROMPT.includes("skip any aspect"),
    "Expected skip permission for aspects"
  );
  assert.ok(
    PROMPT.includes("justification"),
    "Expected skip justification requirement"
  );
});

test("2.5 — One question at a time via ask_user", () => {
  const phase1_5 = sectionBetween("## PHASE 1.5:", "## PHASE 2:");
  assert.ok(
    phase1_5.includes("ask_user"),
    "PHASE 1.5 must use ask_user"
  );
  assert.ok(
    phase1_5.includes("One question at a time") || phase1_5.includes("one question at a time"),
    "PHASE 1.5 must have one-question-at-a-time discipline"
  );
});

test("2.6 — 'I don't know' -> reasonable default", () => {
  assert.ok(
    PROMPT.includes("I don't know") && (PROMPT.includes("default") || PROMPT.includes("reasonable")),
    "Expected 'I don't know' handling with default choice"
  );
});

test("2.7 — Exit when all 5 aspects satisfied", () => {
  assert.ok(
    PROMPT.includes("all 5 aspects") || PROMPT.includes("all five aspects") || PROMPT.includes("all 5 aspect"),
    "Expected exit condition covering all 5 aspects"
  );
  assert.ok(
    PROMPT.includes("no fixed question count") || PROMPT.includes("no fixed number"),
    "Expected no fixed question count language"
  );
});

test("2.8 — Follow up on vague answers", () => {
  assert.ok(
    PROMPT.includes("vague") && PROMPT.includes("follow up"),
    "Expected follow-up on vague answers"
  );
});

// ── Group 3: PHASE 2 — UI Design Decisions Section (R3) ─────────────

test("3.1 — '## UI Design Decisions' section present", () => {
  assert.ok(
    PROMPT.includes("## UI Design Decisions"),
    "Expected '## UI Design Decisions' section in template"
  );
});

test("3.2 — Section after Requirements, before How to Validate", () => {
  const idxReqs = PROMPT.indexOf("## Requirements");
  const idxUIDesign = PROMPT.indexOf("## UI Design Decisions");
  const idxHowTo = PROMPT.lastIndexOf("## How to Validate"); // use last in case template appears twice
  assert.ok(idxUIDesign > idxReqs, "UI Design Decisions must appear after Requirements");
  assert.ok(idxUIDesign < idxHowTo, "UI Design Decisions must appear before How to Validate");
});

test("3.3 — Lists decisions per aspect", () => {
  const uiSection = sectionBetween("## UI Design Decisions", "## How to Validate");
  assert.ok(
    uiSection.includes("Layout") || uiSection.includes("Placement"),
    "Expected Layout/Placement in UI Design Decisions"
  );
  assert.ok(
    uiSection.includes("Visual Style"),
    "Expected Visual Style in UI Design Decisions"
  );
  assert.ok(
    uiSection.includes("Interactions"),
    "Expected Interactions in UI Design Decisions"
  );
  assert.ok(
    uiSection.includes("Responsive"),
    "Expected Responsive in UI Design Decisions"
  );
  assert.ok(
    uiSection.includes("Accessibility"),
    "Expected Accessibility in UI Design Decisions"
  );
});

test("3.4 — Omitted when frontend phase skipped", () => {
  assert.ok(
    PROMPT.includes("If and only if") || PROMPT.includes("Omit this entire section"),
    "Expected instruction to omit UI section when frontend phase skipped"
  );
});

test("3.5 — Conditional logic explicit", () => {
  assert.ok(
    PROMPT.includes("frontend phase ran") || PROMPT.includes("frontend refinement phase ran") || PROMPT.includes("frontend phase was skipped"),
    "Expected explicit conditional on whether frontend phase ran"
  );
});

// ── Group 4: Edge Cases ─────────────────────────────────────────────

test("4.1 — All 5 aspects skipped with justification", () => {
  assert.ok(
    PROMPT.includes("SKIPPED —"),
    "Expected SKIPPED placeholder with justification in UI Design Decisions section"
  );
});

test("4.2 — Defaults documented in refined issue", () => {
  assert.ok(
    PROMPT.includes("DEFAULT:") || PROMPT.includes("LLM chose a default"),
    "Expected documentation of LLM-chosen defaults in refined issue"
  );
});

test("4.3 — Phase numbering preserved (uses 1.5)", () => {
  assert.ok(
    PROMPT.includes("PHASE 1.5"),
    "Expected PHASE 1.5 naming to preserve phase numbering"
  );
});

test("4.4 — No new tools or prompt files", () => {
  assert.ok(
    !PROMPT.includes(".pi/extensions/") || PROMPT.indexOf(".pi/extensions/") === PROMPT.lastIndexOf(".pi/extensions/"),
    "Expected no new .pi/extensions/ references beyond pre-existing ones"
  );
});
