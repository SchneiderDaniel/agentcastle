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
	suggestRedirection,
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

// ── Guard result constants ──

const PASS = null as ToolCallResult | null;

// ── Handler factory (exported for testing) ──

/**
 * Create a tool_call handler function bound to harness state.
 * Pure function — takes state, returns handler.
 *
 * Guard order:
 *  1. Pass-through tools → always pass, record for cascade reset
 *  2. Error tracking → push to tracker, pass through
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
		const turn = state.currentTurn;

		// ── Guard: undefined/empty toolName → skip recording, pass through ──
		if (!toolName) {
			state.currentTurn++;
			return null;
		}

		const meta = getToolMeta(toolName);

		// ── 1. Pass-through tools → always pass, but record for cascade reset ──
		if (meta.passThrough) {
			state.callCounter.record(toolName, turn);
			state.currentTurn++;
			return null;
		}

		let result: ToolCallResult | null = null;

		// ── 2. Error tracking ──
		if (event.isError) {
			state.errorTracker.push(toolName, { turn, toolName });
			// result stays null → pass through
		}

		// ── 3/4. Error retry & read cache blocking ──
		else {
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
					const cached = state.readCache.get(cacheKey, turn);
					if (cached) {
						result = {
							block: true,
							reason: `Content cached from turn ${cached.turn} — use offset/limit to page or re-read after 3 turns.`,
						};
					} else {
						// Store marker to track that this path+offset+limit was recently read
						state.readCache.set(cacheKey, "[pending]", turn);
					}
				}
			}
		}

		// ── 5. Same-tool cascade detection (skip read — cache handles redundant reads) ──
		// Cascade check uses count + 1 BEFORE recording, accounting for current call
		// without recording it (if blocked, call is not real).
		if (!result && toolName !== "read") {
			const cascadeThreshold = meta.cascadeThreshold ?? CASCADE_THRESHOLD;
			const consecutive = state.callCounter.getConsecutive(toolName);
			// Add 1 for current call (not yet recorded)
			const effectiveCount = consecutive.count + 1;
			if (effectiveCount >= cascadeThreshold) {
				const suggestion =
					toolName === "bash"
						? "Combine bash calls with && or use a script file"
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
						reason: `Use ripgrep_search tool instead of bash grep/rg. ${suggestRedirection(command)}`,
						redirectTo: "ripgrep_search",
					};
				}

				// File read in bash (cat/head/tail) → redirect to read
				else if (isCatHeadTailInBash(command)) {
					result = {
						block: true,
						reason: `Use read tool instead of bash cat/head/tail. ${suggestRedirection(command)}`,
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
		if (!result) {
			state.callCounter.record(toolName, turn);
		}

		// ── 8. Increment turn for every code path, return result ──
		state.currentTurn++;

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

	// Tool_call handler
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
		return createToolCallHandler(state)(event, ctx) ?? undefined;
	});
}
