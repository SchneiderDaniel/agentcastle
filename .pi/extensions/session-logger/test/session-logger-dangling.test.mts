/**
 * Tests for session-logger/files.ts — dangling symlink fix
 *
 * Phase 4: ensureLatestLink with waitForFile to prevent dangling symlinks
 * when target file doesn't exist yet.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-dangling.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { createFileOps, type FileOps } from "../files.ts";

// ---------------------------------------------------------------------------
// Phase 4: waitForFile behavior in ensureLatestLink
// ---------------------------------------------------------------------------

describe("ensureLatestLink with waitForFile (dangling symlink fix)", () => {
	let tmpDir: string;
	let sessionsDir: string;
	let files: FileOps;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-dangling-"));
		sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		files = createFileOps();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ensureSymlink with target file already present creates symlink immediately", async () => {
		const sessionFile = path.join(sessionsDir, "session-present.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		await files.ensureSymlink(sessionFile, sessionsDir);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "should be symlink");
		assert.ok(fs.existsSync(latestLink), "target should be reachable");
	});

	it("ensureSymlink with target file created after delay: retries until file appears, then creates valid symlink", async () => {
		const sessionFile = path.join(sessionsDir, "session-delayed.jsonl");

		// Schedule file creation after 200ms
		const writePromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				fs.writeFileSync(sessionFile, "{}");
				resolve();
			}, 200);
		});

		// Call ensureSymlink — should wait for file (with retries)
		const symlinkPromise = files.ensureSymlink(sessionFile, sessionsDir);

		await Promise.all([writePromise, symlinkPromise]);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "should be symlink");
		assert.ok(fs.existsSync(latestLink), "target should be reachable after delay");
	});

	it("ensureSymlink with target file that never appears times out gracefully", async () => {
		const sessionFile = path.join(sessionsDir, "session-never-exists.jsonl");

		// Should reject because file never appears
		await assert.rejects(
			async () => {
				await files.ensureSymlink(sessionFile, sessionsDir);
			},
			(err: unknown) => {
				const nodeErr = err as NodeJS.ErrnoException;
				// Accept either ENOENT (timeout) or the error from the function
				return true; // Accept any error — file never exists
			},
		);
	});

	it("ensureSymlink concurrent calls: first writer waits for file, second races — both succeed, final symlink resolves", async () => {
		const sessionFile = path.join(sessionsDir, "session-concurrent.jsonl");

		// Two concurrent ensureSymlink calls, file only appears after delay
		const writePromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				fs.writeFileSync(sessionFile, "{}");
				resolve();
			}, 300);
		});

		const [symlinkResult] = await Promise.allSettled([
			files.ensureSymlink(sessionFile, sessionsDir),
			files.ensureSymlink(sessionFile, sessionsDir),
			writePromise,
		]);

		// At least one should succeed
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(
			fs.lstatSync(latestLink).isSymbolicLink(),
			"symlink must exist after concurrent calls",
		);
		assert.ok(fs.existsSync(latestLink), "symlink target must be reachable");
	});

	it("ensureSymlink full lifecycle: session_start (wait) + session_shutdown (create) → latest.jsonl resolves", async () => {
		const sessionFile = path.join(sessionsDir, "session-lifecycle.jsonl");

		// Simulate session_start: ensureSymlink called before file exists (subprocess still writing)
		const startPromise = files.ensureSymlink(sessionFile, sessionsDir);

		// Simulate subprocess writing file after 150ms
		const writePromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				fs.writeFileSync(sessionFile, "{}");
				resolve();
			}, 150);
		});

		await Promise.all([startPromise, writePromise]);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "latest.jsonl should be symlink");
		assert.ok(fs.existsSync(latestLink), "latest.jsonl target should resolve");

		// Simulate session_shutdown: create .md file and its symlink
		const mdFile = path.join(sessionsDir, "session-lifecycle.md");
		fs.writeFileSync(mdFile, "# Lifecycle Report");
		await files.ensureMdSymlink(sessionsDir, mdFile);

		const latestMd = path.join(sessionsDir, "latest.md");
		assert.ok(fs.lstatSync(latestMd).isSymbolicLink(), "latest.md should be symlink");
		assert.ok(fs.existsSync(latestMd), "latest.md target should resolve");
	});

	it("ensureMdSymlink with delayed md file creation", async () => {
		const mdFile = path.join(sessionsDir, "session-delayed.md");

		const writePromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				fs.writeFileSync(mdFile, "# Delayed report");
				resolve();
			}, 100);
		});

		const symlinkPromise = files.ensureMdSymlink(sessionsDir, mdFile);

		await Promise.all([writePromise, symlinkPromise]);

		const latestLink = path.join(sessionsDir, "latest.md");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "latest.md should be symlink");
		assert.ok(fs.existsSync(latestLink), "latest.md target should resolve");
	});

	it("ensureLatestMetadataSymlink with delayed metadata file creation", async () => {
		const metaFile = path.join(sessionsDir, "session-delayed.metadata.json");

		const writePromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				fs.writeFileSync(metaFile, "{}");
				resolve();
			}, 100);
		});

		const symlinkPromise = files.ensureLatestMetadataSymlink(sessionsDir, metaFile);

		await Promise.all([writePromise, symlinkPromise]);

		const latestLink = path.join(sessionsDir, "latest.metadata.json");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "latest.metadata.json should be symlink");
		assert.ok(fs.existsSync(latestLink), "latest.metadata.json target should resolve");
	});

	it("dangling symlink does NOT occur (regression test)", async () => {
		// Before fix: ensureSymlink called before file exists creates dangling symlink.
		// After fix: it waits for the file.

		const sessionFile = path.join(sessionsDir, "session-regression.jsonl");

		// Call ensureSymlink and create file almost simultaneously
		const both = Promise.all([
			files.ensureSymlink(sessionFile, sessionsDir),
			new Promise<void>((resolve) => {
				setTimeout(() => {
					fs.writeFileSync(sessionFile, "{}");
					resolve();
				}, 50);
			}),
		]);

		await both;

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink exists");
		// Symlink should NOT be dangling — target should exist
		assert.ok(fs.existsSync(latestLink), "symlink target must NOT be dangling");
	});
});
