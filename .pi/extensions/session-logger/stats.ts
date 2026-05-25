import type { Usage } from "@earendil-works/pi-ai";

export interface ToolExecution {
	toolCallId: string;
	toolName: string;
	startTime: number;
	endTime: number | null;
	isError: boolean;
	resultSize: number;
}

export interface TurnStats {
	turnIndex: number;
	tokens: number;
	cost: number;
	toolCount: number;
	errorCount: number;
}

export interface StatsSnapshot {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
	compactionCount: number;
	toolExecutions: ToolExecution[];
	perTurnTokens: TurnStats[];
	fileModifications: Array<{
		action: "read" | "write" | "edit";
		path: string;
		timestamp: string;
		size?: number;
	}>;
}

export interface SessionStats {
	addUsage(usage: Usage): void;
	seedStats(sm: { getEntries(): any[] }): void;
	reset(): void;
	getSnapshot(): StatsSnapshot;
	incrementCompaction(): void;
	modelChange(provider: string, modelId: string): void;
	thinkingChange(level: string): void;
	recordToolStart(toolCallId: string, toolName: string): void;
	recordToolEnd(toolCallId: string, isError: boolean, resultSize: number): void;
	recordTurnStart(turnIndex: number): void;
	recordTurnEnd(): void;
	recordFileModification(action: "read" | "write" | "edit", path: string, size?: number): void;
}

/** Aggregate tool executions into a summary map with durations. */
export function computeToolStats(
	executions: Array<{
		toolName: string;
		isError: boolean;
		startTime: number;
		endTime: number | null;
	}>,
): Record<string, { calls: number; errors: number; totalDurationMs: number }> {
	const stats: Record<string, { calls: number; errors: number; totalDurationMs: number }> = {};
	for (const exec of executions) {
		if (!stats[exec.toolName]) {
			stats[exec.toolName] = { calls: 0, errors: 0, totalDurationMs: 0 };
		}
		stats[exec.toolName].calls++;
		if (exec.isError) stats[exec.toolName].errors++;
		if (exec.endTime != null) {
			stats[exec.toolName].totalDurationMs += exec.endTime - exec.startTime;
		}
	}
	return stats;
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
	let toolExecutions: ToolExecution[] = [];
	let perTurnTokens: TurnStats[] = [];
	let fileModifications: Array<{
		action: "read" | "write" | "edit";
		path: string;
		timestamp: string;
		size?: number;
	}> = [];

	// Current turn tracking
	let currentTurnIndex = -1;
	let currentTurnTokens = 0;
	let currentTurnCost = 0;
	let currentTurnToolCount = 0;
	let currentTurnErrorCount = 0;

	// Track tool call IDs to execution objects
	const pendingTools: Map<string, ToolExecution> = new Map();

	function flushTurn() {
		if (currentTurnIndex >= 0) {
			perTurnTokens.push({
				turnIndex: currentTurnIndex,
				tokens: currentTurnTokens,
				cost: currentTurnCost,
				toolCount: currentTurnToolCount,
				errorCount: currentTurnErrorCount,
			});
		}
		currentTurnTokens = 0;
		currentTurnCost = 0;
		currentTurnToolCount = 0;
		currentTurnErrorCount = 0;
	}

	return {
		addUsage(usage: Usage) {
			if (!usage) return;
			const input = usage.input ?? 0;
			const output = usage.output ?? 0;
			const cacheRead = usage.cacheRead ?? 0;
			const cacheWrite = usage.cacheWrite ?? 0;
			const cost = usage.cost?.total ?? 0;

			totalInputTokens += input;
			totalOutputTokens += output;
			totalCacheRead += cacheRead;
			totalCacheWrite += cacheWrite;
			totalCost += cost;

			// Also track per-turn
			currentTurnTokens += input + output + cacheRead + cacheWrite;
			currentTurnCost += cost;
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
			toolExecutions = [];
			perTurnTokens = [];
			fileModifications = [];
			currentTurnIndex = -1;
			currentTurnTokens = 0;
			currentTurnCost = 0;
			currentTurnToolCount = 0;
			currentTurnErrorCount = 0;
			pendingTools.clear();
		},

		getSnapshot(): StatsSnapshot {
			// Flush current turn if there's one open
			if (currentTurnIndex >= 0 && currentTurnTokens > 0) {
				const last = perTurnTokens[perTurnTokens.length - 1];
				if (!last || last.turnIndex !== currentTurnIndex) {
					flushTurn();
				}
			}
			return {
				totalInputTokens,
				totalOutputTokens,
				totalCacheRead,
				totalCacheWrite,
				totalCost,
				modelChanges: [...modelChanges],
				thinkingChanges: [...thinkingChanges],
				compactionCount,
				toolExecutions: [...toolExecutions],
				perTurnTokens: [...perTurnTokens],
				fileModifications: [...fileModifications],
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

		recordToolStart(toolCallId: string, toolName: string) {
			const exec: ToolExecution = {
				toolCallId,
				toolName,
				startTime: Date.now(),
				endTime: null,
				isError: false,
				resultSize: 0,
			};
			pendingTools.set(toolCallId, exec);
			toolExecutions.push(exec);
		},

		recordToolEnd(toolCallId: string, isError: boolean, resultSize: number) {
			const exec = pendingTools.get(toolCallId);
			if (exec) {
				exec.endTime = Date.now();
				exec.isError = isError;
				exec.resultSize = resultSize;
				pendingTools.delete(toolCallId);
			}
			currentTurnToolCount++;
			if (isError) currentTurnErrorCount++;
		},

		recordTurnStart(turnIndex: number) {
			flushTurn();
			currentTurnIndex = turnIndex;
		},

		recordTurnEnd() {
			flushTurn();
			currentTurnIndex = -1;
		},

		recordFileModification(action: "read" | "write" | "edit", path: string, size?: number) {
			fileModifications.push({
				action,
				path,
				timestamp: new Date().toISOString(),
				size,
			});
		},
	};
}
