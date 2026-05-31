// ─── Session Event Processors ────────────────────────────────────
// Thin wrapper: converts SDK session events to NormalizedEvent and
// delegates to the shared processNormalizedEvent.
//
// Owns: SessionEvent type, getEventPhase() (backward compat).
// Delegates: processSessionEvent() → sessionEventToNormalizedEvent() + processNormalizedEvent().

import type { AgentRunState, AgentPhase } from "./types.ts";
import { pushLog } from "./agent-stream.ts";
import { sessionEventToNormalizedEvent, processNormalizedEvent } from "./event-adapter.ts";
import { phasePriority } from "./event-types.ts";

// ─── Re-exports for backward compat ───────────────────────────────

export { phasePriority } from "./event-types.ts";

// ─── Session Event Types ───────────────────────────────────────────

/** Typed session event union for SDK events. */
export type SessionEvent = Record<string, unknown> & {
	type: string;
	toolName?: string;
	toolCallId?: string;
	args?: Record<string, unknown>;
	isError?: boolean;
	result?: unknown;
	assistantMessageEvent?: Record<string, unknown> & {
		type: string;
		delta?: string;
		message?: Record<string, unknown> & {
			role?: string;
			content?: Array<Record<string, unknown> & { type: string; text?: string; thinking?: string }>;
			usage?: { totalTokens?: number; input?: number; output?: number };
		};
	};
	message?: Record<string, unknown> & {
		role?: string;
		content?: Array<Record<string, unknown> & { type: string; text?: string; thinking?: string }>;
		toolName?: string;
		usage?: { totalTokens?: number; input?: number; output?: number };
	};
};

// ─── Event → State Mapping ─────────────────────────────────────────

/**
 * Process a single session event — thin wrapper that converts to
 * NormalizedEvent and delegates to the shared processor.
 */
export function processSessionEvent(
	ev: SessionEvent,
	state: AgentRunState,
): { flush: boolean; workingChange: boolean } {
	const normalized = sessionEventToNormalizedEvent(ev);
	if (!normalized) return { flush: false, workingChange: false };
	return processNormalizedEvent(normalized, state);
}

/**
 * Determine phase from a session event.
 * Preserved for backward compat.
 */
export function getEventPhase(ev: SessionEvent): AgentPhase {
	if (!ev) return "idle";
	if (ev.type === "tool_execution_start") return "tool";
	if (ev.type === "tool_execution_end") return "idle";
	if (ev.type === "message_update") {
		const ae = ev.assistantMessageEvent;
		if (!ae) return "idle";
		switch (ae.type) {
			case "thinking_delta":
				if (ae.delta) return "thinking";
				break;
			case "thinking_start":
				return "thinking";
			case "text_delta":
				if (ae.delta) return "text";
				break;
			case "text_start":
				return "text";
			case "thinking_end":
			case "text_end":
				return "idle";
		}
	}
	if (ev.type === "message_end") return "idle";
	return "idle";
}
