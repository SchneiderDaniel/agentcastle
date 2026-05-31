// ─── NormalizedEvent — discriminated union for unified event processing ──
// Both JSON-line events (from agent-stream) and SDK session events
// (from session-events) are converted to this common representation.
// The discriminant `kind` enables exhaustive type narrowing.

import type { AgentPhase } from "./types";

// ─── NormalizedEvent ─────────────────────────────────────────────

export type NormalizedEvent =
	| { kind: "tool_execution_start"; toolName: string; args?: unknown }
	| { kind: "tool_execution_end"; toolName: string; isError?: boolean }
	| { kind: "thinking_start" }
	| { kind: "thinking_end" }
	| { kind: "thinking_delta"; delta: string }
	| { kind: "text_start" }
	| { kind: "text_end"; usage?: { totalTokens?: number; input?: number; output?: number } }
	| { kind: "text_delta"; delta: string }
	| {
			kind: "message_end";
			message: {
				role: string;
				content?: Array<
					Record<string, unknown> & { type: string; text?: string; thinking?: string }
				>;
				toolName?: string;
				usage?: { totalTokens?: number; input?: number; output?: number };
			};
	  }
	| {
			kind: "done";
			message: {
				content?: Array<
					Record<string, unknown> & { type: string; text?: string; thinking?: string }
				>;
				usage?: { totalTokens?: number; input?: number; output?: number };
			};
	  }
	| { kind: "context_info"; contextTokens: number; contextWindow: number }
	| { kind: "turn_start" }
	| { kind: "turn_end" }
	| { kind: "agent_start" }
	| { kind: "agent_end" }
	| { kind: "session" };

// ─── Return type for event handlers ──────────────────────────────

export interface HandlerResult {
	flush: boolean;
	workingChange: boolean;
}

// ─── phasePriority ───────────────────────────────────────────────

/** Numeric priority for phase ordering. Higher = more important. */
export function phasePriority(phase: AgentPhase): number {
	switch (phase) {
		case "tool":
			return 3;
		case "thinking":
			return 2;
		case "text":
			return 1;
		case "idle":
			return 0;
	}
}
