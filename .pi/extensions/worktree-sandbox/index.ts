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

function isCdSafe(cdTarget: string, sandboxRoot: string): boolean {
	if (cdTarget.startsWith("/")) {
		return isPathWithinSandbox(cdTarget, sandboxRoot);
	}
	const resolved = resolvePath(sandboxRoot, cdTarget);
	return isPathWithinSandbox(resolved, sandboxRoot);
}

function findUnsafeCd(command: string, sandboxRoot: string): string | null {
	const cdRegex = /(?:^|&&|;|\|\|)\s*cd\s+(\S+)/g;
	let match: RegExpExecArray | null;
	while ((match = cdRegex.exec(command)) !== null) {
		const target = match[1]!;
		if (target === "-") continue;
		if (!isCdSafe(target, sandboxRoot)) {
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

			const unsafeTarget = findUnsafeCd(originalCommand, sandboxRoot);
			if (unsafeTarget) {
				if (ctx.hasUI) {
					ctx.ui.notify(`[sandbox] Blocked cd to outside worktree: ${unsafeTarget}`, "warning");
				}
				return {
					block: true,
					reason: `Command tries to cd to "${unsafeTarget}" which is outside the worktree. Working directory cannot escape the worktree (${sandboxRoot}).`,
				};
			}

			const rewrittenCommand = `cd "${sandboxRoot}" && ${originalCommand}`;
			event.input.command = rewrittenCommand;
			return undefined;
		}

		return undefined;
	});
}
