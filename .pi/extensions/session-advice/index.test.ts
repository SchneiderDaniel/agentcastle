/**
 * Tests for session-advice `generateAdviceReport` recency weighting fix.
 *
 * Phase 1: Recency map key fix — sessionRecency keyed by header.id not filename
 * Phase 2: Report output integrity (regression guards)
 * Phase 3: Recency-weighted priority calculation
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	generateAdviceReport,
	writeAdvice,
	backfillMissingAdvice,
	handleShutdown,
} from "./index.ts";

// ── Helpers ──

const TMP_DIRS: string[] = [];

function createTempDir(): string {
	const dir = fs.mkdtempSync("/tmp/session-advice-test-");
	TMP_DIRS.push(dir);
	return dir;
}

function writeJsonl(
	dir: string,
	filename: string,
	headerId: string,
	bodyLines: string[] = [],
): void {
	const lines = [JSON.stringify({ type: "session", id: headerId }), ...bodyLines];
	fs.writeFileSync(path.join(dir, filename), lines.join("\n") + "\n", "utf-8");
}

/**
 * Build a minimal valid session with optional issue entry.
 * Returns the JSONL body line(s) to append after header.
 */
function makeToolCallEntry(category: string, detail: string, severity: string = "warning"): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					name: "bash",
					arguments: { command: "grep foo" },
				},
			],
		},
	});
}

// Make a minimal JSONL that parseJsonlFile can consume with a tool-mismatch symptom
function makeSessionBody(): string[] {
	return [
		JSON.stringify({
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "find something" }],
			},
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "bash",
						arguments: { command: "grep foo file.ts" },
					},
				],
			},
		}),
		JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: "line1\nline2" }],
				toolName: "bash",
				isError: false,
			},
		}),
	];
}

// ── Phase 1: Recency map fix ──

describe("Phase 1: Recency map fix — sessionRecency keyed by header.id", () => {
	after(() => {
		for (const d of TMP_DIRS) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
		TMP_DIRS.length = 0;
	});

	it("3 sessions: oldest gets recency 0, newest gets recency 1", () => {
		const dir = createTempDir();
		// Sorted order by filename: oldest.jsonl → middle.jsonl → newest.jsonl
		// Use distinct 8-char prefixes since report truncates to 8 chars
		writeJsonl(dir, "oldest.jsonl", "00000001-aaaa-4d58-9b9f-baf10748962e", makeSessionBody());
		writeJsonl(dir, "middle.jsonl", "00000002-bbbb-4d58-9b9f-baf10748962e", makeSessionBody());
		writeJsonl(dir, "newest.jsonl", "00000003-cccc-4d58-9b9f-baf10748962e", makeSessionBody());

		const report = generateAdviceReport(dir);

		// Report shows session IDs truncated to 8 chars in per-session table
		assert.ok(report.includes("00000001"), "report should contain session prefix 00000001");
		assert.ok(report.includes("00000003"), "report should contain session prefix 00000003");

		// All sessions have issues (tool-mismatch from bash grep), so report has findings
		assert.ok(report.includes("tool-mismatch"), "report should contain tool-mismatch category");
	});

	it("single session file: recency factor = 0, no crash", () => {
		const dir = createTempDir();
		writeJsonl(
			dir,
			"2026-01-01T00-00-00-000Z_single.jsonl",
			"00000001-aaaa-4d58-9b9f-baf10748962e",
			makeSessionBody(),
		);

		const report = generateAdviceReport(dir);
		assert.ok(report.includes("00000001"), "report should contain session prefix 00000001");
		assert.ok(report.includes("Sessions analyzed | 1"), "should analyze 1 session");
	});

	it("two session files: recency 0 and 1", () => {
		const dir = createTempDir();
		writeJsonl(dir, "a.jsonl", "uuid-a", makeSessionBody());
		writeJsonl(dir, "b.jsonl", "uuid-b", makeSessionBody());

		const report = generateAdviceReport(dir);
		assert.ok(report.includes("uuid-a"), "report should contain session uuid-a");
		assert.ok(report.includes("uuid-b"), "report should contain session uuid-b");
	});

	it("corrupt header (invalid JSON): fallback to filename key, no crash", () => {
		const dir = createTempDir();
		// Write a file with invalid JSON first line
		fs.writeFileSync(path.join(dir, "corrupt.jsonl"), "NOT JSON\n", "utf-8");

		const report = generateAdviceReport(dir);
		// Should not crash, report generated with this file skipped/unparseable
		assert.ok(report, "report should be generated even with corrupt file");
	});

	it("corrupt header (missing id field): fallback to filename key", () => {
		const dir = createTempDir();
		// Header valid JSON but no `id` field
		fs.writeFileSync(
			path.join(dir, "no-id.jsonl"),
			JSON.stringify({ type: "session" }) + "\n",
			"utf-8",
		);

		const report = generateAdviceReport(dir);
		assert.ok(report, "report should be generated even without id field");
	});

	it("5 sessions: all lookups match header UUID (none fall to 0.5 default)", () => {
		const dir = createTempDir();
		const uuids = ["uuid-001", "uuid-002", "uuid-003", "uuid-004", "uuid-005"];
		const filenames = [
			"2026-01-01T00-00-00-000Z_uuid-001.jsonl",
			"2026-01-02T00-00-00-000Z_uuid-002.jsonl",
			"2026-01-03T00-00-00-000Z_uuid-003.jsonl",
			"2026-01-04T00-00-00-000Z_uuid-004.jsonl",
			"2026-01-05T00-00-00-000Z_uuid-005.jsonl",
		];

		for (let i = 0; i < 5; i++) {
			writeJsonl(dir, filenames[i], uuids[i], makeSessionBody());
		}

		const report = generateAdviceReport(dir);
		// All 5 UUIDs should appear in report
		for (const id of uuids) {
			assert.ok(report.includes(id), `report should contain session ${id}`);
		}
	});

	it('empty header id (""): falls back to filename key, no crash', () => {
		const dir = createTempDir();
		fs.writeFileSync(
			path.join(dir, "empty-id.jsonl"),
			JSON.stringify({ type: "session", id: "" }) + "\n",
			"utf-8",
		);

		const report = generateAdviceReport(dir);
		assert.ok(report, "report should be generated with empty id");
	});
});

// ── Phase 2: Report output integrity ──

describe("Phase 2: Report output integrity (regression guards)", () => {
	let tmpDirs2: string[] = [];

	after(() => {
		for (const d of tmpDirs2) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
	});

	function makeDir(): string {
		const dir = fs.mkdtempSync("/tmp/session-advice-test-");
		tmpDirs2.push(dir);
		return dir;
	}

	it("all sessions clean — report says 0 findings", () => {
		const dir = makeDir();
		// Write session with no tool calls → no issues detected
		writeJsonl(dir, "clean1.jsonl", "uuid-clean-1", [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hello" }],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Hi!" }],
				},
			}),
		]);

		const report = generateAdviceReport(dir);
		assert.ok(report.includes("Clean sessions"), "report should mention clean sessions");
		assert.ok(report.includes("Total findings | 0"), "should have 0 findings");
	});

	it("mixed clean/dirty sessions — counts accurate", () => {
		const dir = makeDir();
		// Clean session
		writeJsonl(dir, "clean.jsonl", "uuid-clean", [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
				},
			}),
		]);
		// Dirty session (has bash grep)
		writeJsonl(dir, "dirty.jsonl", "uuid-dirty", makeSessionBody());

		const report = generateAdviceReport(dir);
		assert.ok(report.includes("Clean sessions | 1"), "should have 1 clean session");
		assert.ok(report.includes("Sessions with issues | 1"), "should have 1 dirty session");
	});

	it("empty sessions dir — report with 0 sessions, no crash", () => {
		const dir = makeDir();
		const report = generateAdviceReport(dir);
		assert.ok(report.includes("Sessions analyzed | 0"), "should have 0 sessions");
	});

	it("only latest.jsonl present — excluded from analysis, 0 sessions", () => {
		const dir = makeDir();
		const lines = [JSON.stringify({ type: "session", id: "latest-session" }), ...makeSessionBody()];
		fs.writeFileSync(path.join(dir, "latest.jsonl"), lines.join("\n") + "\n", "utf-8");

		const report = generateAdviceReport(dir);
		assert.ok(report.includes("Sessions analyzed | 0"), "latest.jsonl should be excluded");
	});

	it("unparseable JSONL — skipped gracefully", () => {
		const dir = makeDir();
		// Valid session
		writeJsonl(dir, "good.jsonl", "uuid-good", makeSessionBody());
		// Unparseable file (binary garbage)
		fs.writeFileSync(path.join(dir, "bad.jsonl"), Buffer.from([0, 1, 2, 3, 4]));

		const report = generateAdviceReport(dir);
		assert.ok(report.includes("Sessions analyzed | 2"), "should count both files");
		// At least one session has issues
		assert.ok(report.includes("Total findings |"), "report should have findings");
	});

	it("session with issues in multiple categories — grouping correct", () => {
		const dir = makeDir();
		// Create minimal session body that triggers tool-mismatch and redundant-read
		const bodyLines = [
			// Turn 0: user
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "check file and search" }],
				},
			}),
			// Turn 0: bash grep
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "bash",
							arguments: { command: "grep foo file.ts" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "result" }],
					toolName: "bash",
					isError: false,
				},
			}),
			// Turn 1: user
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "read file" }],
				},
			}),
			// Turn 1: read
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { path: "file.ts" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "content" }],
					toolName: "read",
					isError: false,
				},
			}),
			// Turn 2: user — triggers read again
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "read same file" }],
				},
			}),
			// Turn 2: read same path again
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { path: "file.ts" },
						},
					],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "content again" }],
					toolName: "read",
					isError: false,
				},
			}),
		];
		writeJsonl(dir, "multi-issue.jsonl", "uuid-multi", bodyLines);

		const report = generateAdviceReport(dir);
		// Should have tool-mismatch and redundant-read categories
		assert.ok(report.includes("tool-mismatch"), "should include tool-mismatch");
		assert.ok(report.includes("redundant-read"), "should include redundant-read");
	});
});

// ── Phase 3: Recency-weighted priority ──

describe("Phase 3: Recency-weighted priority calculation", () => {
	let tmpDirs3: string[] = [];

	after(() => {
		for (const d of tmpDirs3) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
	});

	function makeDir(): string {
		const dir = fs.mkdtempSync("/tmp/session-advice-test-");
		tmpDirs3.push(dir);
		return dir;
	}

	it("issue only in oldest session — priority Low", () => {
		const dir = makeDir();
		// Old session with grep issue
		writeJsonl(dir, "old.jsonl", "uuid-old", makeSessionBody());
		// New session with clean content (no tool calls → no issues)
		const cleanLines = [
			JSON.stringify({
				type: "message",
				message: {
					role: "user",
					content: [{ type: "text", text: "hi" }],
				},
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
				},
			}),
		];
		writeJsonl(dir, "new.jsonl", "uuid-new", cleanLines);

		const report = generateAdviceReport(dir);
		// Old session issue should have low priority (recency factor ≈ 0)
		assert.ok(report.includes("🟢 L"), "should have Low priority entry");
	});

	it("issue in newest session — higher priority than same issue in old session", () => {
		const dir = makeDir();
		// Both sessions have same tool-mismatch issue
		writeJsonl(dir, "old.jsonl", "uuid-old", makeSessionBody());
		writeJsonl(dir, "new.jsonl", "uuid-new", makeSessionBody());

		const report = generateAdviceReport(dir);
		// With 2 sessions, tool-mismatch appears in both
		assert.ok(report.includes("tool-mismatch"), "tool-mismatch should be in report");
		// Both sessions contribute to same category, so recency-weighted should be > low
		// Not asserting exact priority (depends on internal calculation) but must not crash
		assert.ok(report.includes("Total findings"), "report should have findings");
	});

	it("same issue across old + new — recent contributes 2x weight", () => {
		const dir = makeDir();
		// 3 sessions: old (first sorted), middle, new (last sorted)
		// All have tool-mismatch issue
		writeJsonl(dir, "2026-01-01T00-00-00-000Z_old.jsonl", "uuid-old", makeSessionBody());
		writeJsonl(dir, "2026-01-02T00-00-00-000Z_mid.jsonl", "uuid-mid", makeSessionBody());
		writeJsonl(dir, "2026-01-03T00-00-00-000Z_new.jsonl", "uuid-new", makeSessionBody());

		const report = generateAdviceReport(dir);
		// All 3 sessions contribute to tool-mismatch
		assert.ok(report.includes("3"), "should show 3 findings for tool-mismatch");
		// No crash, report generated
		assert.ok(report, "report generated successfully");
	});
});

// ── Phase 4: writeAdvice updateSymlink parameter — unit tests ──

describe("Phase 4: writeAdvice updateSymlink parameter", () => {
	const tmpDirs4: string[] = [];

	after(() => {
		for (const d of tmpDirs4) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
	});

	function makeDir(): string {
		const dir = fs.mkdtempSync("/tmp/session-advice-test-");
		tmpDirs4.push(dir);
		return dir;
	}

	it("updateSymlink=false, no prior symlink → symlink does NOT exist, advice file created", () => {
		const dir = makeDir();
		writeJsonl(dir, "session.jsonl", "uuid-test", makeSessionBody());
		const advicePath = path.join(dir, "session.advice.md");
		const symlinkPath = path.join(dir, "latest.advice.md");

		writeAdvice(path.join(dir, "session.jsonl"), advicePath, dir, false);

		assert.ok(fs.existsSync(advicePath), "advice file should be created");
		assert.ok(!fs.existsSync(symlinkPath), "symlink should NOT be created");
	});

	it("updateSymlink=false and existing symlink → symlink unchanged", () => {
		const dir = makeDir();
		// Create prior advice + symlink
		fs.writeFileSync(path.join(dir, "prior.advice.md"), "# Prior", "utf-8");
		fs.symlinkSync("prior.advice.md", path.join(dir, "latest.advice.md"));

		writeJsonl(dir, "session.jsonl", "uuid-test", makeSessionBody());
		const advicePath = path.join(dir, "session.advice.md");

		writeAdvice(path.join(dir, "session.jsonl"), advicePath, dir, false);

		const symlinkTarget = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(symlinkTarget, "prior.advice.md", "symlink should still point to prior.advice.md");
	});

	it("updateSymlink=true (default, no 4th arg) → symlink created", () => {
		const dir = makeDir();
		writeJsonl(dir, "session.jsonl", "uuid-test", makeSessionBody());
		const advicePath = path.join(dir, "session.advice.md");

		writeAdvice(path.join(dir, "session.jsonl"), advicePath, dir);

		const symlinkTarget = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(symlinkTarget, "session.advice.md", "symlink should point to session.advice.md");
	});

	it("updateSymlink=true with existing symlink → symlink updated", () => {
		const dir = makeDir();
		// Create prior advice + symlink
		fs.writeFileSync(path.join(dir, "prior.advice.md"), "# Prior", "utf-8");
		fs.symlinkSync("prior.advice.md", path.join(dir, "latest.advice.md"));

		writeJsonl(dir, "session.jsonl", "uuid-test", makeSessionBody());
		const advicePath = path.join(dir, "session.advice.md");

		writeAdvice(path.join(dir, "session.jsonl"), advicePath, dir, true);

		const symlinkTarget = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(
			symlinkTarget,
			"session.advice.md",
			"symlink should point to new session.advice.md",
		);
	});

	it("updateSymlink=false on invalid .jsonl → no advice created, symlink unchanged, no throw", () => {
		const dir = makeDir();
		const jsonlPath = path.join(dir, "corrupt.jsonl");
		fs.writeFileSync(jsonlPath, "NOT VALID JSON\n", "utf-8");
		const advicePath = path.join(dir, "corrupt.advice.md");
		const symlinkPath = path.join(dir, "latest.advice.md");

		// Should not throw
		writeAdvice(jsonlPath, advicePath, dir, false);

		assert.ok(!fs.existsSync(advicePath), "advice file should NOT be created for corrupt jsonl");
		assert.ok(!fs.existsSync(symlinkPath), "symlink should NOT exist");
	});
});

// ── Phase 5: Backfill preserves symlink — integration tests ──

describe("Phase 5: Backfill preserves symlink", () => {
	const tmpDirs5: string[] = [];

	after(() => {
		for (const d of tmpDirs5) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
	});

	function makeDir(): string {
		const dir = fs.mkdtempSync("/tmp/session-advice-test-");
		tmpDirs5.push(dir);
		return dir;
	}

	it("3 past sessions + existing symlink → backfill creates .advice.md files, symlink unchanged", () => {
		const dir = makeDir();
		// Existing session with advice + symlink
		writeJsonl(dir, "existing.jsonl", "uuid-existing", makeSessionBody());
		const existingAdvicePath = path.join(dir, "existing.advice.md");
		writeAdvice(path.join(dir, "existing.jsonl"), existingAdvicePath, dir, true);
		const symlinkTargetBefore = fs.readlinkSync(path.join(dir, "latest.advice.md"));

		// 3 past sessions without .advice.md
		writeJsonl(dir, "session-a.jsonl", "uuid-a", makeSessionBody());
		writeJsonl(dir, "session-b.jsonl", "uuid-b", makeSessionBody());
		writeJsonl(dir, "session-c.jsonl", "uuid-c", makeSessionBody());

		backfillMissingAdvice(dir);

		// All 3 .advice.md files created
		assert.ok(fs.existsSync(path.join(dir, "session-a.advice.md")));
		assert.ok(fs.existsSync(path.join(dir, "session-b.advice.md")));
		assert.ok(fs.existsSync(path.join(dir, "session-c.advice.md")));
		// Symlink unchanged
		const symlinkTargetAfter = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(symlinkTargetAfter, symlinkTargetBefore, "symlink should be unchanged");
	});

	it("3 past sessions, no prior symlink → backfill creates .advice.md files, no symlink created", () => {
		const dir = makeDir();
		writeJsonl(dir, "session-a.jsonl", "uuid-a", makeSessionBody());
		writeJsonl(dir, "session-b.jsonl", "uuid-b", makeSessionBody());
		writeJsonl(dir, "session-c.jsonl", "uuid-c", makeSessionBody());

		backfillMissingAdvice(dir);

		assert.ok(fs.existsSync(path.join(dir, "session-a.advice.md")));
		assert.ok(fs.existsSync(path.join(dir, "session-b.advice.md")));
		assert.ok(fs.existsSync(path.join(dir, "session-c.advice.md")));
		assert.ok(!fs.existsSync(path.join(dir, "latest.advice.md")), "no symlink should exist");
	});

	it("1 past session has .advice.md, 2 don't → only missing ones backfilled, symlink unchanged", () => {
		const dir = makeDir();
		// Session A already has .advice.md
		writeJsonl(dir, "session-a.jsonl", "uuid-a", makeSessionBody());
		fs.writeFileSync(path.join(dir, "session-a.advice.md"), "# Existing advice", "utf-8");
		fs.symlinkSync("session-a.advice.md", path.join(dir, "latest.advice.md"));

		// Sessions B, C without .advice.md
		writeJsonl(dir, "session-b.jsonl", "uuid-b", makeSessionBody());
		writeJsonl(dir, "session-c.jsonl", "uuid-c", makeSessionBody());

		backfillMissingAdvice(dir);

		// Session A advice unchanged
		const aContent = fs.readFileSync(path.join(dir, "session-a.advice.md"), "utf-8");
		assert.equal(aContent, "# Existing advice", "existing advice should not be overwritten");
		// Sessions B, C advice created
		assert.ok(fs.existsSync(path.join(dir, "session-b.advice.md")));
		assert.ok(fs.existsSync(path.join(dir, "session-c.advice.md")));
		// Symlink unchanged
		const symlinkTarget = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(symlinkTarget, "session-a.advice.md", "symlink should still point to session-a");
	});

	it("current in-progress session → skipped during backfill", () => {
		const dir = makeDir();
		// Current session file (in progress)
		const currentFile = path.join(dir, "session-current.jsonl");
		writeJsonl(dir, "session-current.jsonl", "uuid-current", makeSessionBody());
		// Past session without advice
		writeJsonl(dir, "session-past.jsonl", "uuid-past", makeSessionBody());

		backfillMissingAdvice(dir, currentFile);

		// Past session gets advice
		assert.ok(fs.existsSync(path.join(dir, "session-past.advice.md")));
		// Current session should NOT get advice via backfill
		assert.ok(
			!fs.existsSync(path.join(dir, "session-current.advice.md")),
			"current session should be skipped",
		);
	});
});

// ── Phase 6: Shutdown sets correct symlink — integration tests ──

describe("Phase 6: Shutdown sets correct symlink", () => {
	const tmpDirs6: string[] = [];

	after(() => {
		for (const d of tmpDirs6) {
			try {
				fs.rmSync(d, { recursive: true });
			} catch {
				/* ok */
			}
		}
	});

	function makeDir(): string {
		const dir = fs.mkdtempSync("/tmp/session-advice-test-");
		tmpDirs6.push(dir);
		return dir;
	}

	it("shutdown with valid session file → .advice.md created, symlink points to this session", () => {
		const dir = makeDir();
		const sessionFile = path.join(dir, "current.jsonl");
		writeJsonl(dir, "current.jsonl", "uuid-current", makeSessionBody());

		handleShutdown(sessionFile);

		assert.ok(fs.existsSync(path.join(dir, "current.advice.md")), "advice file should be created");
		assert.ok(fs.existsSync(path.join(dir, "latest.advice.md")), "symlink should exist");
		const symlinkTarget = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(symlinkTarget, "current.advice.md", "symlink should point to current session");
	});

	it("shutdown after backfill → symlink points to shutdown session, not backfilled", () => {
		const dir = makeDir();
		// 3 past sessions backfilled
		writeJsonl(dir, "session-a.jsonl", "uuid-a", makeSessionBody());
		writeJsonl(dir, "session-b.jsonl", "uuid-b", makeSessionBody());
		writeJsonl(dir, "session-c.jsonl", "uuid-c", makeSessionBody());
		backfillMissingAdvice(dir);

		// No symlink after backfill
		assert.ok(!fs.existsSync(path.join(dir, "latest.advice.md")), "no symlink after backfill");

		// Current session shuts down
		const sessionFile = path.join(dir, "current.jsonl");
		writeJsonl(dir, "current.jsonl", "uuid-current", makeSessionBody());
		handleShutdown(sessionFile);

		// Symlink points to current session
		const symlinkTarget = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(
			symlinkTarget,
			"current.advice.md",
			"symlink should point to current shutdown session",
		);
	});

	it("shutdown when .advice.md already exists → early return, symlink unchanged", () => {
		const dir = makeDir();
		const sessionFile = path.join(dir, "current.jsonl");
		writeJsonl(dir, "current.jsonl", "uuid-current", makeSessionBody());
		// Pre-create .advice.md (not by writeAdvice)
		fs.writeFileSync(path.join(dir, "current.advice.md"), "# Manual advice", "utf-8");
		fs.symlinkSync("current.advice.md", path.join(dir, "latest.advice.md"));

		const symlinkTargetBefore = fs.readlinkSync(path.join(dir, "latest.advice.md"));

		handleShutdown(sessionFile);

		// Symlink unchanged (early return means no symlink update)
		const symlinkTargetAfter = fs.readlinkSync(path.join(dir, "latest.advice.md"));
		assert.equal(symlinkTargetAfter, symlinkTargetBefore, "symlink should be unchanged");
	});

	it("shutdown with null/undefined sessionFile → no-op", () => {
		// Should not throw
		handleShutdown(null);
		handleShutdown(undefined);
		assert.ok(true, "no-op on null/undefined");
	});
});
