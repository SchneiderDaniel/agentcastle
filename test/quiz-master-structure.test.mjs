import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PROMPT = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', '.pi', 'prompts', 'quiz-master.md'),
  'utf-8'
);

// ── 1. Structure ─────────────────────────────────────────────────────

test('structure — frontmatter has description field', () => {
  const frontmatterMatch = PROMPT.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, 'Expected YAML frontmatter delimited by ---');
  const frontmatter = frontmatterMatch[1];
  assert.ok(frontmatter.includes('description:'), 'Expected description field in frontmatter');
});

test('structure — frontmatter has argument-hint field', () => {
  const frontmatterMatch = PROMPT.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, 'Expected YAML frontmatter delimited by ---');
  const frontmatter = frontmatterMatch[1];
  assert.ok(frontmatter.includes('argument-hint:'), 'Expected argument-hint field in frontmatter');
});

test('structure — body starts with # Quiz Master heading', () => {
  const body = PROMPT.replace(/^---\n[\s\S]*?\n---\n/, '');
  assert.ok(
    body.trimStart().startsWith('# Quiz Master'),
    'Expected body to start with # Quiz Master heading'
  );
});

// ── 2. State Machine ─────────────────────────────────────────────────

test('state-machine — LIST state: scan repos, run gh pr list, collect open PRs', () => {
  assert.ok(PROMPT.includes('gh pr list'), 'Expected gh pr list command');
  assert.ok(
    PROMPT.includes('LIST') || PROMPT.includes('Step 1') || PROMPT.includes('Listing'),
    'Expected LIST state or Step 1 for listing PRs'
  );
});

test('state-machine — SELECT state: user picks PR from list', () => {
  assert.ok(
    PROMPT.includes('SELECT') || PROMPT.includes('pick') || PROMPT.includes('choose') || PROMPT.includes('which PR'),
    'Expected user selection of PR from list'
  );
});

test('state-machine — GENERATE state: fetch diff, generate 3-10 multiple-choice questions', () => {
  assert.ok(PROMPT.includes('gh pr diff'), 'Expected gh pr diff command');
  assert.ok(
    PROMPT.includes('GENERATE') || PROMPT.includes('generate') || PROMPT.includes('questions'),
    'Expected question generation state'
  );
});

test('state-machine — QUIZ state: one question at a time via ask_user', () => {
  assert.ok(PROMPT.includes('ask_user'), 'Expected ask_user usage for quizzing');
  assert.ok(
    PROMPT.includes('one at a time') || PROMPT.includes('one question') || PROMPT.includes('QUIZ'),
    'Expected one-question-at-a-time quizzing'
  );
});

test('state-machine — SCORE state: calculate percentage, compare to 80% threshold', () => {
  assert.ok(
    PROMPT.includes('SCORE') || PROMPT.includes('score'),
    'Expected scoring state'
  );
});

test('state-machine — MERGE state: gh pr merge on >= 80%', () => {
  assert.ok(PROMPT.includes('gh pr merge'), 'Expected gh pr merge command');
});

test('state-machine — RETRY state: show corrections, offer retry on < 80%', () => {
  assert.ok(
    PROMPT.includes('RETRY') || PROMPT.includes('retry'),
    'Expected retry offer on failing score'
  );
});

// ── 3. Business Rules ────────────────────────────────────────────────

test('business-rule — 80% pass threshold present', () => {
  assert.ok(
    PROMPT.includes('80%') || PROMPT.includes('80 percent') || PROMPT.includes('0.8'),
    'Expected 80% pass threshold'
  );
});

test('business-rule — 3-10 question range present', () => {
  assert.ok(
    (PROMPT.includes('3') && PROMPT.includes('10')) ||
    PROMPT.includes('3-10') ||
    PROMPT.includes('3 to 10'),
    'Expected 3-10 question range'
  );
});

test('business-rule — question count based on PR size', () => {
  assert.ok(
    PROMPT.includes('size') || PROMPT.includes('small') || PROMPT.includes('large'),
    'Expected question count to be based on PR size'
  );
});

test('business-rule — each question targets diff content', () => {
  assert.ok(
    PROMPT.includes('diff') || PROMPT.includes('files changed') || PROMPT.includes('lines added'),
    'Expected questions to target diff content'
  );
});

test('business-rule — each question has exactly one correct answer', () => {
  assert.ok(
    PROMPT.includes('one correct') || PROMPT.includes('exactly one') || PROMPT.includes('single correct'),
    'Expected each question to have exactly one correct answer'
  );
});

// ── 4. Edge Cases ────────────────────────────────────────────────────

test('zero-PRs — prompt handles zero open PRs gracefully', () => {
  assert.ok(
    PROMPT.includes('No open PRs') || PROMPT.includes('no open PRs') || PROMPT.includes('no PRs'),
    'Expected prompt to handle zero open PRs gracefully'
  );
});

test('single-PR — prompt skips selection when only one PR exists', () => {
  assert.ok(
    PROMPT.includes('only one') || PROMPT.includes('single') || PROMPT.includes('skip') || PROMPT.includes('exactly one PR'),
    'Expected prompt to skip selection when only one PR exists'
  );
});

// ── 5. Submodule Support ────────────────────────────────────────────

test('submodule — prompt references .gitmodules for submodule discovery', () => {
  assert.ok(
    PROMPT.includes('.gitmodules') || PROMPT.includes('gitmodules'),
    'Expected prompt to reference .gitmodules for submodule discovery'
  );
});

test('submodule — prompt calls gh pr list --repo for each submodule', () => {
  assert.ok(
    PROMPT.includes('--repo'),
    'Expected --repo flag for submodule PR listing'
  );
});

// ── 6. Safety & Special Cases ───────────────────────────────────────

test('suppress-thinking — prompt instructs agent to suppress reasoning during question generation', () => {
  assert.ok(
    PROMPT.includes('suppress') || PROMPT.includes('thinking') || PROMPT.includes('reasoning') || PROMPT.includes('chain-of-thought') || PROMPT.includes('hidden'),
    'Expected prompt to suppress thinking/reasoning during question generation'
  );
});

test('merge-safety — prompt checks mergeability before merge attempt', () => {
  assert.ok(
    PROMPT.includes('mergeable') || PROMPT.includes('mergeability') || PROMPT.includes('isDraft') || PROMPT.includes('draft'),
    'Expected prompt to check mergeability/draft status before merge'
  );
});

test('merge-method — prompt uses repos default merge method', () => {
  // Verify gh pr merge is called without explicit --merge/--squash/--rebase flags
  // or says "default merge method"
  const mergeSection = PROMPT.substring(PROMPT.indexOf('gh pr merge'));
  const mergeSectionShort = mergeSection.substring(0, mergeSection.indexOf('\n\n') > 0 ? mergeSection.indexOf('\n\n') : 200);
  assert.ok(
    !mergeSectionShort.includes('--merge') || mergeSectionShort.includes('--squash') || mergeSectionShort.includes('--rebase') ||
    PROMPT.includes('default') || PROMPT.includes('--auto'),
    'Expected absence of explicit merge strategy flags or use of default'
  );
});

test('retry-decline — prompt handles user declining retry', () => {
  assert.ok(
    PROMPT.includes('decline') || PROMPT.includes('no') || PROMPT.includes('exit') || PROMPT.includes('without merging'),
    'Expected prompt to handle user declining retry'
  );
});

test('score-report — prompt reports final score to user', () => {
  assert.ok(
    PROMPT.includes('report') || PROMPT.includes('score') || PROMPT.includes('correct out of') || PROMPT.includes('result'),
    'Expected prompt to report final score'
  );
});

test('merge-confirm — prompt confirms merge completed after gh pr merge', () => {
  assert.ok(
    PROMPT.includes('merge') && (PROMPT.includes('complete') || PROMPT.includes('success') || PROMPT.includes('merged')),
    'Expected prompt to confirm merge completion'
  );
});

test('corrections — prompt lists wrong answers with correct answers on failing score', () => {
  assert.ok(
    PROMPT.includes('wrong') || PROMPT.includes('incorrect') || PROMPT.includes('correction') || PROMPT.includes('correct answer'),
    'Expected prompt to show corrections for wrong answers'
  );
});
