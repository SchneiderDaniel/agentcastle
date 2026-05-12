/**
 * Context Window Telemetry Extension
 *
 * Emits a single JSON event on stdout reporting initial context window usage
 * when an agent starts. Consumers (supervisor, any JSON-mode client) can parse
 * this to see how much context the system prompt + task consume upfront.
 *
 * Event format:
 *   {"type":"context_info","contextTokens":<number>,"contextWindow":<number>}
 *
 * Design:
 * - Hooks session_start (reset), model_select (capture contextWindow),
 *   message_end (capture usage.input from first assistant response).
 * - Handles race condition: model_select may arrive before or after message_end.
 * - Suppresses emission when contextWindow is missing, undefined, or <= 0.
 * - Suppresses emission when usage.input is missing, <= 0, or role !== "assistant".
 * - Emits exactly once per session.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let contextWindow: number | undefined;
	let contextTokens: number | undefined;
	let emitted = false;

	function tryEmit() {
		if (emitted) return;
		if (contextWindow === undefined || contextWindow <= 0) return;
		if (contextTokens === undefined || contextTokens <= 0) return;
		emitted = true;
		console.log(
			JSON.stringify({
				type: "context_info",
				contextTokens,
				contextWindow,
			}),
		);
	}

	pi.on("session_start", async () => {
		contextWindow = undefined;
		contextTokens = undefined;
		emitted = false;
	});

	pi.on("model_select", async (event) => {
		const cw = event.model?.contextWindow;
		if (typeof cw === "number" && cw > 0) {
			contextWindow = cw;
			tryEmit();
		}
	});

	pi.on("message_end", async (event) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;
		const input = msg.usage?.input;
		if (typeof input === "number" && input > 0) {
			contextTokens = input;
			tryEmit();
		}
	});
}
