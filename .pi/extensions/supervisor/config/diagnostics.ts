// ─── Diagnostics — pure functions for observability ────────────────
// Phase 1: Diagnostic output for event processing errors, idle detection,
// and gap warnings. All functions are pure — no side effects.

// ─── Idle Warning ──────────────────────────────────────────────────

/**
 * Calculate an idle warning string when no events have been received
 * for longer than the specified threshold.
 *
 * @param now - Current timestamp (ms since epoch)
 * @param lastEventTime - Timestamp of the last received event (ms since epoch)
 * @param thresholdMs - Idle threshold in milliseconds
 * @returns Warning string if idle exceeds threshold, null otherwise
 */
export function calculateIdleWarning(
	now: number,
	lastEventTime: number | undefined,
	thresholdMs: number,
): string | null {
	if (lastEventTime === undefined) return null;
	const elapsed = now - lastEventTime;
	if (elapsed > thresholdMs) {
		const seconds = Math.round(elapsed / 1000);
		return `⚠ No events for ${seconds}s`;
	}
	return null;
}

// ─── Event Gap Detection ──────────────────────────────────────────

/**
 * Build a log entry when the gap since the last event exceeds a threshold.
 *
 * @param now - Current timestamp (ms since epoch)
 * @param lastEventTime - Timestamp of the last received event (ms since epoch)
 * @param gapThresholdMs - Gap threshold in milliseconds
 * @returns Log entry object if gap exceeds threshold, undefined otherwise
 */
export function buildEventGapEntry(
	now: number,
	lastEventTime: number | undefined,
	gapThresholdMs: number,
): { level: "warn"; message: string } | undefined {
	if (lastEventTime === undefined) return undefined;
	const elapsed = now - lastEventTime;
	if (elapsed > gapThresholdMs) {
		const seconds = Math.round(elapsed / 1000);
		return {
			level: "warn",
			message: `[gap] No events for ${seconds}s (threshold: ${gapThresholdMs}ms)`,
		};
	}
	return undefined;
}

// ─── Error Notification Context ───────────────────────────────────

/**
 * Build a formatted notification string from an event processing error.
 * Includes event type, error message, and timestamp.
 *
 * @param event - The event that caused the error (any shape)
 * @param error - The error that was thrown
 * @returns Formatted notification string
 */
export function buildErrorNotificationContext(event: unknown, error: unknown): string {
	const eventType =
		event && typeof event === "object" && "type" in event
			? String((event as Record<string, unknown>).type)
			: "unknown";
	const errorMsg = error instanceof Error ? error.message : String(error);
	const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
	return `[${ts}] Event error (${eventType}): ${errorMsg}`;
}
