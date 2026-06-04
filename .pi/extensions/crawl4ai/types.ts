/**
 * Shared types for crawl4ai extension
 */

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; signal?: AbortSignal },
	): Promise<ExecResult>;
}

export interface OnUpdateCallback {
	(u: { content: Array<{ type: "text"; text: string }>; details: unknown }): void;
}

export interface CrawlParams {
	url: string;
	maxPages: number;
}
