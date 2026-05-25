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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHarnessState } from "../../lib/harness-state.ts";
import type { HarnessState } from "../../lib/harness-state.ts";
import {
	isSearchInBash,
	isCatHeadTailInBash,
	suggestRedirection,
	CASCADE_THRESHOLD,
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
		notify?: (msg: string, level?: string) => void;
	};
}

// ── Pass-through tools (never blocked) ──

const PASS_THROUGH_TOOLS = new Set(["structural_search", "ripgrep_search", "ranked_map"]);

// ── Handler factory (exported for testing) ──

/**
 * Create a tool_call handler function bound to harness state.
 * Pure function — takes state, returns handler.
 *
 * Single-exit pattern: compute result in local var, increment turn once, return.
 * Invariant: every code path calls record() + currentTurn++ exactly once.
 *
 * Logic order (priority descending):
 * 0. record() EVERY tool call (before pass-through check) ← fix Bug 1
 * 1. Pass-through / unintercepted tools → null
 * 2. Error tracking → push to tracker, pass through
 * 3. Error retry blocking → if >=2 errors, block
 * 4. Read caching → cache hit blocks with cached info
 * 5. Cascade detection → consecutive blocks
 * 6. Tool mismatch (bash) → block with redirect
 * 7. Increment turn (all paths), return result
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

		// ── Step 0: Record EVERY tool call for cascade detection ──
		// Before pass-through check so pass-through tools also reset consecutive counter.
		state.callCounter.record(toolName, turn);

		let result: ToolCallResult | null = null;

		// ── 1. Pass-through tools ──
		if (PASS_THROUGH_TOOLS.has(toolName)) {
			// result stays null → pass through
		}

		// ── 2. Error tracking ──
		else if (event.isError) {
			state.errorTracker.push(toolName, { turn, toolName });
			// result stays null → pass through
		}

		// ── 3/4/5/6. Blocking checks ──
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

			// ── 5. Same-tool cascade detection ──
			if (!result) {
				const consecutive = state.callCounter.getConsecutive(toolName);
				if (consecutive.count >= CASCADE_THRESHOLD) {
					const suggestion =
						toolName === "bash"
							? "Combine bash calls with && or use a script file"
							: toolName === "read"
								? "Batch reads — read larger portions in one call"
								: `Batch ${toolName} calls to reduce turns`;

					result = {
						block: true,
						reason: `Same-tool cascade: ${toolName} called ${consecutive.count}x consecutively. ${suggestion}.`,
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
		}

		// ── 7. Increment turn for EVERY code path ──
		// Fixes Bug 2: block paths, early returns all increment
		// Fixes Bug 3: bash empty-command path increments
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
	pi.on("tool_call", async (event, ctx) => {
		return createToolCallHandler(state)(event, ctx);
	});
}
