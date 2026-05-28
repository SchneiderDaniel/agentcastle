/**
 * piignore — Blocks AI access to sensitive files via .piignore patterns
 *
 * Reads .piignore (gitignore format) from project root. Prevents the AI
 * from reading, writing, editing, or inspecting paths matching ignore
 * patterns. Keeps .env, secrets/, and other sensitive data safe.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
function isIgnored(targetPath: string, entries: IgnoreEntry[], cwd: string): boolean {
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
// Helpers: extract paths from tool inputs
// ---------------------------------------------------------------------------

/** Check a single path against ignore patterns. Returns the matched path or null. */
function checkPath(
	targetPath: string | undefined,
	entries: IgnoreEntry[],
	cwd: string,
): string | null {
	if (!targetPath) return null;
	if (isIgnored(targetPath, entries, cwd)) return targetPath;
	return null;
}

/**
 * Extract potential file/directory paths from a bash command string.
 * Looks for tokens that look like paths (contain / or common extensions)
 * and checks each against ignore patterns.
 */
function checkBashCommand(command: string, entries: IgnoreEntry[], cwd: string): string | null {
	// Split into tokens, respecting quoted strings. Track whether each
	// token was quoted — quoted strings (echo "some.log") are not paths.
	interface Token {
		text: string;
		wasQuoted: boolean;
	}
	const tokens: Token[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				if (current) tokens.push({ text: current, wasQuoted: true });
				current = "";
				continue;
			}
			current += ch;
		} else if (inDouble) {
			if (ch === '"') {
				inDouble = false;
				if (current) tokens.push({ text: current, wasQuoted: true });
				current = "";
				continue;
			}
			current += ch;
		} else if (ch === "'") {
			if (current) tokens.push({ text: current, wasQuoted: false });
			current = "";
			inSingle = true;
		} else if (ch === '"') {
			if (current) tokens.push({ text: current, wasQuoted: false });
			current = "";
			inDouble = true;
		} else if (ch === " " || ch === "\t") {
			if (current) tokens.push({ text: current, wasQuoted: false });
			current = "";
		} else {
			current += ch;
		}
	}
	if (current) {
		tokens.push({ text: current, wasQuoted: inSingle || inDouble });
	}

	// Filter tokens that look like paths (not options/flags/keywords)
	const pathLike = tokens.filter((tok) => {
		const t = tok.text;
		if (tok.wasQuoted) return false; // "some.log", "file.tar" — not paths
		if (t.startsWith("-")) return false; // options like -rf, --verbose
		if (t === "|" || t === ";" || t === "&&" || t === "||") return false;
		if (
			t === ">" ||
			t === ">>" ||
			t === "<" ||
			t === "2>" ||
			t === "2>>" ||
			t === "&>" ||
			t === "1>"
		)
			return false;
		// Skip URLs
		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(t)) return false;
		// Skip npm scoped packages (@scope/name)
		if (t.startsWith("@") && t.includes("/")) return false;
		// Skip standalone tilde (shell home shortcut)
		if (t === "~") return false;
		// Contains path separator or known path indicators
		return t.includes("/") || t.includes(".") || t.includes("~");
	});

	for (const tok of pathLike) {
		const result = checkPath(tok.text, entries, cwd);
		if (result) return result;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	// Defer sync I/O — load on first use, not at module init
	let entries: IgnoreEntry[] | null = null;

	function getEntries(cwd: string): IgnoreEntry[] {
		if (!entries) {
			entries = loadPiIgnore(cwd);
		}
		return entries;
	}

	// Reload patterns on /reload
	pi.on("resources_discover", (_event, ctx) => {
		entries = loadPiIgnore(ctx.cwd);
	});

	// Tools that take a direct path parameter
	const pathTools = ["read", "write", "edit"];
	// Tools that take an optional path/directory parameter
	const optPathTools = ["grep", "find", "ls"];
	// Tools that take a command string containing paths
	const commandTools = ["bash"];

	pi.on("tool_call", async (event, ctx) => {
		const ignoreEntries = getEntries(ctx.cwd);
		let blockedPath: string | null = null;

		if (pathTools.includes(event.toolName)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (optPathTools.includes(event.toolName)) {
			blockedPath = checkPath((event.input as { path?: string }).path, ignoreEntries, ctx.cwd);
		} else if (commandTools.includes(event.toolName)) {
			blockedPath = checkBashCommand(
				(event.input as { command?: string }).command ?? "",
				ignoreEntries,
				ctx.cwd,
			);
		} else {
			return;
		}

		if (blockedPath) {
			if (ctx.hasUI) {
				ctx.ui.notify(`Blocked by .piignore: ${blockedPath}`, "warning");
			}
			return {
				block: true,
				reason: `Path "${blockedPath}" matches .piignore patterns`,
			};
		}
	});
}
