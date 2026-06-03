// ─── Tests: diagnostics.ts — pure diagnostic functions ────────────

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	calculateIdleWarning,
	buildEventGapEntry,
	buildErrorNotificationContext,
} from "../config/diagnostics.ts";

// ─── calculateIdleWarning ────────────────────────────────────────

describe("calculateIdleWarning", () => {
	const THRESHOLD_MS = 15_000;
	let now: number;

	beforeEach(() => {
		now = Date.now();
	});

	it("returns null when lastEventTime is undefined", () => {
		assert.equal(calculateIdleWarning(now, undefined, THRESHOLD_MS), null);
	});

	it("returns null when elapsed is under threshold", () => {
		const lastEventTime = now - 5_000; // 5s ago
		assert.equal(calculateIdleWarning(now, lastEventTime, THRESHOLD_MS), null);
	});

	it("returns null when elapsed equals threshold (no warning at boundary)", () => {
		const lastEventTime = now - THRESHOLD_MS;
		assert.equal(calculateIdleWarning(now, lastEventTime, THRESHOLD_MS), null);
	});

	it("returns warning string when elapsed exceeds threshold", () => {
		const lastEventTime = now - 20_000; // 20s ago
		const result = calculateIdleWarning(now, lastEventTime, THRESHOLD_MS);
		assert.ok(result);
		assert.ok(result!.includes("No events for"));
		assert.ok(result!.includes("20"));
	});

	it("includes correct elapsed seconds in warning", () => {
		const lastEventTime = now - 60_000; // 60s ago
		const result = calculateIdleWarning(now, lastEventTime, THRESHOLD_MS);
		assert.ok(result!.includes("60s"));
	});

	it("works with zero threshold (always warn if elapsed > 0)", () => {
		const lastEventTime = now - 1;
		assert.ok(calculateIdleWarning(now, lastEventTime, 0));
	});

	it("handles negative elapsed (future timestamp)", () => {
		const lastEventTime = now + 10_000; // future
		assert.equal(calculateIdleWarning(now, lastEventTime, THRESHOLD_MS), null);
	});
});

// ─── buildEventGapEntry ──────────────────────────────────────────

describe("buildEventGapEntry", () => {
	const GAP_THRESHOLD_MS = 30_000;
	let now: number;

	beforeEach(() => {
		now = Date.now();
	});

	it("returns undefined when lastEventTime is undefined", () => {
		assert.equal(buildEventGapEntry(now, undefined, GAP_THRESHOLD_MS), undefined);
	});

	it("returns undefined when gap is under threshold", () => {
		const lastEventTime = now - 10_000;
		assert.equal(buildEventGapEntry(now, lastEventTime, GAP_THRESHOLD_MS), undefined);
	});

	it("returns undefined at exact boundary", () => {
		const lastEventTime = now - GAP_THRESHOLD_MS;
		assert.equal(buildEventGapEntry(now, lastEventTime, GAP_THRESHOLD_MS), undefined);
	});

	it("returns entry with level 'warn' when gap exceeds threshold", () => {
		const lastEventTime = now - 45_000;
		const result = buildEventGapEntry(now, lastEventTime, GAP_THRESHOLD_MS);
		assert.ok(result);
		assert.equal(result!.level, "warn");
		assert.ok(result!.message.includes("45"));
		assert.ok(result!.message.includes("gap"));
	});

	it("returns correct elapsed seconds in message", () => {
		const lastEventTime = now - 120_000; // 2 min
		const result = buildEventGapEntry(now, lastEventTime, GAP_THRESHOLD_MS);
		assert.ok(result!.message.includes("120s"));
		assert.ok(result!.message.includes(String(GAP_THRESHOLD_MS)));
	});
});

// ─── buildErrorNotificationContext ────────────────────────────────

describe("buildErrorNotificationContext", () => {
	it("includes event type and error message", () => {
		const event = { type: "tool_execution_start", toolName: "read" };
		const error = new Error("Something broke");
		const result = buildErrorNotificationContext(event, error);
		assert.ok(result.includes("tool_execution_start"));
		assert.ok(result.includes("Something broke"));
	});

	it("includes timestamp in HH:MM:SS format", () => {
		const event = { type: "message_update" };
		const error = new Error("test");
		const result = buildErrorNotificationContext(event, error);
		assert.ok(/\[\d{2}:\d{2}:\d{2}\]/.test(result));
	});

	it("handles string error", () => {
		const event = { type: "text_delta" };
		const result = buildErrorNotificationContext(event, "just a string");
		assert.ok(result.includes("text_delta"));
		assert.ok(result.includes("just a string"));
	});

	it("handles null event (no type)", () => {
		const error = new Error("null event");
		const result = buildErrorNotificationContext(null, error);
		assert.ok(result.includes("unknown"));
		assert.ok(result.includes("null event"));
	});

	it("handles non-object event", () => {
		const result = buildErrorNotificationContext("raw string", new Error("err"));
		assert.ok(result.includes("unknown"));
		assert.ok(result.includes("err"));
	});

	it("includes Event error prefix in context", () => {
		const event = { type: "thinking_delta" };
		const error = new Error("delta too large");
		const result = buildErrorNotificationContext(event, error);
		assert.ok(result.includes("Event error"));
		assert.ok(result.includes("thinking_delta"));
		assert.ok(result.includes("delta too large"));
	});
});
