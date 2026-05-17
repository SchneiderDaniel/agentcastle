/**
 * Telemetry emission for context-info extension
 *
 * Emits JSON telemetry on first assistant response.
 */

export function isJsonMode(): boolean {
	const idx = process.argv.indexOf("--mode");
	if (idx !== -1 && idx + 1 < process.argv.length) {
		return process.argv[idx + 1] === "json";
	}
	return false;
}

export function tryEmit(
	ctx: { getContextUsage: () => { tokens?: number; contextWindow?: number } | undefined },
	state: { emitted: boolean; lastContextWindow?: number },
): void {
	if (state.emitted) return;
	if (!state.lastContextWindow || state.lastContextWindow <= 0) return;
	const usage = ctx.getContextUsage();
	if (!usage || typeof usage.tokens !== "number" || usage.tokens <= 0) return;
	state.emitted = true;
	if (isJsonMode()) return;
	console.log(
		JSON.stringify({
			type: "context_info",
			contextTokens: usage.tokens,
			contextWindow: state.lastContextWindow,
		}),
	);
}
