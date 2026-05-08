/**
 * PiIgnore Extension
 *
 * Reads .piignore files (gitignore format) from the project root and
 * walking up parent directories. Blocks read/write/edit access
 * to any path matching the ignore patterns.
 *
 * Zero dependencies — uses only Node built-ins.
 *
 * Usage:
 *   1. Create .piignore at project root with gitignore-style patterns
 *   2. /reload
 *
 * Example .piignore:
 *   .env
 *   .env.*
 *   secrets/
 *   **&#47;*.key
 *   !important.log
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Lightweight gitignore pattern matcher (Node built-ins only)
// ---------------------------------------------------------------------------

interface IgnoreEntry {
  root: string;
  patterns: Pattern[];
}

interface Pattern {
  regex: RegExp;
  negate: boolean;
}

/**
 * Convert a single gitignore pattern line to a RegExp.
 * Supports: * ** ? ! (negation) and trailing / for directories.
 */
function patternToRegex(pattern: string): Pattern {
  let p = pattern;
  let negate = false;

  if (p.startsWith("!")) {
    negate = true;
    p = p.slice(1).trim();
  }
  if (p === "") return { regex: /(?!)/, negate };

  let dirOnly = false;
  if (p.endsWith("/")) {
    dirOnly = true;
    p = p.slice(0, -1);
  }

  const hasSlash = p.includes("/") || p.startsWith("**");

  // Step 1: Escape regex meta-characters except *, ?, /
  let r = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");

  // Step 2: Replace **/ and ** with placeholders (so later * replacement
  //         doesn't mangle the injected regex syntax)
  r = r.replace(/\*\*\//g, "\x00G\x00"); // **/ -> placeholder
  r = r.replace(/\*\*$/g, "\x00GS\x00"); // ** at end -> placeholder

  // Step 3: Replace *, ? with regex equivalents
  r = r.replace(/\*/g, "[^/]*");
  r = r.replace(/\?/g, "[^/]");

  // Step 4: Replace placeholders with actual regex
  r = r.replace(/\x00G\x00/g, "(.*/)?");
  r = r.replace(/\x00GS\x00/g, ".*");

  // Step 5: Anchor
  if (hasSlash) {
    r = "^" + r;
  } else {
    r = "(^|.*/)" + r;
  }
  if (dirOnly) r += "(/.*)?";
  r += "$";

  return { regex: new RegExp(r), negate };
}

/** Parse a .piignore file content into Pattern[]. */
function parseIgnore(content: string): Pattern[] {
  const patterns: Pattern[] = [];
  for (let line of content.split("\n")) {
    line = line.trim();
    if (line === "" || line.startsWith("#")) continue;
    patterns.push(patternToRegex(line));
  }
  return patterns;
}

/** Walk up from cwd to filesystem root, collecting .piignore files. */
function loadPiIgnore(cwd: string): IgnoreEntry[] {
  const entries: IgnoreEntry[] = [];
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

/**
 * Check if a path is ignored by any .piignore file.
 * Handles both relative and absolute paths.
 * Respects negation patterns (!).
 */
function isIgnored(
  targetPath: string,
  entries: IgnoreEntry[],
  cwd: string,
): boolean {
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
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  let entries = loadPiIgnore(cwd);

  // Reload patterns on /reload
  pi.on("resources_discover", () => {
    entries = loadPiIgnore(process.cwd());
  });

  const blockableTools = ["read", "write", "edit"];

  pi.on("tool_call", async (event, ctx) => {
    if (!blockableTools.includes(event.toolName)) return;

    const targetPath: string | undefined = (
      event.input as { path?: string }
    ).path;
    if (!targetPath) return;

    if (isIgnored(targetPath, entries, ctx.cwd)) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Blocked by .piignore: ${targetPath}`, "warning");
      }
      return {
        block: true,
        reason: `Path "${targetPath}" matches .piignore patterns`,
      };
    }
  });
}
