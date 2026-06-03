/**
 * Domain / unit tests for waitForFile — polling for a file to appear on disk.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-waitForFile.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { waitForFile } from "../files.ts";

// ---------------------------------------------------------------------------
// waitForFile — domain / unit tests
// ---------------------------------------------------------------------------

describe("waitForFile", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "waitForFile-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves immediately when target already exists", async () => {
		const filePath = path.join(tmpDir, "existing.txt");
		fs.writeFileSync(filePath, "hello");

		await waitForFile(filePath);
		// If we get here, it resolved — no assertion needed beyond that
	});

	it("waits for file created after a delay (100ms)", async () => {
		const filePath = path.join(tmpDir, "delayed.txt");

		const writePromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				fs.writeFileSync(filePath, "done");
				resolve();
			}, 100);
		});

		await Promise.all([waitForFile(filePath, { timeout: 3000 }), writePromise]);
		// If we get here, waitForFile resolved after the file appeared
	});

	it("rejects after timeout when target never appears", async () => {
		const filePath = path.join(tmpDir, "never-exists.txt");

		await assert.rejects(
			() => waitForFile(filePath, { timeout: 200, interval: 20 }),
			/waitForFile.*not found/i,
		);
	});

	it("rejects quickly with zero timeout and missing target", async () => {
		const filePath = path.join(tmpDir, "no-file.txt");

		await assert.rejects(
			() => waitForFile(filePath, { timeout: 0, interval: 10 }),
			/waitForFile.*not found/i,
		);
	});

	it("rejects when parent directory does not exist", async () => {
		const filePath = path.join(tmpDir, "nonexistent-dir", "file.txt");

		await assert.rejects(() => waitForFile(filePath, { timeout: 100 }), /waitForFile.*not found/i);
	});

	it("rejects with empty-string path", async () => {
		await assert.rejects(() => waitForFile(""), /waitForFile.*not found/i);
	});

	it("rejects with AbortError when signal is aborted before file appears", async () => {
		const filePath = path.join(tmpDir, "aborted.txt");
		const ac = new AbortController();

		// Abort before calling waitForFile
		ac.abort();

		await assert.rejects(
			() => waitForFile(filePath, { signal: ac.signal, timeout: 5000 }),
			(err: unknown) => {
				// Should be an AbortError (DOMException with name "AbortError")
				return err instanceof DOMException && err.name === "AbortError";
			},
		);
	});

	it("rejects with AbortError when signal fires during polling", async () => {
		const filePath = path.join(tmpDir, "abort-while-polling.txt");
		const ac = new AbortController();

		const waitPromise = waitForFile(filePath, { signal: ac.signal, timeout: 5000 });

		// Abort after 50ms — file never created, so waitForFile is still polling
		setTimeout(() => ac.abort(), 50);

		await assert.rejects(
			() => waitPromise,
			(err: unknown) => {
				return err instanceof DOMException && err.name === "AbortError";
			},
		);
	});

	it("resolves quickly when file appears before first poll", async () => {
		const filePath = path.join(tmpDir, "immediate.txt");
		fs.writeFileSync(filePath, "content");

		// Very short timeout — file already exists, so should resolve
		// before the timeout fires
		await waitForFile(filePath, { timeout: 1 });
	});
});
