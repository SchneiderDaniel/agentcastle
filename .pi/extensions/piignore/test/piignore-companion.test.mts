/**
 * Tests for piignore-trust-check global companion extension.
 *
 * Verifies the companion registers a project_trust handler that scans
 * .piignore for restrictive patterns and warns the user, always returning
 * { trusted: "undecided" }.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/piignore/test/piignore-companion.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

// Import from implementation for TDD gate verification
import { default as createCompanion } from "../global-companion.ts";

// ═══════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════

interface ProjectTrustEvent {
	projectPath: string;
}

interface ProjectTrustContext {
	cwd?: string;
	hasUI: boolean;
	mode?: string;
	ui: {
		notify: (message: string, type: string) => void;
	};
}

interface ProjectTrustResult {
	trusted: "yes" | "no" | "undecided";
}

interface MockExtensionAPI {
	on(event: string, handler: Function): void;
	getProjectTrustHandler():
		| ((event: ProjectTrustEvent, ctx: ProjectTrustContext) => ProjectTrustResult)
		| undefined;
}

// ═══════════════════════════════════════════════════════════════════════
// Helper: create mock API
// ═══════════════════════════════════════════════════════════════════════

function createMockAPI(): MockExtensionAPI {
	let projectTrustHandler:
		| ((event: ProjectTrustEvent, ctx: ProjectTrustContext) => ProjectTrustResult)
		| undefined;

	return {
		on(event: string, handler: Function) {
			if (event === "project_trust") {
				projectTrustHandler = handler as (
					event: ProjectTrustEvent,
					ctx: ProjectTrustContext,
				) => ProjectTrustResult;
			}
		},
		getProjectTrustHandler() {
			return projectTrustHandler;
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Global companion (piignore-trust-check)
// ═══════════════════════════════════════════════════════════════════════

describe("piignore-trust-check companion", () => {
	const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piignore-companion-test-"));
	const testDir = path.join(tmpRoot, "project");

	beforeEach(() => {
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	// ── Registration ─────────────────────────────────────────────────

	it("companion registers a project_trust handler on init", () => {
		const api = createMockAPI();
		assert.strictEqual(api.getProjectTrustHandler(), undefined, "no handler before init");

		createCompanion(api as any);

		const handler = api.getProjectTrustHandler();
		assert.ok(handler, "companion should register project_trust handler");
	});

	// ── No .piignore ─────────────────────────────────────────────────

	it("project has no .piignore — returns undecided, no warning", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided when no .piignore");
		assert.strictEqual(warned, false, "should not warn when no .piignore");
	});

	// ── Restrictive patterns ─────────────────────────────────────────

	it("project has .piignore with restrictive pattern (**) — warns user", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "**\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		let warnMsg = "";
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: (msg: string) => {
					warned = true;
					warnMsg = msg;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should still return undecided");
		assert.ok(warned, "should warn about restrictive pattern");
		assert.ok(
			warnMsg.includes("restrictive"),
			`warning should mention restrictive, got: ${warnMsg}`,
		);
	});

	it("project has .piignore with restrictive pattern (*) — warns user", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "*\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn about restrictive * pattern");
	});

	it("project has .piignore with restrictive pattern (/) — warns user", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warned, "should warn about restrictive / pattern");
	});

	it("project has .piignore with multiple restrictive patterns — warns once", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), "**\n*\n/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warnCount = 0;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warnCount++;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided");
		assert.ok(warnCount >= 1, "should warn at least once");
	});

	// ── Normal patterns (no warning) ─────────────────────────────────

	it("project has .piignore with normal patterns (.env, secrets/) — no warning", () => {
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\nsecrets/\n", "utf-8");

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided");
		assert.strictEqual(warned, false, "should NOT warn about normal patterns");
	});

	// ── Error handling ───────────────────────────────────────────────

	it("readFileSync throws EACCES — caught, returns undecided", () => {
		// Create .piignore then make it unreadable
		fs.writeFileSync(path.join(testDir, ".piignore"), ".env\n", "utf-8");
		fs.chmodSync(path.join(testDir, ".piignore"), 0o000);

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided on EACCES");
		assert.strictEqual(warned, false, "should not warn on EACCES");
	});

	it(".piignore content is binary garbage — handled gracefully, returns undecided", () => {
		const binaryContent = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0x82]);
		fs.writeFileSync(path.join(testDir, ".piignore"), binaryContent);

		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		let warned = false;
		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {
					warned = true;
				},
			},
		};

		// Should not throw
		const result = handler({ projectPath: testDir }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided for binary content");
	});

	it("ctx.cwd is undefined — does not throw, returns undecided", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		const ctx: ProjectTrustContext = {
			cwd: undefined as unknown as string,
			hasUI: false,
			ui: {
				notify: () => {},
			},
		};

		// Should not throw
		const result = handler({ projectPath: "" }, ctx);
		assert.strictEqual(
			result.trusted,
			"undecided",
			"should return undecided when cwd is undefined",
		);
	});

	it("ctx.cwd is empty string — does not throw, returns undecided", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		const ctx: ProjectTrustContext = {
			cwd: "",
			hasUI: false,
			ui: {
				notify: () => {},
			},
		};

		const result = handler({ projectPath: "" }, ctx);
		assert.strictEqual(result.trusted, "undecided", "should return undecided when cwd is empty");
	});

	// ── Invariants ───────────────────────────────────────────────────

	it("handler never returns 'yes' or 'no' — only 'undecided'", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		// Test with restrictive patterns (should still return undecided)
		fs.writeFileSync(path.join(testDir, ".piignore"), "**\n", "utf-8");

		const ctx: ProjectTrustContext = {
			cwd: testDir,
			hasUI: true,
			ui: {
				notify: () => {},
			},
		};

		const result = handler({ projectPath: testDir }, ctx);
		// The handler must never return yes or no — it's read-only observation
		assert.ok(
			result.trusted === "undecided",
			`handler should always return undecided, got: ${result.trusted}`,
		);
	});

	it("handler does not throw — all errors caught internally", () => {
		const api = createMockAPI();
		createCompanion(api as any);
		const handler = api.getProjectTrustHandler()!;

		// Trigger various error scenarios
		const testCases: ProjectTrustContext[] = [
			{ cwd: "/nonexistent/path", hasUI: false, ui: { notify: () => {} } },
			{ cwd: testDir, hasUI: false, ui: { notify: () => {} } },
			{ cwd: "", hasUI: false, ui: { notify: () => {} } },
		];

		for (const ctx of testCases) {
			// Should never throw
			assert.doesNotThrow(() => {
				handler({ projectPath: ctx.cwd || "" }, ctx);
			}, `handler should not throw for cwd="${ctx.cwd}"`);
		}
	});
});
