/**
 * Shared types for crawl4ai extension
 */

export interface OnUpdateCallback {
	(u: { content: Array<{ type: "text"; text: string }>; details: unknown }): void;
}

export interface CrawlResult {
	url: string;
	markdown?: string;
	error?: string;
	success: boolean;
}

export interface CrawlParams {
	url: string;
	maxPages: number;
}
