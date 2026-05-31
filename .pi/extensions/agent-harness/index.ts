/**
 * agent-harness — Runtime Tool Call Validation Extension
 *
 * Re-exports AgentHarness class from agent-harness.ts.
 * The default export registers pi event handlers using AgentHarness.
 *
 * @packageDocumentation
 */

import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { AgentHarness } from "./agent-harness.ts";

export { AgentHarness, getBashSubKey } from "./agent-harness.ts";
export type { ToolCallResult } from "./agent-harness.ts";

// ── Extension entry point ──

export default function agentHarness(pi: ExtensionAPI): void {
	const harness = new AgentHarness();

	// Session start: initialize fresh state
	pi.on("session_start", async () => {
		harness.reset();
	});

	// Turn start: increment session turn, reset cascade counter, decay error tracker
	pi.on("turn_start", async () => {
		harness.handleTurnStart();
	});

	// Tool_call handler
	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
		return harness.handleToolCall(event, ctx) ?? undefined;
	});
}
