/**
 * agent-harness — Runtime Tool Call Validation Extension
 *
 * Intercepts tool calls pre-execution via pi.on("tool_call") and
 * blocks/redirects known-bad patterns:
 *  - Bash commands using grep/rg instead of ripgrep_search
 *  - Bash commands using cat/head/tail instead of read tool
 *  - Redundant reads (same path+offset+limit within 3 turns)
 *  - Retry loops (same tool after 2+ accumulated errors)
 *  - Same-tool cascades (8+ consecutive calls of same tool)
 *
 * State is fresh per-session (created in session_start handler).
 * Complements session-advice (post-hoc analysis) with runtime prevention.
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createHarnessState } from "../../lib/harness-state.ts";
import type { HarnessState } from "../../lib/harness-state.ts";
import {
	isSearchInBash,
	isCatHeadTailInBash,
	isFileModifyingBash,
	buildRedirectMessage,
	MULTI_VERB_TOOLS,
	CASCADE_THRESHOLD,
	getToolMeta,
} from "../../lib/harness-rules.ts";

// ── Types ──

export interface ToolCallResult {
	block: boolean;
	reason: string;
	redirectTo?: string;
}

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
	isError?: boolean;
}

interface ToolCallContext {
	sessionManager?: {
		getCwd?: () => string;
	};
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

// ── Helpers ──

/**
 * Extract bash sub-key for sub-command-aware cascade detection.
 * Multi-verb CLIs (git, npm, docker, gh, etc.) use first 2 tokens.
 * Single-verb commands (cat, echo, ls, etc.) use first token only.
 * Empty → undefined.
 */
export function getBashSubKey(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;

	const tokens = trimmed.split(/\s+/);
	if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "")) return undefined;

	// Determine which tokens form the sub-command
	// If command starts with cd <path> &&, strip navigation prefix
	let subKeyTokens: string[];
	if (tokens[0] === "cd") {
		const andAndIndex = tokens.indexOf("&&");
		if (andAndIndex > 0) {
			// Extract subKey from tokens after && (the real command)
			subKeyTokens = tokens.slice(andAndIndex + 1);
		} else {
			// Bare cd (no &&) — cd IS the command
			subKeyTokens = tokens;
		}
	} else {
		subKeyTokens = tokens;
	}

	if (subKeyTokens.length === 0) return undefined;

	if (MULTI_VERB_TOOLS.has(subKeyTokens[0]) && subKeyTokens.length > 1) {
		return `${subKeyTokens[0]} ${subKeyTokens[1]}`;
	}

	return subKeyTokens[0];
}

// ── Handler factory (exported for testing) ──

/**
 * Create a tool_call handler function bound to harness state.
 * Pure function — takes state, returns handler.
 *
 * Guard order:
 *  1. Pass-through tools → always pass, record for cascade reset
 *  2. Error tracking → push to tracker, pass through
 *  2.5 Cache invalidation → write/file-modifying bash clears read cache
 *  3. Error retry blocking → if >=2 errors, block
 *  4. Read caching → cache hit blocks with cached info
 *  5. Cascade detection → consecutive blocks (8+ legit calls)
 *  6. Tool mismatch (bash) → block with redirect
 *  7. Record if not blocked (blocked calls don't inflate cascade counter)
 *
 * Blocked calls (any guard) are NOT recorded (Bug 5 fix).
 * Cascade check uses count + 1 before recording to account for current call.
 * Pass-through tools recorded separately to reset cascade counter.
 */
export function createToolCallHandler(state: HarnessState) {
	return function handleToolCall(
		event: ToolCallEvent,
		_ctx: ToolCallContext,
	): ToolCallResult | null {
		const toolName = event.toolName;
		const args = event.input ?? {};
		const toolCallIndex = state.toolCallIndex;
		const sessionTurn = state.sessionTurn;

		// ── Guard: undefined/empty toolName → skip recording, pass through ──
		if (!toolName) {
			state.toolCallIndex++;
			return null;
		}

		const meta = getToolMeta(toolName);

		// ── 1. Pass-through tools → always pass, but record for cascade reset ──
		if (meta.passThrough) {
			state.callCounter.record(toolName, sessionTurn, toolCallIndex);
			state.toolCallIndex++;
			return null;
		}

		let result: ToolCallResult | null = null;

		// ── 2. Error tracking ──
		if (event.isError) {
			state.errorTracker.push(toolName, { turn: toolCallIndex, toolName });
			// result stays null → pass through
		}

		// ── 2.5 Cache invalidation (before blocking guards) ──
		// File-modifying tool calls invalidate the read cache
		if (toolName === "write") {
			state.readCache.clear();
		} else if (toolName === "bash") {
			const command = (args.command ?? "") as string;
			if (command && isFileModifyingBash(command)) {
				state.readCache.clear();
			}
		}

		// ── 3/4. Error retry & read cache blocking ──
		// Only runs for non-error events
		if (!event.isError) {
			// ── 3. Error retry blocking ──
			const errors = state.errorTracker.getLastErrors(toolName);
			if (errors.length >= 2) {
				const lastErrorTurn = errors[errors.length - 1]?.turn ?? 0;
				result = {
					block: true,
					reason: `Tool ${toolName} errored ${errors.length}x (last turn ${lastErrorTurn}). Try a different approach or tool instead of retrying.`,
				};
			}

			// ── 4. Read caching ──
			else if (toolName === "read") {
				const path = (args.path ?? "") as string;
				if (path) {
					const offset = (args.offset ?? 0) as number;
					const limit = (args.limit ?? "") as number;
					const cacheKey = `${path}|${offset}|${limit}`;
					const cached = state.readCache.get(cacheKey, toolCallIndex, state.batchId);
					if (cached) {
						// Same-turn [pending] → pass through (let re-read happen)
						if (cached.content === "[pending]" && cached.turn === toolCallIndex) {
							// result stays null, pass through
						} else {
							result = {
								block: true,
								reason: `Content cached from turn ${cached.turn} — use offset/limit to page or re-read after 3 turns.`,
							};
						}
					} else {
						// Store marker to track that this path+offset+limit was recently read
						state.readCache.set(cacheKey, "[pending]", toolCallIndex, state.batchId);
					}
				}
			}
		}

		// ── Extract bash subKey for sub-command-aware cascade detection ──
		// First 2 tokens of bash command become subKey. Empty/absent command → undefined.
		const bashSubKey =
			toolName === "bash" ? getBashSubKey((args.command ?? "") as string) : undefined;

		// ── 5. Same-tool cascade detection (skip read — cache handles redundant reads) ──
		// Cascade check uses count + 1 BEFORE recording, accounting for current call
		// without recording it (if blocked, call is not real).
		// Uses bashSubKey for sub-command-aware cascade (Bug 3 fix).
		if (!result && toolName !== "read") {
			const cascadeThreshold = meta.cascadeThreshold ?? CASCADE_THRESHOLD;
			const consecutive = state.callCounter.getConsecutive(toolName, bashSubKey);
			// Add 1 for current call (not yet recorded)
			const effectiveCount = consecutive.count + 1;
			if (effectiveCount >= cascadeThreshold) {
				const commandStr = (args.command ?? "") as string;
				const suggestion =
					toolName === "bash"
						? commandStr.includes("&&")
							? "Reduce per-turn call count — commands already use && for batching"
							: "Combine bash calls with && or use a script file"
						: toolName === "read"
							? "Batch reads — read larger portions in one call"
							: `Batch ${toolName} calls to reduce turns`;

				result = {
					block: true,
					reason: `Same-tool cascade: ${toolName} called ${effectiveCount}x consecutively. ${suggestion}.`,
				};
			}
		}

		// ── 6. Tool mismatch detection (bash only) ──
		if (!result && toolName === "bash") {
			const command = (args.command ?? "") as string;
			if (command) {
				// Search in bash (grep/rg) → redirect to ripgrep_search
				if (isSearchInBash(command)) {
					result = {
						block: true,
						reason: buildRedirectMessage("ripgrep_search"),
						redirectTo: "ripgrep_search",
					};
				}

				// File read in bash (cat/head/tail) → redirect to read
				else if (isCatHeadTailInBash(command)) {
					result = {
						block: true,
						reason: buildRedirectMessage("read"),
						redirectTo: "read",
					};
				}
				// ls is informational only — pass through at runtime (not blocked)
			}
			// Empty/null command: result stays null (pass through)
		}

		// ── 7. Record only if NOT blocked ──
		// Blocked calls (any guard) are NOT recorded (Bug 5 fix)
		// so they don't inflate the cascade counter.
		// Uses bashSubKey for sub-command-aware cascade (Bug 3 fix).
		if (!result) {
			state.callCounter.record(toolName, sessionTurn, toolCallIndex, bashSubKey);
		}

		// ── 8. Increment toolCallIndex for every code path, return result ──
		state.toolCallIndex++;

		return result;
	};
}

// ── Extension entry point ──

export default function agentHarness(pi: ExtensionAPI): void {
	let state: HarnessState = createHarnessState();

	// Session start: initialize fresh state
	pi.on("session_start", async () => {
		state = createHarnessState();
	});

	// Turn start: increment session turn and reset cascade counter
	pi.on("turn_start", async () => {
		state.sessionTurn++;
		state.callCounter.turnBoundaryReset();
	});

	// Tool_call handler
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
		return createToolCallHandler(state)(event, ctx) ?? undefined;
	});
}
