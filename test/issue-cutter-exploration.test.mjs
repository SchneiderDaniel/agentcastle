import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const PROMPT = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', '.pi', 'prompts', 'issue-cutter.md'),
  'utf-8'
);

// ── Test 1: No codebase_index (removed) ──────────────────────────────────────
test('prompt does NOT contain codebase_index call', () => {
  assert.ok(!PROMPT.includes('codebase_index'), 'Prompt must NOT contain codebase_index — removed');
});

// ── Test 2: Keyword extraction instructions ──────────────────────────────────
test('prompt instructs extracting up to 5 keywords from issue title and body', () => {
  assert.ok(
    PROMPT.includes('up to 5 keywords') ||
    PROMPT.includes('Extract up to 5'),
    'Must mention extracting up to 5 keywords'
  );
  assert.ok(
    PROMPT.includes('title') && PROMPT.includes('body'),
    'Must mention extracting from title and body'
  );
});

test('prompt prioritizes nouns, entity names, route paths, filenames', () => {
  assert.ok(
    PROMPT.includes('Nouns') || PROMPT.includes('nouns'),
    'Must mention prioritizing nouns'
  );
  assert.ok(
    PROMPT.includes('entity names') || PROMPT.includes('Entity'),
    'Must mention entity names'
  );
  assert.ok(
    PROMPT.includes('Route paths') || PROMPT.includes('route paths'),
    'Must mention route paths'
  );
  assert.ok(
    PROMPT.includes('File names') || PROMPT.includes('file names') || PROMPT.includes('filenames'),
    'Must mention file names'
  );
});

test('prompt has fallback for 0 keywords — skip to greenfield', () => {
  assert.ok(
    PROMPT.includes('0 keywords') || PROMPT.includes('If 0 keywords'),
    'Must handle 0 keywords case'
  );
  assert.ok(
    PROMPT.includes('greenfield'),
    'Must reference greenfield fallback for 0 keywords'
  );
});

// ── Test 3: Codebase search replaced with bash grep ─────────────────────────
test('prompt uses bash grep for codebase search', () => {
  assert.ok(PROMPT.includes('grep -rli'), 'Prompt must use grep -rli for search');
});

test('prompt uses read tool for examining code', () => {
  assert.ok(PROMPT.includes('use `read`'), 'Prompt must use read tool');
  assert.ok(PROMPT.includes('## 2.3'), 'Must have read step');
});

test('prompt uses bash grep for dependency tracing', () => {
  assert.ok(
    PROMPT.includes('grep -rn') && PROMPT.includes('symbol_name'),
    'Prompt must use grep -rn for dependency tracing'
  );
});

test('prompt caps results at top 3 per keyword', () => {
  assert.ok(
    PROMPT.includes('top 3') || PROMPT.includes('first 3'),
    'Must cap results at top 3 per keyword'
  );
});

test('prompt records dependencies alongside each symbol', () => {
  assert.ok(PROMPT.includes('Discovery Map'), 'Must mention Discovery Map');
  assert.ok(
    PROMPT.includes('file:') && PROMPT.includes('symbol:') && PROMPT.includes('deps:'),
    'Must include file/symbol/deps format in discovery map'
  );
});

// ── Test 4: Greenfield fallback ──────────────────────────────────────────────
test('prompt contains phrase "No existing code found — greenfield"', () => {
  assert.ok(
    PROMPT.includes('No existing code found — greenfield') ||
    PROMPT.includes('No existing code found -- greenfield'),
    'Must contain greenfield phrase'
  );
});

test('prompt instructs fallback to text-only cutting when no results', () => {
  assert.ok(
    PROMPT.includes('text-only cutting') || PROMPT.includes('text-only'),
    'Must instruct text-only cutting fallback'
  );
});

// ── Test 5: Sub-issue "Files Touched" section ───────────────────────────────
test('sub-issue body template contains Files Touched section', () => {
  assert.ok(
    PROMPT.includes('## Files Touched'),
    'Sub-issue template must contain Files Touched section'
  );
});

test('template lists existing files/symbols when code found', () => {
  assert.ok(
    PROMPT.includes('Existing files/symbols') || PROMPT.includes('Existing files'),
    'Template must list existing files/symbols'
  );
});

test('template states "No existing code — new files will be created" for greenfield', () => {
  assert.ok(
    PROMPT.includes('No existing code — new files will be created') ||
    PROMPT.includes('No existing code -- new files will be created'),
    'Template must state greenfield message for new files'
  );
});

test('template handles mixed case — existing files + new paths', () => {
  assert.ok(
    PROMPT.includes('New files to create') || PROMPT.includes('new files'),
    'Template must support listing new files alongside existing ones'
  );
});

// ── Test 6: Edge cases in prompt ─────────────────────────────────────────────
test('>50 results per keyword → take top 3 only', () => {
  assert.ok(
    PROMPT.includes('50') && PROMPT.includes('top 3') ||
    PROMPT.includes('more than 50') && PROMPT.includes('first 3'),
    'Must handle >50 results with top 3 cap'
  );
});

test('referenced files not found → note as "referenced but not found", do not block', () => {
  assert.ok(
    PROMPT.includes('referenced but not found'),
    'Must instruct to note referenced but not found files'
  );
  assert.ok(
    PROMPT.includes('Do not block') || PROMPT.includes('do not block'),
    'Must instruct not to block on missing referenced files'
  );
});

// ── Test 7: Data flow integrity ──────────────────────────────────────────────
test('discovery map built from file path, symbol, dependencies', () => {
  assert.ok(PROMPT.includes('file:'), 'Discovery map must include file paths');
  assert.ok(PROMPT.includes('symbol:'), 'Discovery map must include symbols');
  assert.ok(PROMPT.includes('deps:'), 'Discovery map must include dependencies');
});

test('discovery map injected into each sub-issue under Files Touched', () => {
  const filesTouchedIdx = PROMPT.indexOf('## Files Touched');
  const discoveryRef = PROMPT.substring(filesTouchedIdx);
  assert.ok(
    discoveryRef.includes('discovery map') || discoveryRef.includes('Discovered during Step 2') ||
    PROMPT.includes('The discovery map feeds into each sub-issue'),
    'Must reference injecting discovery map into Files Touched section'
  );
});
