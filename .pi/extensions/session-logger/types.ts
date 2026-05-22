export interface Metadata {
	sessionId: string;
	name?: string;
	messages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	compactions: number;
	modelChanges: Array<{ time: string; model: string }>;
	thinkingChanges: Array<{ time: string; level: string }>;
	/** Per-turn token breakdown */
	perTurnTokens?: Array<{
		turnIndex: number;
		tokens: number;
		cost: number;
		toolCount: number;
		errorCount: number;
	}>;
	/** Tool execution stats */
	toolStats?: Record<
		string,
		{
			calls: number;
			errors: number;
			totalDurationMs: number;
		}
	>;
	/** File modifications tracked during session */
	fileModifications?: Array<{
		action: "read" | "write" | "edit";
		path: string;
		timestamp: string;
		size?: number;
	}>;
}
