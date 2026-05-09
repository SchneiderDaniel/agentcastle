import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PROMPT = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', '.pi', 'prompts', 'issue-cutter.md'),
  'utf-8'
);

// Test 1: Mutation command present
test('contains addBlockedBy mutation call', () => {
  assert.ok(PROMPT.includes('addBlockedBy'), 'Prompt must reference addBlockedBy mutation');
  assert.ok(PROMPT.includes('-F issueId='), 'Must use -F issueId= parameter');
  assert.ok(PROMPT.includes('-F blockingIssueId='), 'Must use -F blockingIssueId= parameter');
});

// Test 2: First-child skip — no addBlockedBy call for first sub-issue
test('first child writes prev_child_id but no mutation call', () => {
  // Check that first sub-issue instructions write to prev_child_id.txt without calling addBlockedBy
  assert.ok(PROMPT.includes('echo "$CHILD_ID" > tmp/prev_child_id.txt'),
    'First child must write its node ID to tmp/prev_child_id.txt');
  // The first child block (N=1) should only write the file, no mutation
  // The mutation only appears in the N>1 block
  const firstChildSection = PROMPT.substring(
    PROMPT.indexOf('For the first sub-issue (N=1)'),
    PROMPT.indexOf('For each subsequent sub-issue (N > 1)')
  );
  assert.ok(!firstChildSection.includes('addBlockedBy'),
    'First child section must not contain addBlockedBy mutation');
});

// Test 3: Chain wiring (N>1) — reads prev_child_id, calls mutation, overwrites file
test('subsequent children read prev_child_id, call mutation, write own ID', () => {
  assert.ok(PROMPT.includes('PREV_CHILD_ID=$(cat tmp/prev_child_id.txt)'),
    'Must read tmp/prev_child_id.txt for previous child ID');
  assert.ok(PROMPT.includes('echo "$CHILD_ID" > tmp/prev_child_id.txt'),
    'Must overwrite tmp/prev_child_id.txt with own ID after mutation');
});

// Test 4: Error stop — guard around mutation
test('stop on mutation failure with error guard', () => {
  assert.ok(PROMPT.includes('if [ $? -ne 0 ]; then'),
    'Must have exit code check ($? -ne 0) around addBlockedBy mutation');
  assert.ok(PROMPT.includes('exit 1'),
    'Must exit with code 1 on mutation failure');
  assert.ok(PROMPT.includes('Stopping: remaining sub-issues will NOT be created'),
    'Must state that remaining sub-issues are not created on failure');
});

// Test 5: Error report format
test('error report includes failing sub-issue details', () => {
  assert.ok(PROMPT.includes('ERROR: Failed to set dependency for sub-issue N='),
    'Must report which sub-issue number failed');
  assert.ok(PROMPT.includes('issueId: $CHILD_ID'),
    'Must report issueId value');
  assert.ok(PROMPT.includes('blockingIssueId: $PREV_CHILD_ID'),
    'Must report blockingIssueId value');
  assert.ok(PROMPT.includes('Raw GraphQL error above'),
    'Must reference raw GraphQL error output');
});

// Test 6: Single sub-issue skip — exact phrase
test('explicit single sub-issue skip instruction', () => {
  assert.ok(
    PROMPT.includes('If only 1 sub-issue was created (N ≤ 1), skip the dependency wiring step entirely'),
    'Must contain exact skip instruction for single sub-issue'
  );
});

// Test 7: Last child chains end — last child written to prev_child_id but never read as blocker
test('last child ID written to prev_child_id for potential next, chain ends naturally', () => {
  // The pattern writes prev_child_id after every child (including last). This is fine —
  // the last write just won't be consumed since loop ends. No explicit "last child" special case needed.
  // Verify the write happens after the mutation, not conditional on more children.
  const subsequentSection = PROMPT.substring(
    PROMPT.indexOf('For each subsequent sub-issue (N > 1)')
  );
  assert.ok(subsequentSection.includes('echo "$CHILD_ID" > tmp/prev_child_id.txt'),
    'Last child still writes to prev_child_id.txt (harmless, chain ends naturally)');
});

// Test 8: No addBlockedBy for N=1 — first iteration writes file only, no mutation call
test('first iteration (N=1) code path: write file only, no mutation', () => {
  // The text "For the first sub-issue (N=1): save its node ID" followed by only a write command
  const promptFromFirst = PROMPT.substring(PROMPT.indexOf('For the first sub-issue (N=1)'));
  const promptUntilNext = promptFromFirst.substring(0, promptFromFirst.indexOf('For each subsequent sub-issue'));
  assert.ok(promptUntilNext.includes('echo "$CHILD_ID" > tmp/prev_child_id.txt'),
    'First child writes prev_child_id.txt');
  assert.ok(!promptUntilNext.includes('addBlockedBy'),
    'First child path must not contain addBlockedBy');
});
