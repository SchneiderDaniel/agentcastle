import type { Usage } from "@earendil-works/pi-ai";

export interface StatsSnapshot {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
	compactionCount: number;
}

export interface SessionStats {
	addUsage(usage: Usage): void;
	seedStats(sm: { getEntries(): any[] }): void;
	reset(): void;
	getSnapshot(): StatsSnapshot;
	incrementCompaction(): void;
	modelChange(provider: string, modelId: string): void;
	thinkingChange(level: string): void;
}

export function createSessionStats(): SessionStats {
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let totalCost = 0;
	let modelChanges: Array<{ time: string; model: string }> = [];
	let thinkingChanges: Array<{ time: string; level: string }> = [];
	let compactionCount = 0;

	return {
		addUsage(usage: Usage) {
			if (!usage) return;
			totalInputTokens += usage.input ?? 0;
			totalOutputTokens += usage.output ?? 0;
			totalCacheRead += usage.cacheRead ?? 0;
			totalCacheWrite += usage.cacheWrite ?? 0;
			totalCost += usage.cost?.total ?? 0;
		},

		seedStats(sm: { getEntries(): any[] }) {
			for (const entry of sm.getEntries()) {
				if (entry.type === "message") {
					if (entry.message.role === "assistant") this.addUsage(entry.message.usage);
				} else if (entry.type === "compaction") {
					compactionCount++;
				} else if (entry.type === "model_change") {
					modelChanges.push({
						time: entry.timestamp,
						model: `${entry.provider}/${entry.modelId}`,
					});
				} else if (entry.type === "thinking_level_change") {
					thinkingChanges.push({ time: entry.timestamp, level: entry.thinkingLevel });
				}
			}
		},

		reset() {
			totalInputTokens = 0;
			totalOutputTokens = 0;
			totalCacheRead = 0;
			totalCacheWrite = 0;
			totalCost = 0;
			modelChanges = [];
			thinkingChanges = [];
			compactionCount = 0;
		},

		getSnapshot(): StatsSnapshot {
			return {
				totalInputTokens,
				totalOutputTokens,
				totalCacheRead,
				totalCacheWrite,
				totalCost,
				modelChanges: [...modelChanges],
				thinkingChanges: [...thinkingChanges],
				compactionCount,
			};
		},

		incrementCompaction() {
			compactionCount++;
		},

		modelChange(provider: string, modelId: string) {
			modelChanges.push({
				time: new Date().toISOString(),
				model: `${provider}/${modelId}`,
			});
		},

		thinkingChange(level: string) {
			thinkingChanges.push({ time: new Date().toISOString(), level });
		},
	};
}
