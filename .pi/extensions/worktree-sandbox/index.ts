/**
 * Worktree Sandbox Extension
 *
 * Enforces that developer/auditor agents operate ONLY within their assigned
 * git worktree. Intercepts tool calls and rewrites paths to target the
 * worktree instead of the main checkout.
 *
 * Deterministic enforcement — not prompt-level, not behavioral.
 * LLM cannot bypass because tool input mutation runs before execution.
 *
 * Activation: set WORKTREE_SANDBOX_PATH env var to the worktree root.
 * When unset, all handlers pass through (no-op mode).
 *
 * Sandbox rules:
 *   read/write/edit: relative paths -> prepend worktree root.
 *                     absolute paths -> block if outside worktree.
 *   bash:            prepend `cd worktree &&` to every command.
 *                     block/reject cd commands that escape worktree.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// ─── Constants ──────────────────────────────────────────────────────

const SANDBOX_ENV_KEY = "WORKTREE_SANDBOX_PATH";

// ─── Helpers ────────────────────────────────────────────────────────

function getSandboxRoot(): string | null {
	const root = process.env[SANDBOX_ENV_KEY];
	if (!root || !root.trim()) return null;
	const normalized = resolvePath(root.trim());
	if (!normalized) return null;
	if (!existsSync(normalized)) return null;
	if (!statSync(normalized).isDirectory()) return null;
	return normalized;
}

function isPathWithinSandbox(absolutePath: string, sandboxRoot: string): boolean {
	return absolutePath === sandboxRoot || absolutePath.startsWith(sandboxRoot + "/");
}

function isPathSafe(target: string, sandboxRoot: string): boolean {
	if (target.startsWith("/")) {
		return isPathWithinSandbox(target, sandboxRoot);
	}
	const resolved = resolvePath(sandboxRoot, target);
	return isPathWithinSandbox(resolved, sandboxRoot);
}

function findUnsafeCd(command: string, sandboxRoot: string): string | null {
	const cdRegex = /(?:^|&&|;|\|\|)\s*cd\s+(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = cdRegex.exec(command)) !== null) {
		const target = match[1]!;
		if (target === "-") continue;
		if (!isPathSafe(target, sandboxRoot)) {
			return target;
		}
	}
	return null;
}

/**
 * Detect bash file writes to absolute paths outside the sandbox.
 * Catches: echo > /abs/path, cp /src /abs/dst, mv /src /abs/dst, touch /abs/file
 */
function findUnsafeWriteInBash(command: string, sandboxRoot: string): string | null {
	// Shell redirects: > /abs/path or >> /abs/path (with optional fd number like 2>)
	const redirectRegex = /(?:^|[^a-zA-Z])(?:\d*[>]|[>][>])\s*(\/[^\s"'|;&]+)/g;
	let match: RegExpExecArray | null;
	while ((match = redirectRegex.exec(command)) !== null) {
		const target = match[1]!;
		if (!isPathSafe(target, sandboxRoot)) {
			return target;
		}
	}

	// cp destination: `cp <src> <dst>` — the last non-flag arg is the destination
	const cpMatch = command.match(/\bcp\s+.*\s+(\/[^\s"'|;&]+)\s*$/);
	if (cpMatch && !isPathSafe(cpMatch[1]!, sandboxRoot)) {
		return cpMatch[1]!;
	}

	// mv destination: same as cp
	const mvMatch = command.match(/\bmv\s+.*\s+(\/[^\s"'|;&]+)\s*$/);
	if (mvMatch && !isPathSafe(mvMatch[1]!, sandboxRoot)) {
		return mvMatch[1]!;
	}

	// touch path
	const touchRegex = /\btouch\s+(\/[^\s"'|;&]+)/g;
	while ((match = touchRegex.exec(command)) !== null) {
		const target = match[1]!;
		if (!isPathSafe(target, sandboxRoot)) {
			return target;
		}
	}

	return null;
}

// ─── Export ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const sandboxRoot = getSandboxRoot();
		if (!sandboxRoot) {
			return undefined;
		}

		// ── read tool ──────────────────────────────────────────────
		if (isToolCallEventType("read", event)) {
			const originalPath = event.input.path as string;
			if (!originalPath) return undefined;

			if (originalPath.startsWith("/")) {
				if (!isPathWithinSandbox(originalPath, sandboxRoot)) {
					if (ctx.hasUI) {
						ctx.ui.notify(`[sandbox] Blocked read to outside worktree: ${originalPath}`, "warning");
					}
					return {
						block: true,
						reason: `Path "${originalPath}" is outside the worktree. All file operations must stay within the worktree.`,
					};
				}
				return undefined;
			}

			const rewritten = resolvePath(sandboxRoot, originalPath);
			if (!isPathWithinSandbox(rewritten, sandboxRoot)) {
				return { block: true, reason: `Path "${originalPath}" resolves outside the worktree.` };
			}
			event.input.path = rewritten;
			return undefined;
		}

		// ── write tool ─────────────────────────────────────────────
		if (isToolCallEventType("write", event)) {
			const originalPath = event.input.path as string;
			if (!originalPath) return undefined;

			if (originalPath.startsWith("/")) {
				if (!isPathWithinSandbox(originalPath, sandboxRoot)) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`[sandbox] Blocked write to outside worktree: ${originalPath}`,
							"warning",
						);
					}
					return {
						block: true,
						reason: `Path "${originalPath}" is outside the worktree. All writes must stay within the worktree.`,
					};
				}
				return undefined;
			}

			const rewritten = resolvePath(sandboxRoot, originalPath);
			if (!isPathWithinSandbox(rewritten, sandboxRoot)) {
				return { block: true, reason: `Path "${originalPath}" resolves outside the worktree.` };
			}
			event.input.path = rewritten;
			return undefined;
		}

		// ── edit tool ─────────────────────────────────────────────
		if (isToolCallEventType("edit", event)) {
			const originalPath = event.input.path as string;
			if (!originalPath) return undefined;

			if (originalPath.startsWith("/")) {
				if (!isPathWithinSandbox(originalPath, sandboxRoot)) {
					if (ctx.hasUI) {
						ctx.ui.notify(`[sandbox] Blocked edit to outside worktree: ${originalPath}`, "warning");
					}
					return {
						block: true,
						reason: `Path "${originalPath}" is outside the worktree. Edits must stay within the worktree.`,
					};
				}
				return undefined;
			}

			const rewritten = resolvePath(sandboxRoot, originalPath);
			if (!isPathWithinSandbox(rewritten, sandboxRoot)) {
				return { block: true, reason: `Path "${originalPath}" resolves outside the worktree.` };
			}
			event.input.path = rewritten;
			return undefined;
		}

		// ── bash tool ──────────────────────────────────────────────
		if (isToolCallEventType("bash", event)) {
			const originalCommand = event.input.command as string;
			if (!originalCommand) return undefined;

			// Block cd commands that escape worktree
			const unsafeCd = findUnsafeCd(originalCommand, sandboxRoot);
			if (unsafeCd) {
				if (ctx.hasUI) {
					ctx.ui.notify(`[sandbox] Blocked cd to outside worktree: ${unsafeCd}`, "warning");
				}
				return {
					block: true,
					reason: `Command tries to cd to "${unsafeCd}" which is outside the worktree. Working directory cannot escape the worktree (${sandboxRoot}).`,
				};
			}

			// Block file writes via bash to absolute paths outside worktree
			const unsafeWrite = findUnsafeWriteInBash(originalCommand, sandboxRoot);
			if (unsafeWrite) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`[sandbox] Blocked bash write to outside worktree: ${unsafeWrite}`,
						"warning",
					);
				}
				return {
					block: true,
					reason: `Command writes to "${unsafeWrite}" which is outside the worktree. All file writes via bash must target paths within the worktree (${sandboxRoot}).`,
				};
			}

			const rewrittenCommand = `cd "${sandboxRoot}" && ${originalCommand}`;
			event.input.command = rewrittenCommand;
			return undefined;
		}

		return undefined;
	});
}
