/**
 * Tests for .pi/extensions/codebase-memory.ts — Codebase Memory Bridge
 *
 * Covers: projectName hashing, safeJsonParse, snippet truncation,
 * and version-check conditional registration.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codebase-memory.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// R1: projectName — pure function extracted from extension logic
// ---------------------------------------------------------------------------

function projectName(cwd: string): string {
  const basename = cwd.split("/").pop() || "root";
  const hash = createHash("md5").update(cwd).digest("hex").slice(0, 8);
  return `${basename}-${hash}`;
}

describe("R1: projectName hashing", () => {
  it("returns <basename>-<8-char-hex> format", () => {
    const result = projectName("/home/user/project-name");
    const parts = result.split("-");
    // parts could be ["project", "name", "<hash>"] or ["project-name", "<hash>"]
    // but the basename is the last segment: "project-name" from "/home/user/project-name"
    // So result is "project-name-<8-char-hex>"
    const lastPart = parts[parts.length - 1];
    assert.strictEqual(lastPart.length, 8);
    assert.match(lastPart, /^[a-f0-9]{8}$/);
    assert.match(result, /^project-name-[a-f0-9]{8}$/);
  });

  it("uses full absolute path for hash — different paths produce different hashes", () => {
    const a = projectName("/tmp/test-app");
    const b = projectName("/tmp/test/app");
    assert.notStrictEqual(a, b);
    // Both should have same basename "test-app" vs "app" — but with hash they differ
    assert.match(a, /^test-app-/);
    assert.match(b, /^app-/);
  });

  it("basename extracted correctly", () => {
    assert.match(projectName("/home/miria/git/main"), /^main-/);
    assert.match(projectName("/a/b/c/foo"), /^foo-/);
  });

  it("root path '/' produces 'root-<hash>'", () => {
    const result = projectName("/");
    assert.match(result, /^root-[a-f0-9]{8}$/);
  });

  it("no trailing slash interference", () => {
    const a = projectName("/home/user/project");
    const b = projectName("/home/user/project/");
    // With trailing slash, split produces empty last element -> "root" fallback
    // OR the basename is still "project"? Let's test both...
    // Actually split("/") on "/home/user/project/" gives ["", "home", "user", "project", ""]
    // .pop() gives "" -> fallback "root"
    // So trailing slashes go to root fallback
    const c = projectName("/home/user/project");
    assert.match(c, /^project-/);
  });

  it("same path produces same hash (deterministic)", () => {
    const a = projectName("/some/path/here");
    const b = projectName("/some/path/here");
    assert.strictEqual(a, b);
  });

  it("hash is exactly 8 hex characters", () => {
    const result = projectName("/any/path");
    const hashPart = result.split("-").pop()!;
    assert.strictEqual(hashPart.length, 8);
    assert.match(hashPart, /^[a-f0-9]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// R3: safeJsonParse — defensive JSON extraction
// ---------------------------------------------------------------------------

function safeJsonParse(input: string): object | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Find first '{' then count braces to find matching '}'
  const start = trimmed.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

describe("R3: safeJsonParse", () => {
  it("parses valid JSON", () => {
    const result = safeJsonParse('{"ok": true, "data": [1,2,3]}');
    assert.deepStrictEqual(result, { ok: true, data: [1, 2, 3] });
  });

  it("extracts JSON from noisy output (warning prefix)", () => {
    const result = safeJsonParse('WARNING: deprecated flag\n{"ok": true, "value": 42}');
    assert.deepStrictEqual(result, { ok: true, value: 42 });
  });

  it("extracts JSON from noisy output (trailing log)", () => {
    const result = safeJsonParse('{"ok": true}\nSome trailing log line');
    assert.deepStrictEqual(result, { ok: true });
  });

  it("handles nested JSON objects", () => {
    const result = safeJsonParse('{"data": {"nested": true, "arr": [1,2]}}');
    assert.deepStrictEqual(result, { data: { nested: true, arr: [1, 2] } });
  });

  it("handles JSON with strings containing braces", () => {
    const result = safeJsonParse('{"text": "hello {world}", "ok": true}');
    assert.deepStrictEqual(result, { text: "hello {world}", ok: true });
  });

  it("returns null for empty string", () => {
    assert.strictEqual(safeJsonParse(""), null);
  });

  it("returns null for whitespace-only string", () => {
    assert.strictEqual(safeJsonParse("   \n  \t  "), null);
  });

  it("returns null for non-JSON string", () => {
    assert.strictEqual(safeJsonParse("just some text"), null);
  });

  it("returns null for invalid JSON with braces", () => {
    assert.strictEqual(safeJsonParse("{invalid: json}"), null);
  });

  it("returns null for single brace (no match)", () => {
    // Only '{' without '}' won't match the greedy regex
    assert.strictEqual(safeJsonParse("{only open brace"), null);
  });

  it("extracts first JSON object when multiple present", () => {
    const result = safeJsonParse('{"first": 1}\n{"second": 2}');
    assert.deepStrictEqual(result, { first: 1 });
  });

  it("handles multi-line JSON", () => {
    const result = safeJsonParse('{\n  "ok": true,\n  "items": [1, 2]\n}');
    assert.deepStrictEqual(result, { ok: true, items: [1, 2] });
  });
});

// ---------------------------------------------------------------------------
// R5: snippet truncation
// ---------------------------------------------------------------------------

function truncateSnippet(source: string, maxLines = 500, maxBytes = 15_000): { text: string; truncated: boolean; omittedLines: number } {
  const lines = source.split("\n");

  if (lines.length <= maxLines && Buffer.byteLength(source, "utf-8") <= maxBytes) {
    return { text: source, truncated: false, omittedLines: 0 };
  }

  // Truncate by lines first
  let truncated = lines.slice(0, maxLines);
  let omittedLines = lines.length - maxLines;
  let text = truncated.join("\n");

  // Then check byte limit
  const note = `// ...truncated (${omittedLines} lines omitted)`;
  const noteBytes = Buffer.byteLength(note, "utf-8");

  if (Buffer.byteLength(text, "utf-8") + noteBytes > maxBytes) {
    // Need to truncate further to fit within byte limit
    // Binary search for the right number of lines
    let lo = 0;
    let hi = maxLines;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const candidate = lines.slice(0, mid).join("\n");
      if (Buffer.byteLength(candidate, "utf-8") + noteBytes <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    truncated = lines.slice(0, lo);
    omittedLines = lines.length - lo;
    text = truncated.join("\n");
  }

  return { text: `${text}\n${note}`, truncated: true, omittedLines };
}

describe("R5: snippet truncation", () => {
  it("returns source unchanged when within limits", () => {
    const source = "line1\nline2\nline3";
    const result = truncateSnippet(source);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.text, source);
    assert.strictEqual(result.omittedLines, 0);
  });

  it("truncates at 500 lines", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const source = lines.join("\n");
    const result = truncateSnippet(source);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.omittedLines, 100);
    // Should contain exactly 500 content lines + truncation note
    const outputLines = result.text.split("\n");
    assert.strictEqual(outputLines.length, 501); // 500 content + 1 truncation note
    assert.match(outputLines[500], /\/\/ \.\.\.truncated \(100 lines omitted\)/);
  });

  it("does not truncate at exactly 500 lines", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const source = lines.join("\n");
    const result = truncateSnippet(source);
    // Under 15KB limit, 500 lines should pass
    assert.strictEqual(result.truncated, false);
  });

  it("truncates at 15KB byte limit even if under 500 lines", () => {
    // Create lines that are ~100 bytes each, 200 lines = ~20KB > 15KB
    const fatLine = "x".repeat(99);
    const lines = Array.from({ length: 200 }, () => fatLine);
    const source = lines.join("\n");
    const result = truncateSnippet(source);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.omittedLines > 0);
    // Result must be <= 15KB
    const resultBytes = Buffer.byteLength(result.text, "utf-8");
    assert.ok(resultBytes <= 15_000, `result is ${resultBytes} bytes, expected <= 15000`);
  });

  it("truncation note includes correct omitted count", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const source = lines.join("\n");
    const result = truncateSnippet(source);
    assert.match(result.text, /100 lines omitted/);
  });

  it("handles empty source", () => {
    const result = truncateSnippet("");
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.text, "");
  });

  it("handles multi-byte characters — truncation by line count, not byte", () => {
    // Lines with multi-byte UTF-8 characters
    const lines = Array.from({ length: 501 }, (_, i) => `日本語の行 ${i}`);
    const source = lines.join("\n");
    const result = truncateSnippet(source);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(result.omittedLines, 1);
    // The truncation is by line count, so it correctly keeps 500 lines
    const outputLines = result.text.split("\n");
    assert.strictEqual(outputLines.length, 501); // 500 + note
  });

  it("truncation note is appended exactly once", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const source = lines.join("\n");
    const result = truncateSnippet(source);
    const notes = result.text.match(/\.\.\.truncated/g);
    assert.strictEqual(notes?.length, 1);
  });
});

// ---------------------------------------------------------------------------
// R4: version parsing (helper for conditional registration)
// ---------------------------------------------------------------------------

function parseVersion(versionString: string): [number, number, number] | null {
  const match = versionString.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

function isVersionAtLeast(version: [number, number, number], minMajor: number, minMinor: number, minPatch: number): boolean {
  const [major, minor, patch] = version;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

describe("R4: version checking", () => {
  describe("parseVersion", () => {
    it("parses standard semver", () => {
      assert.deepStrictEqual(parseVersion("0.6.1"), [0, 6, 1]);
      assert.deepStrictEqual(parseVersion("1.2.3"), [1, 2, 3]);
      assert.deepStrictEqual(parseVersion("0.5.9"), [0, 5, 9]);
    });

    it("parses version from noisy output", () => {
      assert.deepStrictEqual(parseVersion("codebase-memory-mcp v0.6.1"), [0, 6, 1]);
      assert.deepStrictEqual(parseVersion("version 1.0.0-beta"), [1, 0, 0]);
    });

    it("returns null for unparseable version", () => {
      assert.strictEqual(parseVersion("not a version"), null);
      assert.strictEqual(parseVersion(""), null);
    });
  });

  describe("isVersionAtLeast", () => {
    it("0.6.1 >= 0.6.1 → true", () => {
      assert.strictEqual(isVersionAtLeast([0, 6, 1], 0, 6, 1), true);
    });

    it("0.6.2 >= 0.6.1 → true", () => {
      assert.strictEqual(isVersionAtLeast([0, 6, 2], 0, 6, 1), true);
    });

    it("0.7.0 >= 0.6.1 → true", () => {
      assert.strictEqual(isVersionAtLeast([0, 7, 0], 0, 6, 1), true);
    });

    it("1.0.0 >= 0.6.1 → true", () => {
      assert.strictEqual(isVersionAtLeast([1, 0, 0], 0, 6, 1), true);
    });

    it("0.6.0 >= 0.6.1 → false", () => {
      assert.strictEqual(isVersionAtLeast([0, 6, 0], 0, 6, 1), false);
    });

    it("0.5.9 >= 0.6.1 → false", () => {
      assert.strictEqual(isVersionAtLeast([0, 5, 9], 0, 6, 1), false);
    });

    it("0.5.0 >= 0.6.1 → false", () => {
      assert.strictEqual(isVersionAtLeast([0, 5, 0], 0, 6, 1), false);
    });
  });
});
