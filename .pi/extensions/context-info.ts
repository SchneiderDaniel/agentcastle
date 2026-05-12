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
 * - Hooks session_start (reset + capture contextWindow from ctx.model),
 *   model_select (capture contextWindow on explicit model change),
 *   message_end (capture context usage via ctx.getContextUsage()).
 * - Uses ctx.getContextUsage() instead of raw API usage.input because
 *   provider-reported input tokens often exclude cached/system prompt tokens
 *   and don't match pi's cumulative context estimate.
 * - model_select only fires on explicit model changes, not at startup.
 *   So session_start also reads ctx.model.contextWindow for initial load.
 * - Emits exactly once per session (console.log for supervisor).
 * - Updates status bar (ctx.ui.setStatus) on every relevant event for live TUI display.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
    let contextWindow: number | undefined;
    let contextTokens: number | undefined;
    let emitted = false;

    function formatStatus(): string {
        if (contextTokens === undefined || contextTokens <= 0)
            return "/ Context: …";
        return `/ Context: ${(contextTokens / 1000).toFixed(1)}K`;
    }

    function emit(ctx: ExtensionContext) {
        ctx.ui.setStatus("context-info", formatStatus());
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

    pi.on("session_start", async (_event, ctx) => {
        contextWindow = undefined;
        contextTokens = undefined;
        emitted = false;
        // model_select only fires on explicit model change, not at startup.
        // Grab contextWindow from the already-loaded model.
        const cw = ctx.model?.contextWindow;
        if (typeof cw === "number" && cw > 0) {
            contextWindow = cw;
        }
        ctx.ui.setStatus("context-info", formatStatus());
    });

    pi.on("model_select", async (event, ctx) => {
        const cw = event.model?.contextWindow;
        if (typeof cw === "number" && cw > 0) {
            contextWindow = cw;
            emit(ctx);
        } else {
            ctx.ui.setStatus("context-info", formatStatus());
        }
    });

    pi.on("message_end", async (event, ctx) => {
        const msg = event.message;
        if (!msg || msg.role !== "assistant") return;
        // Prefer pi's own context calculation over raw API usage.input.
        // API-reported input tokens often exclude cached/system prompt tokens
        // and don't match pi's cumulative context estimate.
        const usage = ctx.getContextUsage();
        if (usage && typeof usage.tokens === "number" && usage.tokens > 0) {
            contextTokens = usage.tokens;
            contextWindow = usage.contextWindow;
            emit(ctx);
        }
    });
}
