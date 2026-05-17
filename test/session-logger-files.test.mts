/**
 * Tests for session-logger/files.ts — symlink and metadata operations
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test test/session-logger-files.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { createFileOps } from "../.pi/extensions/session-logger/files.ts";
import type { Metadata } from "../.pi/extensions/session-logger/types.ts";

// ---------------------------------------------------------------------------
// createFileOps — integration tests using tmpdir
// ---------------------------------------------------------------------------

describe("createFileOps", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-files-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ensureSymlink creates symlink to session file", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-abc.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		const files = createFileOps();
		await files.ensureSymlink(sessionFile, sessionsDir);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.existsSync(latestLink));
		const stat = fs.lstatSync(latestLink);
		assert.ok(stat.isSymbolicLink());
		const target = fs.readlinkSync(latestLink);
		assert.ok(target.includes("session-abc.jsonl"));
	});

	it("ensureSymlink replaces existing symlink", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });

		const file1 = path.join(sessionsDir, "session-1.jsonl");
		fs.writeFileSync(file1, "");
		const file2 = path.join(sessionsDir, "session-2.jsonl");
		fs.writeFileSync(file2, "");

		const files = createFileOps();
		await files.ensureSymlink(file1, sessionsDir);
		await files.ensureSymlink(file2, sessionsDir);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		const target = fs.readlinkSync(latestLink);
		assert.ok(target.includes("session-2.jsonl"));
	});

	it("ensureSymlink handles missing sessionFile gracefully", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });

		const files = createFileOps();
		// Should not throw — symlink will dangle but that's expected
		await files.ensureSymlink("/nonexistent/file.jsonl", sessionsDir);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink());
	});

	it("writeMetadata creates metadata.json with correct content", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions", "test-session");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta: Metadata = {
			sessionId: "test-session",
			name: "Test Session",
			messages: 5,
			tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
			cost: 0.0015,
			compactions: 2,
			modelChanges: [{ time: "2025-01-01T00:00:00Z", model: "openai/gpt-4" }],
			thinkingChanges: [{ time: "2025-01-01T00:00:01Z", level: "high" }],
		};

		const files = createFileOps();
		await files.writeMetadata(sessionDir, meta);

		const metaPath = path.join(sessionDir, "metadata.json");
		assert.ok(fs.existsSync(metaPath));

		const loaded: Metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.strictEqual(loaded.sessionId, "test-session");
		assert.strictEqual(loaded.name, "Test Session");
		assert.strictEqual(loaded.messages, 5);
		assert.strictEqual(loaded.tokens.total, 165);
		assert.strictEqual(loaded.cost, 0.0015);
		assert.strictEqual(loaded.compactions, 2);
		assert.strictEqual(loaded.modelChanges.length, 1);
		assert.strictEqual(loaded.thinkingChanges.length, 1);
	});

	it("writeMetadata works without optional name", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions", "test-session-2");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta: Metadata = {
			sessionId: "test-session-2",
			messages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};

		const files = createFileOps();
		await files.writeMetadata(sessionDir, meta);

		const metaPath = path.join(sessionDir, "metadata.json");
		const loaded: Metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.strictEqual(loaded.sessionId, "test-session-2");
		assert.strictEqual(loaded.name, undefined);
	});

	it("writeMetadata formats JSON with indentation", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions", "fmt-test");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta: Metadata = {
			sessionId: "fmt-test",
			messages: 1,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			cost: 0.0001,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};

		const files = createFileOps();
		await files.writeMetadata(sessionDir, meta);

		const metaPath = path.join(sessionDir, "metadata.json");
		const content = fs.readFileSync(metaPath, "utf-8");
		// Verify pretty-printed: first line should be `{`, last `}`
		const lines = content.trim().split("\n");
		assert.strictEqual(lines[0], "{");
		assert.strictEqual(lines[lines.length - 1], "}");
		// Should have indentation (leading space on non-first/last lines)
		assert.ok(lines.length > 2, "JSON should span multiple lines with indentation");
	});
});
