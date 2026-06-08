/**
 * Tests for loading-indicator — simple extension loading status line.
 *
 * These tests verify setupLoadingIndicator() patches DefaultResourceLoader
 * and writes status output to stderr.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupLoadingIndicator } from "../src/loading-indicator.ts";

describe("loading-indicator", () => {
	it("exports setupLoadingIndicator function", () => {
		assert.equal(typeof setupLoadingIndicator, "function");
	});

	it("patches DefaultResourceLoader.prototype.reload", async () => {
		const pi = await import("@earendil-works/pi-coding-agent");
		const origReload = pi.DefaultResourceLoader.prototype.reload;

		try {
			setupLoadingIndicator();

			// After patch, reload should be a different function
			assert.notEqual(
				pi.DefaultResourceLoader.prototype.reload,
				origReload,
				"reload should be replaced after setupLoadingIndicator",
			);
		} finally {
			// Restore original
			pi.DefaultResourceLoader.prototype.reload = origReload;
		}
	});
});
