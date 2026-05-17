/**
 * Tests for session-logger/stats.ts — usage aggregation
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test test/session-logger-stats.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createSessionStats } from "../.pi/extensions/session-logger/stats.ts";
import type { Usage } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// createSessionStats — pure aggregation unit tests
// ---------------------------------------------------------------------------

describe("createSessionStats", () => {
	it("returns snapshot with zero values initially", () => {
		const stats = createSessionStats();
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 0);
		assert.strictEqual(snap.totalOutputTokens, 0);
		assert.strictEqual(snap.totalCacheRead, 0);
		assert.strictEqual(snap.totalCacheWrite, 0);
		assert.strictEqual(snap.totalCost, 0);
		assert.strictEqual(snap.compactionCount, 0);
		assert.deepStrictEqual(snap.modelChanges, []);
		assert.deepStrictEqual(snap.thinkingChanges, []);
	});

	it("addUsage accumulates input tokens across multiple calls", () => {
		const stats = createSessionStats();
		stats.addUsage({
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		stats.addUsage({
			input: 200,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 300);
	});

	it("addUsage accumulates output tokens", () => {
		const stats = createSessionStats();
		stats.addUsage({
			input: 0,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		stats.addUsage({
			input: 0,
			output: 75,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 75,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalOutputTokens, 125);
	});

	it("addUsage accumulates cache read/write", () => {
		const stats = createSessionStats();
		stats.addUsage({
			input: 0,
			output: 0,
			cacheRead: 30,
			cacheWrite: 10,
			totalTokens: 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		stats.addUsage({
			input: 0,
			output: 0,
			cacheRead: 20,
			cacheWrite: 5,
			totalTokens: 25,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalCacheRead, 50);
		assert.strictEqual(snap.totalCacheWrite, 15);
	});

	it("addUsage accumulates cost", () => {
		const stats = createSessionStats();
		stats.addUsage({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		});
		stats.addUsage({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0.004, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.009 },
		});
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalCost, 0.012);
	});

	it("addUsage handles undefined usage gracefully", () => {
		const stats = createSessionStats();
		stats.addUsage(undefined as unknown as Usage);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 0);
	});

	it("addUsage handles partial usage gracefully", () => {
		const stats = createSessionStats();
		stats.addUsage({ input: 100 } as Usage);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 100);
		assert.strictEqual(snap.totalOutputTokens, 0);
		assert.strictEqual(snap.totalCost, 0);
	});

	it("addUsage handles usage without cost.total", () => {
		const stats = createSessionStats();
		stats.addUsage({
			input: 50,
			output: 25,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 75,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 50);
		assert.strictEqual(snap.totalOutputTokens, 25);
		assert.strictEqual(snap.totalCost, 0);
	});

	it("seedStats from session entries populates stats", () => {
		const stats = createSessionStats();
		const sm = {
			getEntries() {
				return [
					{
						type: "message",
						message: {
							role: "assistant",
							usage: {
								input: 100,
								output: 50,
								cacheRead: 10,
								cacheWrite: 5,
								totalTokens: 165,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
							},
						},
					},
					{
						type: "message",
						message: {
							role: "user",
							content: "hello",
						},
					},
				];
			},
		};
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 100);
		assert.strictEqual(snap.totalOutputTokens, 50);
	});

	it("seedStats counts compactions", () => {
		const stats = createSessionStats();
		const sm = {
			getEntries() {
				return [
					{
						type: "compaction",
						timestamp: "t1",
						firstKeptEntryId: "a",
						tokensBefore: 1000,
						summary: "compact",
					},
					{
						type: "compaction",
						timestamp: "t2",
						firstKeptEntryId: "b",
						tokensBefore: 2000,
						summary: "compact",
					},
				];
			},
		};
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.compactionCount, 2);
	});

	it("seedStats collects model changes", () => {
		const stats = createSessionStats();
		const sm = {
			getEntries() {
				return [
					{
						type: "model_change",
						timestamp: "2025-01-01T00:00:00Z",
						provider: "openai",
						modelId: "gpt-4",
					},
					{
						type: "model_change",
						timestamp: "2025-01-01T01:00:00Z",
						provider: "anthropic",
						modelId: "claude-3",
					},
				];
			},
		};
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.modelChanges.length, 2);
		assert.strictEqual(snap.modelChanges[0].model, "openai/gpt-4");
		assert.strictEqual(snap.modelChanges[1].model, "anthropic/claude-3");
	});

	it("seedStats collects thinking level changes", () => {
		const stats = createSessionStats();
		const sm = {
			getEntries() {
				return [
					{
						type: "thinking_level_change",
						timestamp: "2025-01-01T00:00:00Z",
						thinkingLevel: "high",
					},
					{
						type: "thinking_level_change",
						timestamp: "2025-01-01T01:00:00Z",
						thinkingLevel: "medium",
					},
				];
			},
		};
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.thinkingChanges.length, 2);
		assert.strictEqual(snap.thinkingChanges[0].level, "high");
		assert.strictEqual(snap.thinkingChanges[1].level, "medium");
	});

	it("reset clears all state", () => {
		const stats = createSessionStats();
		stats.addUsage({
			input: 100,
			output: 50,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 165,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		});
		const sm = {
			getEntries() {
				return [
					{
						type: "compaction",
						timestamp: "t1",
						firstKeptEntryId: "a",
						tokensBefore: 1000,
						summary: "compact",
					},
				];
			},
		};
		stats.seedStats(sm);
		stats.reset();
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.totalInputTokens, 0);
		assert.strictEqual(snap.totalOutputTokens, 0);
		assert.strictEqual(snap.totalCacheRead, 0);
		assert.strictEqual(snap.totalCacheWrite, 0);
		assert.strictEqual(snap.totalCost, 0);
		assert.strictEqual(snap.compactionCount, 0);
		assert.strictEqual(snap.modelChanges.length, 0);
		assert.strictEqual(snap.thinkingChanges.length, 0);
	});

	it("snapshot returns copy — mutations do not affect internal state", () => {
		const stats = createSessionStats();
		const snap1 = stats.getSnapshot();
		snap1.totalInputTokens = 999;
		const snap2 = stats.getSnapshot();
		assert.strictEqual(snap2.totalInputTokens, 0);
	});

	it("modelChanges and thinkingChanges in snapshot are immutable copies", () => {
		const stats = createSessionStats();
		const sm = {
			getEntries() {
				return [
					{ type: "model_change", timestamp: "t1", provider: "openai", modelId: "gpt-4" },
					{ type: "thinking_level_change", timestamp: "t2", thinkingLevel: "high" },
				];
			},
		};
		stats.seedStats(sm);
		const snap = stats.getSnapshot();
		snap.modelChanges.push({ time: "t3", model: "custom" });
		snap.thinkingChanges.push({ time: "t4", level: "low" });
		const snap2 = stats.getSnapshot();
		assert.strictEqual(snap2.modelChanges.length, 1);
		assert.strictEqual(snap2.thinkingChanges.length, 1);
	});

	it("incrementCompaction increases count", () => {
		const stats = createSessionStats();
		assert.strictEqual(stats.getSnapshot().compactionCount, 0);
		stats.incrementCompaction();
		assert.strictEqual(stats.getSnapshot().compactionCount, 1);
		stats.incrementCompaction();
		assert.strictEqual(stats.getSnapshot().compactionCount, 2);
	});

	it("modelChange adds to model changes", () => {
		const stats = createSessionStats();
		stats.modelChange("openai", "gpt-4");
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.modelChanges.length, 1);
		assert.ok(snap.modelChanges[0].model.includes("openai/gpt-4"));
		assert.ok(snap.modelChanges[0].time);
	});

	it("thinkingChange adds to thinking changes", () => {
		const stats = createSessionStats();
		stats.thinkingChange("high");
		const snap = stats.getSnapshot();
		assert.strictEqual(snap.thinkingChanges.length, 1);
		assert.strictEqual(snap.thinkingChanges[0].level, "high");
		assert.ok(snap.thinkingChanges[0].time);
	});
});
