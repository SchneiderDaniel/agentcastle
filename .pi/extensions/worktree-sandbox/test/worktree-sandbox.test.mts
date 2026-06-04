/**
 * Tests: worktree-sandbox/index.ts — rewritePath helper
 *
 * Phase 1: Pure function unit tests for the extracted rewritePath helper.
 * Tests the path-rewriting logic that was previously duplicated across
 * read/write/edit handlers.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

// We export rewritePath from index.ts specifically for testing.
// The default export (extension factory) is also available.
let mod: {
	default: (pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) => void;
	rewritePath: (
		toolName: "read" | "write" | "edit",
		event: { input: { path: string } },
		sandboxRoot: string,
		ctx: {
			hasUI: boolean;
			ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		},
		blockNoun: "file operations" | "writes" | "edits",
	) => import("@earendil-works/pi-coding-agent").ToolCallEventResult | undefined;
};

// https://nodejs.org/api/esm.html#module-register-and-hooks --experimental-strip-types needed
// to import .ts files directly

// ─── Helpers ───────────────────────────────────────────────────────

const SANDBOX_ROOT = "/tmp/sandbox-test-root";

function makeEvent(path: string): { input: { path: string } } {
	return { input: { path } };
}

function makeCtx(hasUI: boolean): {
	hasUI: boolean;
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
} {
	const notifications: { msg: string; level?: string }[] = [];
	const ctx = {
		hasUI,
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ msg: message, level: type });
			},
		},
		// Expose collected notifications for assertion
		_notifications: notifications,
	} as {
		hasUI: boolean;
		ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
		_notifications: { msg: string; level?: string }[];
	};
	return ctx;
}

// ─── Setup: Dynamic import of the module ───────────────────────────

describe("rewritePath", () => {
	before(async () => {
		mod = await import("../index.ts");
	});

	// ── Empty path ────────────────────────────────────────────────

	it("returns undefined for empty path (pass-through)", () => {
		const event = makeEvent("");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	it("returns undefined for falsy path (pass-through)", () => {
		// Can't test null/undefined since event.input.path is typed as string
		// but empty string is handled
		const event = makeEvent("");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	// ── Absolute path inside sandbox ───────────────────────────────

	it("returns undefined for absolute path equal to sandbox root (edge case)", () => {
		const event = makeEvent(SANDBOX_ROOT);
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	it("returns undefined for absolute path inside sandbox (subdirectory)", () => {
		const event = makeEvent(join(SANDBOX_ROOT, "some/file.txt"));
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	// ── Absolute path outside sandbox ─────────────────────────────

	it("blocks absolute path outside sandbox with correct block noun (file operations)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("file operations"));
	});

	it("blocks absolute path outside sandbox with correct block noun (writes)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("writes"));
	});

	it("blocks absolute path outside sandbox with correct block noun (edits)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("edit", event, SANDBOX_ROOT, ctx, "edits");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("edits"));
	});

	// ── Relative path resolving inside sandbox ─────────────────────

	it("mutates event.input.path and returns undefined for relative path that resolves inside sandbox", () => {
		const event = makeEvent("relative/file.txt");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
		assert.equal(event.input.path, join(SANDBOX_ROOT, "relative/file.txt"));
	});

	// ── Relative path resolving outside sandbox ───────────────────

	it("blocks relative path that resolves outside sandbox with 'resolves outside' message", () => {
		const event = makeEvent("../../outside");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("resolves outside"));
	});

	// ── UI notification ───────────────────────────────────────────

	it("calls ctx.ui.notify() with correct tool name when ctx.hasUI is true (read)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const spy = ctx.ui.notify as ReturnType<typeof makeCtx>["ui"]["notify"] & { calls?: unknown[] };
		const originalNotify = ctx.ui.notify;
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};

		mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.msg.includes("Blocked read"));
		assert.equal(calls[0]!.level, "warning");
	});

	it("calls ctx.ui.notify() with correct tool name when ctx.hasUI is true (write)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};

		mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.msg.includes("Blocked write"));
		assert.equal(calls[0]!.level, "warning");
	});

	it("calls ctx.ui.notify() with correct tool name when ctx.hasUI is true (edit)", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};

		mod.rewritePath("edit", event, SANDBOX_ROOT, ctx, "edits");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.msg.includes("Blocked edit"));
		assert.equal(calls[0]!.level, "warning");
	});

	it("does NOT call ctx.ui.notify() when ctx.hasUI is false", () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(false);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};

		mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(calls.length, 0);
	});

	// ── Correct notification/reason text per tool ──────────────────

	it('produces notification "Blocked read to outside worktree" and reason containing "All file operations must stay" for read', () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};

		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.msg.includes("Blocked read to outside worktree"));
		assert.ok((result?.reason ?? "").includes("All file operations must stay"));
	});

	it('produces notification "Blocked write to outside worktree" and reason containing "All writes must stay" for write', () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};

		const result = mod.rewritePath("write", event, SANDBOX_ROOT, ctx, "writes");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.msg.includes("Blocked write to outside worktree"));
		assert.ok((result?.reason ?? "").includes("All writes must stay"));
	});

	it('produces notification "Blocked edit to outside worktree" and reason containing "All edits must stay" for edit', () => {
		const event = makeEvent("/etc/passwd");
		const ctx = makeCtx(true);
		const calls: { msg: string; level?: string }[] = [];
		ctx.ui.notify = (msg: string, level?: string) => {
			calls.push({ msg, level });
		};

		const result = mod.rewritePath("edit", event, SANDBOX_ROOT, ctx, "edits");
		assert.equal(calls.length, 1);
		assert.ok(calls[0]!.msg.includes("Blocked edit to outside worktree"));
		assert.ok((result?.reason ?? "").includes("All edits must stay"));
	});

	// ── Edge cases ────────────────────────────────────────────────

	it("handles path with .. that resolves inside sandbox", () => {
		// /tmp/sandbox-test-root/dir/../file.txt -> /tmp/sandbox-test-root/file.txt (inside)
		const event = makeEvent("dir/../file.txt");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
		assert.equal(event.input.path, join(SANDBOX_ROOT, "dir/../file.txt"));
		// join normalizes /tmp/sandbox-test-root/dir/../file.txt -> /tmp/sandbox-test-root/file.txt
	});

	it("handles path with .. that resolves outside sandbox", () => {
		// /tmp/sandbox-test-root/../../outside -> /tmp/outside (outside)
		const event = makeEvent("../../outside");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.equal(result.block, true);
		assert.ok((result.reason ?? "").includes("resolves outside"));
	});

	it("handles path that is a subdirectory of sandbox root (with trailing slash)", () => {
		// This already works because sandboxRoot is "/tmp/sandbox-test-root" (no trailing slash)
		// and subdir starts with sandboxRoot + "/"
		const event = makeEvent(join(SANDBOX_ROOT, "subdir"));
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(result, undefined);
	});

	it("returns reason containing the blocked path", () => {
		const event = makeEvent("/etc/shadow");
		const ctx = makeCtx(false);
		const result = mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.ok(result !== undefined);
		assert.ok((result.reason ?? "").includes("/etc/shadow"));
	});

	it("does not mutate event input when relative path resolves outside sandbox", () => {
		const event = makeEvent("../../outside");
		const originalPath = event.input.path;
		const ctx = makeCtx(false);
		mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		// Path should NOT be rewritten when blocking
		assert.equal(event.input.path, originalPath);
	});

	it("does not mutate event input when absolute path is blocked", () => {
		const event = makeEvent("/etc/passwd");
		const originalPath = event.input.path;
		const ctx = makeCtx(false);
		mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(event.input.path, originalPath);
	});

	it("does not mutate event input when absolute path is inside sandbox", () => {
		const event = makeEvent(SANDBOX_ROOT);
		const originalPath = event.input.path;
		const ctx = makeCtx(false);
		mod.rewritePath("read", event, SANDBOX_ROOT, ctx, "file operations");
		assert.equal(event.input.path, originalPath);
	});
});
