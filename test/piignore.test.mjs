/**
 * Test for piignore extension.
 * Tests pattern matching and .piignore file parsing.
 * Run: node test/piignore.test.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Copy of extension functions (can't import the .ts directly due to pi types)
// ---------------------------------------------------------------------------

function patternToRegex(pattern) {
  let p = pattern, negate = false;
  if (p.startsWith("!")) { negate = true; p = p.slice(1).trim(); }
  if (p === "") return { regex: /(?!)/, negate };
  let dirOnly = false;
  if (p.endsWith("/")) { dirOnly = true; p = p.slice(0, -1); }
  const hasSlash = p.includes("/") || p.startsWith("**");
  let r = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  r = r.replace(/\*\*\//g, "\x00G\x00");
  r = r.replace(/\*\*$/g, "\x00GS\x00");
  r = r.replace(/\*/g, "[^/]*");
  r = r.replace(/\?/g, "[^/]");
  r = r.replace(/\x00G\x00/g, "(.*/)?");
  r = r.replace(/\x00GS\x00/g, ".*");
  if (hasSlash) { r = "^" + r; }
  else { r = "(^|.*/)" + r; }
  if (dirOnly) r += "(/.*)?";
  r += "$";
  return { regex: new RegExp(r), negate };
}

function parseIgnore(content) {
  const patterns = [];
  for (let line of content.split("\n")) {
    line = line.trim();
    if (line === "" || line.startsWith("#")) continue;
    patterns.push(patternToRegex(line));
  }
  return patterns;
}

function loadPiIgnore(cwd) {
  const entries = [];
  let dir = cwd;
  while (true) {
    const ignorePath = path.join(dir, ".piignore");
    if (fs.existsSync(ignorePath)) {
      entries.push({
        root: dir,
        patterns: parseIgnore(fs.readFileSync(ignorePath, "utf-8")),
      });
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return entries;
}

function isIgnored(targetPath, entries, cwd) {
  const absPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
  let ignored = false;
  for (const entry of entries) {
    const rel = path.relative(entry.root, absPath);
    if (rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
      for (const pat of entry.patterns) {
        if (pat.regex.test(rel)) {
          ignored = !pat.negate;
        }
      }
    }
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const root = process.cwd();
const entries = loadPiIgnore(root);
let passed = 0, failed = 0;

function test(name, targetPath, expectedBlocked) {
  const result = isIgnored(targetPath, entries, root);
  const ok = result === expectedBlocked;
  if (ok) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL: ${name} — ${targetPath} => blocked:${result}, expected:${expectedBlocked}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log("=".repeat(title.length));
}

// ---- Pattern syntax ----
section("Pattern syntax");

const patTests = [
  ["*.log", ["debug.log", "src/foo.log"], ["foo.js", "log.txt"]],
  ["**/*.key", ["foo.key", "bar/baz.key", "a/b/c.key"], ["foo.js"]],
  ["**/test", ["test", "src/test", "a/b/test"], ["testing", "contest"]],
  ["secrets/", ["secrets/token", "secrets/nested/key", "src/secrets/x", "secrets"], []],
  [".env.*", [".env.prod", "src/.env.local"], [".env", "env.prod"]],
  // Negation: !important.log matches "important.log" literally, negate flag handles inversion
  ["!important.log", ["important.log"], ["other.log"]],
];

for (const [pat, shouldMatch, shouldNot] of patTests) {
  const { regex, negate } = patternToRegex(pat);
  for (const p of shouldMatch) {
    const ok = regex.test(p);
    if (!ok) { failed++; console.log(`FAIL: "${pat}" should match "${p}"`); }
    else passed++;
  }
  for (const p of shouldNot) {
    const ok = !regex.test(p);
    if (!ok) { failed++; console.log(`FAIL: "${pat}" should NOT match "${p}"`); }
    else passed++;
  }
}

// ---- Real .piignore file ----
section("Actual .piignore rules");

const blockedPaths = [
  ".env",
  ".env.production",
  "node_modules/foo/index.js",
  ".git/HEAD",
  ".pi/sessions/abc123/session.jsonl",
  ".pi/npm/node_modules/foo/index.js",
  ".pi/crawl4ai-venv/bin/python",
  ".pi/chromium-deps/lib/libc.so",
  ".pi/agent/settings.json",
  "tmp/test.json",
  "old/archive.ts",
  "package-lock.json",
  "credentials.json",
  "src/secrets/token.txt",
  ".DS_Store",
  "debug.log",
  "data.db",
  "archive.tar.gz",
  ".idea/workspace.xml",
  ".vscode/settings.json",
  "__pycache__/foo.pyc",
];

const allowedPaths = [
  ".pi/extensions/piignore.ts",
  ".pi/extensions/caveman.ts",
  ".pi/prompts/issue-cutter.md",
  ".pi/agents/developer.md",
  ".pi/settings.json",
  "README.md",
  "AGENTS.md",
  "package.json",
  "scripts/setup-github-project.sh",
  "test/session-logger.test.mts",
  ".piignore",
  "src/app.ts",
];

for (const p of blockedPaths) test(`Blocked: ${p}`, p, true);
for (const p of allowedPaths) test(`Allowed: ${p}`, p, false);

// ---- Edge cases ----
section("Edge cases");

// Absolute paths
test("absolute path", root + "/.env", true);
test("absolute allowed", root + "/README.md", false);

// Paths outside project
test("outside project", "/tmp/foo.txt", false);
test("outside absolute", "/etc/passwd", false);

// Path with ./
test("dot-slash prefix", "./.env", true);

// ---- Negation integration ----
section("Negation: *.log then !important.log");

// Build a mini ignore list: *.log, then !important.log
const negEntries = [{
  root,
  patterns: [
    patternToRegex("*.log"),
    patternToRegex("!important.log"),
  ],
}];

function testNeg(targetPath, expectedBlocked) {
  const result = isIgnored(targetPath, negEntries, root);
  const ok = result === expectedBlocked;
  if (ok) passed++;
  else { failed++; console.log(`FAIL negation: ${targetPath} => blocked:${result}, expected:${expectedBlocked}`); }
}

testNeg("debug.log", true);       // blocked by *.log
testNeg("important.log", false);   // re-included by !important.log
testNeg("other.log", true);        // blocked by *.log
testNeg("source.ts", false);       // not matched at all

// ---- Results ----
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
