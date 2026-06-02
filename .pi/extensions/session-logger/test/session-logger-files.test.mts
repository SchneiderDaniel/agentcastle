/**
 * Tests for session-logger/files.ts — symlink and metadata operations
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test .pi/extensions/session-logger/test/session-logger-files.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { createFileOps, type FileOps } from "../files.ts";
import type { Metadata } from "../types.ts";

// ---------------------------------------------------------------------------
// createFileOps — integration tests using tmpdir
// ---------------------------------------------------------------------------

describe("createFileOps", () => {
	let tmpDir: string;
	let files: FileOps;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-logger-files-"));
		files = createFileOps();
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("ensureSymlink creates symlink to session file", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-abc.jsonl");
		fs.writeFileSync(sessionFile, "{}");

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

		await files.ensureSymlink(file1, sessionsDir);
		await files.ensureSymlink(file2, sessionsDir);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		const target = fs.readlinkSync(latestLink);
		assert.ok(target.includes("session-2.jsonl"));
	});

	it("ensureSymlink with missing sessionFile throws (no dangling symlink)", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });

		// After fix: waitForFile prevents dangling symlinks — non-existent file throws
		await assert.rejects(
			() => files.ensureSymlink("/nonexistent/file.jsonl", sessionsDir),
			/waitForFile.*not found/i,
		);
	});

	// ---------------------------------------------------------------------------
	// ensureMdSymlink tests
	// ---------------------------------------------------------------------------

	it("ensureMdSymlink creates latest.md pointing to md file", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const mdFile = path.join(sessionDir, "session-xyz.md");
		fs.writeFileSync(mdFile, "# report");

		await files.ensureMdSymlink(sessionDir, mdFile);

		const latestLink = path.join(sessionDir, "latest.md");
		assert.ok(fs.existsSync(latestLink), "latest.md should exist");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "latest.md should be symlink");
		const target = fs.readlinkSync(latestLink);
		assert.ok(target.includes("session-xyz.md"), `target ${target} should point to session md`);
	});

	it("ensureMdSymlink replaces existing symlink", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const md1 = path.join(sessionDir, "session-1.md");
		fs.writeFileSync(md1, "one");
		const md2 = path.join(sessionDir, "session-2.md");
		fs.writeFileSync(md2, "two");

		await files.ensureMdSymlink(sessionDir, md1);
		await files.ensureMdSymlink(sessionDir, md2);

		const latestLink = path.join(sessionDir, "latest.md");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink());
		const target = fs.readlinkSync(latestLink);
		assert.ok(target.includes("session-2.md"), `target ${target} should be second md`);
	});

	// ---------------------------------------------------------------------------
	// ensureLatestMetadataSymlink tests
	// ---------------------------------------------------------------------------

	it("ensureLatestMetadataSymlink creates latest.metadata.json pointing to metadata file", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const metaFile = path.join(sessionDir, "session-xyz.metadata.json");
		fs.writeFileSync(metaFile, "{}");

		await files.ensureLatestMetadataSymlink(sessionDir, metaFile);

		const latestLink = path.join(sessionDir, "latest.metadata.json");
		assert.ok(fs.existsSync(latestLink), "latest.metadata.json should exist");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "should be symlink");
		const target = fs.readlinkSync(latestLink);
		assert.ok(
			target.includes("session-xyz.metadata.json"),
			`target ${target} should point to metadata`,
		);
	});

	it("ensureLatestMetadataSymlink replaces existing symlink", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta1 = path.join(sessionDir, "session-1.metadata.json");
		fs.writeFileSync(meta1, "{}");
		const meta2 = path.join(sessionDir, "session-2.metadata.json");
		fs.writeFileSync(meta2, "{}");

		await files.ensureLatestMetadataSymlink(sessionDir, meta1);
		await files.ensureLatestMetadataSymlink(sessionDir, meta2);

		const latestLink = path.join(sessionDir, "latest.metadata.json");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink());
		const target = fs.readlinkSync(latestLink);
		assert.ok(
			target.includes("session-2.metadata.json"),
			`target ${target} should be second metadata`,
		);
	});

	// ---------------------------------------------------------------------------
	// Atomic rename behavior — no dangling/unlinked window
	// ---------------------------------------------------------------------------

	it("ensureSymlink leaves no .tmp file after completion", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-abc.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		await files.ensureSymlink(sessionFile, sessionsDir);

		const tmpFiles = fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files should remain after ensureSymlink");
	});

	it("ensureSymlink always leaves a valid symlink (no unlink window)", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-abc.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		// First call creates
		await files.ensureSymlink(sessionFile, sessionsDir);
		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink should exist after first call");

		// Second call replaces — must never produce ENOENT
		const sessionFile2 = path.join(sessionsDir, "session-def.jsonl");
		fs.writeFileSync(sessionFile2, "{}");
		await files.ensureSymlink(sessionFile2, sessionsDir);
		assert.ok(fs.lstatSync(latestLink).isSymbolicLink(), "symlink should exist after second call");
		assert.ok(fs.existsSync(latestLink), "symlink target must be reachable after second call");
	});

	it("ensureMdSymlink leaves no .tmp file after completion", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const mdFile = path.join(sessionDir, "session-abc.md");
		fs.writeFileSync(mdFile, "# report");

		await files.ensureMdSymlink(sessionDir, mdFile);

		const tmpFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files after ensureMdSymlink");
	});

	it("ensureLatestMetadataSymlink leaves no .tmp file after completion", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const metaFile = path.join(sessionDir, "session-abc.metadata.json");
		fs.writeFileSync(metaFile, "{}");

		await files.ensureLatestMetadataSymlink(sessionDir, metaFile);

		const tmpFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files after ensureLatestMetadataSymlink");
	});

	// ---------------------------------------------------------------------------
	// Concurrent call tests (race verification)
	// ---------------------------------------------------------------------------

	it("concurrent ensureSymlink calls — both targets valid, final symlink exists", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });

		const fileA = path.join(sessionsDir, "session-A.jsonl");
		fs.writeFileSync(fileA, "A");
		const fileB = path.join(sessionsDir, "session-B.jsonl");
		fs.writeFileSync(fileB, "B");

		await Promise.all([
			files.ensureSymlink(fileA, sessionsDir),
			files.ensureSymlink(fileB, sessionsDir),
		]);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		assert.ok(
			fs.lstatSync(latestLink).isSymbolicLink(),
			"symlink must exist after concurrent calls",
		);
		// Must point to one of the two valid files (non-deterministic which)
		assert.ok(fs.existsSync(latestLink), "symlink target must be reachable");
		const resolved = fs.realpathSync(latestLink);
		assert.ok(
			resolved === fs.realpathSync(fileA) || resolved === fs.realpathSync(fileB),
			`resolved ${resolved} must be one of the target files`,
		);
	});

	it("concurrent ensureMdSymlink calls — no dangling symlink", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const mdA = path.join(sessionDir, "session-A.md");
		fs.writeFileSync(mdA, "A");
		const mdB = path.join(sessionDir, "session-B.md");
		fs.writeFileSync(mdB, "B");

		await Promise.all([
			files.ensureMdSymlink(sessionDir, mdA),
			files.ensureMdSymlink(sessionDir, mdB),
		]);

		const latestLink = path.join(sessionDir, "latest.md");
		assert.ok(
			fs.lstatSync(latestLink).isSymbolicLink(),
			"symlink must exist after concurrent calls",
		);
		assert.ok(fs.existsSync(latestLink), "symlink target must be reachable");
	});

	it("concurrent ensureSymlink + ensureMdSymlink — no cross-interference", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const mdFile = path.join(sessionDir, "session-1.md");
		fs.writeFileSync(mdFile, "# report");
		const jsonlFile = path.join(sessionDir, "session-1.jsonl");
		fs.writeFileSync(jsonlFile, "{}");

		await Promise.all([
			files.ensureSymlink(jsonlFile, sessionDir),
			files.ensureMdSymlink(sessionDir, mdFile),
		]);

		const latestJsonl = path.join(sessionDir, "latest.jsonl");
		const latestMd = path.join(sessionDir, "latest.md");

		assert.ok(fs.lstatSync(latestJsonl).isSymbolicLink(), "latest.jsonl must be symlink");
		assert.ok(fs.lstatSync(latestMd).isSymbolicLink(), "latest.md must be symlink");
		assert.ok(fs.existsSync(latestJsonl), "latest.jsonl target reachable");
		assert.ok(fs.existsSync(latestMd), "latest.md target reachable");
	});

	// ---------------------------------------------------------------------------
	// Full session lifecycle integration
	// ---------------------------------------------------------------------------

	it("full session lifecycle — start and shutdown produce all files", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionId = "integration-test-42";
		const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
		fs.writeFileSync(sessionFile, "{}");

		const meta: Metadata = {
			sessionId,
			name: "Integration Test",
			messages: 3,
			tokens: { input: 30, output: 15, cacheRead: 0, cacheWrite: 0, total: 45 },
			cost: 0.0003,
			compactions: 1,
			modelChanges: [],
			thinkingChanges: [],
		};

		const mdFile = path.join(sessionDir, `${sessionId}.md`);
		fs.writeFileSync(mdFile, "# Session Report");

		// Simulate session_start
		await files.ensureSymlink(sessionFile, sessionDir);

		// Simulate session_shutdown: write metadata first, then symlink
		await files.writeMetadata(sessionDir, sessionId, meta);
		await files.ensureLatestMetadataSymlink(
			sessionDir,
			path.join(sessionDir, `${sessionId}.metadata.json`),
		);
		await files.writeSessionReport(sessionDir, sessionId, "# Session Report");
		await files.ensureMdSymlink(sessionDir, mdFile);

		// Verify all files present
		assert.ok(fs.existsSync(path.join(sessionDir, `${sessionId}.jsonl`)), "jsonl file exists");
		assert.ok(
			fs.existsSync(path.join(sessionDir, `${sessionId}.metadata.json`)),
			"metadata file exists",
		);
		assert.ok(fs.existsSync(path.join(sessionDir, `${sessionId}.md`)), "md file exists");

		// Verify symlinks
		assert.ok(
			fs.lstatSync(path.join(sessionDir, "latest.jsonl")).isSymbolicLink(),
			"latest.jsonl symlink",
		);
		assert.ok(
			fs.lstatSync(path.join(sessionDir, "latest.md")).isSymbolicLink(),
			"latest.md symlink",
		);
		assert.ok(
			fs.lstatSync(path.join(sessionDir, "latest.metadata.json")).isSymbolicLink(),
			"latest.metadata.json symlink",
		);

		// Verify no tmp leftovers
		const tmpFiles = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".tmp"));
		assert.strictEqual(tmpFiles.length, 0, "No .tmp files left after full lifecycle");
	});

	it("writeMetadata writes <sessionId>.metadata.json with correct content", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionId = "test-session-123";

		const meta: Metadata = {
			sessionId,
			name: "Test Session",
			messages: 5,
			tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
			cost: 0.0015,
			compactions: 2,
			modelChanges: [{ time: "2025-01-01T00:00:00Z", model: "openai/gpt-4" }],
			thinkingChanges: [{ time: "2025-01-01T00:00:01Z", level: "high" }],
		};

		const files = createFileOps();
		await files.writeMetadata(sessionDir, sessionId, meta);

		const metaPath = path.join(sessionDir, `${sessionId}.metadata.json`);
		assert.ok(fs.existsSync(metaPath), `Expected ${metaPath} to exist`);

		const loaded: Metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.strictEqual(loaded.sessionId, sessionId);
		assert.strictEqual(loaded.name, "Test Session");
		assert.strictEqual(loaded.messages, 5);
		assert.strictEqual(loaded.tokens.total, 165);
		assert.strictEqual(loaded.cost, 0.0015);
		assert.strictEqual(loaded.compactions, 2);
		assert.strictEqual(loaded.modelChanges.length, 1);
		assert.strictEqual(loaded.thinkingChanges.length, 1);
	});

	it("writeMetadata works without optional name", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionId = "test-session-2";

		const meta: Metadata = {
			sessionId,
			messages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};

		await files.writeMetadata(sessionDir, sessionId, meta);

		const metaPath = path.join(sessionDir, `${sessionId}.metadata.json`);
		const loaded: Metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.strictEqual(loaded.sessionId, sessionId);
		assert.strictEqual(loaded.name, undefined);
	});

	it("writeMetadata formats JSON with indentation", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionId = "fmt-test";

		const meta: Metadata = {
			sessionId,
			messages: 1,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			cost: 0.0001,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};

		await files.writeMetadata(sessionDir, sessionId, meta);

		const metaPath = path.join(sessionDir, `${sessionId}.metadata.json`);
		const content = fs.readFileSync(metaPath, "utf-8");
		// Verify pretty-printed: first line should be `{`, last `}`
		const lines = content.trim().split("\n");
		assert.strictEqual(lines[0], "{");
		assert.strictEqual(lines[lines.length - 1], "}");
		// Should have indentation (leading space on non-first/last lines)
		assert.ok(lines.length > 2, "JSON should span multiple lines with indentation");
	});

	// ---------------------------------------------------------------------------
	// writeSessionReport tests
	// ---------------------------------------------------------------------------

	it("writeSessionReport writes <sessionId>.md with correct content", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionId = "test-session-md-456";
		const markdown = "# Session Report\n\nHello world";

		await files.writeSessionReport(sessionDir, sessionId, markdown);

		const mdPath = path.join(sessionDir, `${sessionId}.md`);
		assert.ok(fs.existsSync(mdPath), `Expected ${mdPath} to exist`);
		const content = fs.readFileSync(mdPath, "utf-8");
		assert.strictEqual(content, markdown);
	});

	it("writeSessionReport with different sessionIds produces separate .md files", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		await files.writeSessionReport(sessionDir, "sid-1", "md1");
		await files.writeSessionReport(sessionDir, "sid-2", "md2");

		const md1Path = path.join(sessionDir, "sid-1.md");
		const md2Path = path.join(sessionDir, "sid-2.md");
		assert.ok(fs.existsSync(md1Path), "First .md should exist");
		assert.ok(fs.existsSync(md2Path), "Second .md should exist");
		assert.strictEqual(fs.readFileSync(md1Path, "utf-8"), "md1");
		assert.strictEqual(fs.readFileSync(md2Path, "utf-8"), "md2");
	});

	it("writeMetadata with different sessionIds produces separate .metadata.json files", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta1: Metadata = {
			sessionId: "sid-a",
			messages: 1,
			tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
			cost: 0,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};
		const meta2: Metadata = {
			sessionId: "sid-b",
			messages: 2,
			tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 },
			cost: 0.001,
			compactions: 1,
			modelChanges: [],
			thinkingChanges: [],
		};

		await files.writeMetadata(sessionDir, "sid-a", meta1);
		await files.writeMetadata(sessionDir, "sid-b", meta2);

		const meta1Path = path.join(sessionDir, "sid-a.metadata.json");
		const meta2Path = path.join(sessionDir, "sid-b.metadata.json");
		assert.ok(fs.existsSync(meta1Path), "First metadata should exist");
		assert.ok(fs.existsSync(meta2Path), "Second metadata should exist");
		const loaded1: Metadata = JSON.parse(fs.readFileSync(meta1Path, "utf-8"));
		const loaded2: Metadata = JSON.parse(fs.readFileSync(meta2Path, "utf-8"));
		assert.strictEqual(loaded1.messages, 1);
		assert.strictEqual(loaded2.messages, 2);
	});

	it("old stale metadata.json (no sessionId prefix) is NOT created", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta: Metadata = {
			sessionId: "sid-c",
			messages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};

		await files.writeMetadata(sessionDir, "sid-c", meta);

		const stalePath = path.join(sessionDir, "metadata.json");
		assert.ok(!fs.existsSync(stalePath), "metadata.json without sessionId prefix should NOT exist");
	});

	it("old stale sessions.md (derived from dir basename) is NOT created", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		// sessionDir basename is "sessions" — old code would create "sessions.md"

		await files.writeSessionReport(sessionDir, "sid-d", "markdown content");

		const stalePath = path.join(sessionDir, "sessions.md");
		assert.ok(!fs.existsSync(stalePath), "sessions.md (from dir basename) should NOT exist");
	});

	it("writeMetadata with empty-string sessionId produces .metadata.json", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		const meta: Metadata = {
			sessionId: "",
			messages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
			compactions: 0,
			modelChanges: [],
			thinkingChanges: [],
		};

		await files.writeMetadata(sessionDir, "", meta);

		const metaPath = path.join(sessionDir, ".metadata.json");
		assert.ok(fs.existsSync(metaPath), "Empty sessionId should produce .metadata.json");
	});

	it("writeSessionReport with empty-string sessionId produces .md", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });

		await files.writeSessionReport(sessionDir, "", "empty-id");

		const mdPath = path.join(sessionDir, ".md");
		assert.ok(fs.existsSync(mdPath), "Empty sessionId should produce .md");
		assert.strictEqual(fs.readFileSync(mdPath, "utf-8"), "empty-id");
	});

	it("writeMetadata JSON roundtrips with full Metadata object", async () => {
		const sessionDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const sessionId = "roundtrip-test";

		const meta: Metadata = {
			sessionId,
			name: "Round Trip",
			messages: 42,
			tokens: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 50, total: 1650 },
			cost: 0.025,
			compactions: 3,
			modelChanges: [
				{ time: "2025-01-01T00:00:00Z", model: "openai/gpt-4" },
				{ time: "2025-01-01T01:00:00Z", model: "anthropic/claude-3" },
			],
			thinkingChanges: [
				{ time: "2025-01-01T00:00:00Z", level: "low" },
				{ time: "2025-01-01T01:00:00Z", level: "high" },
			],
			perTurnTokens: [
				{ turnIndex: 0, tokens: 500, cost: 0.005, toolCount: 2, errorCount: 0 },
				{ turnIndex: 1, tokens: 1000, cost: 0.015, toolCount: 3, errorCount: 1 },
			],
			toolStats: {
				read: { calls: 5, errors: 0, totalDurationMs: 1200 },
				write: { calls: 3, errors: 1, totalDurationMs: 800 },
			},
			fileModifications: [
				{ action: "read", path: "/file1", timestamp: "2025-01-01T00:00:00Z" },
				{ action: "write", path: "/file2", timestamp: "2025-01-01T00:01:00Z", size: 500 },
			],
		};

		await files.writeMetadata(sessionDir, sessionId, meta);

		const metaPath = path.join(sessionDir, `${sessionId}.metadata.json`);
		const loaded: Metadata = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		assert.deepStrictEqual(loaded, meta);
	});

	// ---------------------------------------------------------------------------
	// ensureLatestLink with non-existent dir throws
	// ---------------------------------------------------------------------------

	it("ensureSymlink with non-existent sessionsDir throws", async () => {
		const badDir = path.join(tmpDir, "nonexistent");
		const sessionFile = path.join(badDir, "session.jsonl");
		await assert.rejects(() => files.ensureSymlink(sessionFile, badDir), /waitForFile.*not found/i);
	});

	it("ensureMdSymlink with non-existent sessionDir throws", async () => {
		const badDir = path.join(tmpDir, "nonexistent");
		const mdFile = path.join(badDir, "session.md");
		await assert.rejects(() => files.ensureMdSymlink(badDir, mdFile), /waitForFile.*not found/i);
	});

	it("ensureLatestMetadataSymlink with non-existent dir throws", async () => {
		const badDir = path.join(tmpDir, "nonexistent");
		const metaFile = path.join(badDir, "session.metadata.json");
		await assert.rejects(
			() => files.ensureLatestMetadataSymlink(badDir, metaFile),
			/waitForFile.*not found/i,
		);
	});

	// ---------------------------------------------------------------------------
	// ensureSymlink preserves relative path from linkDir to target
	// ---------------------------------------------------------------------------

	it("ensureSymlink creates relative symlink (not absolute)", async () => {
		const sessionsDir = path.join(tmpDir, ".pi", "sessions");
		fs.mkdirSync(sessionsDir, { recursive: true });
		const sessionFile = path.join(sessionsDir, "session-abc.jsonl");
		fs.writeFileSync(sessionFile, "{}");

		await files.ensureSymlink(sessionFile, sessionsDir);

		const latestLink = path.join(sessionsDir, "latest.jsonl");
		const target = fs.readlinkSync(latestLink);
		// Target should be relative (not starting with /)
		assert.ok(!path.isAbsolute(target), `symlink target ${target} should be relative`);
	});
});
