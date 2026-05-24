/**
 * agent-harness — Runtime Tool Call Validation Extension
 *
 * Intercepts tool calls pre-execution via pi.on("tool_call") and
 * blocks/redirects known-bad patterns:
 *  - Bash commands using grep/rg instead of ripgrep_search
 *  - Bash commands using cat/head/tail instead of read tool
 *  - Redundant reads (same path+offset+limit within 3 turns)
 *  - Retry loops (same tool after 2+ accumulated errors)
 *  - Same-tool cascades (4+ consecutive calls of same tool)
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
} from "../../lib/harness-rules.ts";

// ── Types ──

export interface ToolCallResult {
	block: boolean;
	reason: string;
	redirectTo?: string;
}

interface ToolCallEvent {
	input: {
		toolName: string;
		args: Record<string, unknown>;
	};
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
 * Logic order (priority descending):
 * 1. Pass-through / unintercepted tools → null
 * 2. Error tracking → push to tracker, pass through
 * 3. Error retry blocking → if >=2 errors, block
 * 4. Read caching → cache hit blocks with cached info
 * 5. Cascade detection → 4+ consecutive blocks
 * 6. Tool mismatch (bash) → block with redirect
 * 7. Default → pass through
 */
export function createToolCallHandler(state: HarnessState) {
	return function handleToolCall(
		event: ToolCallEvent,
		_ctx: ToolCallContext,
	): ToolCallResult | null {
		const { toolName, args } = event.input;
		const turn = state.currentTurn;

		// ── 1. Pass-through tools ──
		if (PASS_THROUGH_TOOLS.has(toolName)) {
			state.currentTurn++;
			return null;
		}

		// ── 2. Error tracking ──
		// If this call errored, track it and let the error pass through
		if (event.isError) {
			state.errorTracker.push(toolName, { turn, toolName });
			state.currentTurn++;
			return null;
		}

		// ── 3. Error retry blocking ──
		// After 2+ accumulated errors on same tool, block retry
		const errors = state.errorTracker.getLastErrors(toolName);
		if (errors.length >= 2) {
			const lastErrorTurn = errors[errors.length - 1]?.turn ?? 0;
			return {
				block: true,
				reason: `Tool ${toolName} errored ${errors.length}x (last turn ${lastErrorTurn}). Try a different approach or tool instead of retrying.`,
			};
		}

		// ── 4. Read caching ──
		if (toolName === "read") {
			const path = (args.path ?? "") as string;
			if (path) {
				const offset = (args.offset ?? 0) as number;
				const limit = (args.limit ?? "") as number;
				const cacheKey = `${path}|${offset}|${limit}`;
				const cached = state.readCache.get(cacheKey, turn);
				if (cached) {
					return {
						block: true,
						reason: `Content cached from turn ${cached.turn} — use offset/limit to page or re-read after 3 turns.`,
					};
				}
				// Store marker to track that this path+offset+limit was recently read
				state.readCache.set(cacheKey, "[pending]", turn);
			}
		}

		// ── 5. Same-tool cascade detection ──
		state.callCounter.record(toolName, turn);
		const consecutive = state.callCounter.getConsecutive(toolName);
		if (consecutive.count >= 4) {
			const suggestion =
				toolName === "bash"
					? "Combine bash calls with && or use a script file"
					: toolName === "read"
						? "Batch reads — read larger portions in one call"
						: `Batch ${toolName} calls to reduce turns`;

			return {
				block: true,
				reason: `Same-tool cascade: ${toolName} called ${consecutive.count}x consecutively. ${suggestion}.`,
			};
		}

		// ── 6. Tool mismatch detection (bash only) ──
		if (toolName === "bash") {
			const command = (args.command ?? "") as string;
			if (!command) return null;

			// Search in bash (grep/rg) → redirect to ripgrep_search
			if (isSearchInBash(command)) {
				return {
					block: true,
					reason: `Use ripgrep_search tool instead of bash grep/rg. ${suggestRedirection(command)}`,
					redirectTo: "ripgrep_search",
				};
			}

			// File read in bash (cat/head/tail) → redirect to read
			if (isCatHeadTailInBash(command)) {
				return {
					block: true,
					reason: `Use read tool instead of bash cat/head/tail. ${suggestRedirection(command)}`,
					redirectTo: "read",
				};
			}

			// ls is informational only — pass through at runtime (not blocked)
		}

		// ── 7. Increment turn and pass through ──
		state.currentTurn++;
		return null;
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
