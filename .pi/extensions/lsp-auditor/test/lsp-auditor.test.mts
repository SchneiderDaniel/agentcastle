/**
 * Tests for lsp-auditor withTimeout fix.
 *
 * Unit tests: pure promise logic, zero I/O, runs <100ms.
 * Verifies the withTimeout helper properly absorbs post-timeout rejections
 * to prevent unhandled promise rejections (issue #247).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "../lsp-client.ts";

// ── Helpers ──

/** Creates a deferred promise for test control */
function deferredPromise<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ── Tests ──

describe("withTimeout", () => {
	// ── Happy paths ──

	it("returns null when timeout wins", async () => {
		const deferred = deferredPromise<string>();
		const start = Date.now();
		const result = await withTimeout(deferred.promise, 10);
		const elapsed = Date.now() - start;
		assert.equal(result, null);
		assert.ok(elapsed >= 8, "should wait for timeout");
	});

	it("returns value when promise wins before timeout", async () => {
		const result = await withTimeout(Promise.resolve("hello"), 1000);
		assert.equal(result, "hello");
	});

	// ── Error path ──

	it("propagates rejection when promise rejects before timeout", async () => {
		await assert.rejects(withTimeout(Promise.reject(new Error("early fail")), 1000), /early fail/);
	});

	// ── Bug fix: losing promise rejects after timeout ──

	it("does not emit unhandledRejection when losing promise rejects after timeout", async () => {
		const deferred = deferredPromise<string>();
		let unhandledRejectionFired = false;

		// Capture any unhandled rejection during this test
		const handler = (err: Error) => {
			unhandledRejectionFired = true;
		};
		process.on("unhandledRejection", handler);

		try {
			// Timeout wins (10ms timeout)
			const result = await withTimeout(deferred.promise, 10);
			assert.equal(result, null);

			// Now reject the deferred promise — this simulates connection.dispose()
			// rejecting a pending sendRequest promise after timeout.
			deferred.reject(new Error("late rejection after timeout"));

			// Give microtask queue a chance to settle
			await new Promise((r) => setTimeout(r, 5));

			// The .catch(() => {}) guard should have swallowed this rejection
			assert.equal(
				unhandledRejectionFired,
				false,
				"post-timeout rejection must not cause unhandledRejection",
			);
		} finally {
			process.off("unhandledRejection", handler);
		}
	});

	// ── Edge cases ──

	it("returns null when ms=0 (immediate timeout)", async () => {
		const deferred = deferredPromise<string>();
		const result = await withTimeout(deferred.promise, 0);
		assert.equal(result, null);
	});

	it("returns null when ms is negative (immediate timeout)", async () => {
		const deferred = deferredPromise<string>();
		const result = await withTimeout(deferred.promise, -1);
		assert.equal(result, null);
	});

	it("returns value when promise is already resolved", async () => {
		const result = await withTimeout(Promise.resolve("immediate"), 10_000);
		assert.equal(result, "immediate");
	});

	it("propagates rejection when promise is already rejected", async () => {
		await assert.rejects(
			withTimeout(Promise.reject(new Error("already failed")), 10_000),
			/already failed/,
		);
	});

	it("returns null after exact timeout (not before)", async () => {
		const deferred = deferredPromise<string>();
		const start = Date.now();
		const result = await withTimeout(deferred.promise, 50);
		const elapsed = Date.now() - start;
		assert.equal(result, null);
		assert.ok(elapsed >= 45, "should wait ~50ms before returning null");
	});

	it("promise value type is preserved (number)", async () => {
		const result = await withTimeout(Promise.resolve(42), 100);
		assert.equal(result, 42);
	});

	it("promise value type is preserved (object)", async () => {
		const obj = { foo: "bar" };
		const result = await withTimeout(Promise.resolve(obj), 100);
		assert.deepEqual(result, obj);
	});
});
