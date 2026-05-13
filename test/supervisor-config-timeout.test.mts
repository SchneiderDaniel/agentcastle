/**
 * Tests for loadConfig() agentTimeoutsMin integration.
 *
 * Writes real temp settings files to .pi/settings.json,
 * calls loadConfig(), and asserts on the returned SupervisorConfig.
 *
 * Run with:
 *   npx tsx --test test/supervisor-config-timeout.test.mts
 */

import assert from "node:assert";
import { describe, it, after, mock } from "node:test";
import { createRequire } from "node:module";
import { writeFileSync, readFileSync, existsSync, renameSync, unlinkSync } from "node:fs";

// Use createRequire to import CJS module from ESM test context.
const require = createRequire(import.meta.url);
const { loadConfig } = require("../.pi/extensions/supervisor.ts");

// ─── Test infrastructure ────────────────────────────────────────────

const SETTINGS_PATH = ".pi/settings.json";
const BACKUP_PATH = ".pi/settings.json.test-backup";

/** Save original settings content in memory. */
let originalSettingsContent: string | null = null;

function saveOriginal(): void {
	if (existsSync(SETTINGS_PATH)) {
		originalSettingsContent = readFileSync(SETTINGS_PATH, "utf-8");
	}
}

function writeSettings(content: string): void {
	writeFileSync(SETTINGS_PATH, content, "utf-8");
}

function restoreOriginal(): void {
	// Clean up any leftover backup from interrupted runs
	if (existsSync(BACKUP_PATH)) {
		unlinkSync(BACKUP_PATH);
	}
	if (originalSettingsContent !== null) {
		writeFileSync(SETTINGS_PATH, originalSettingsContent, "utf-8");
	}
}

// ─── Test suite ─────────────────────────────────────────────────────

describe("loadConfig() agentTimeoutsMin integration", () => {
	// Save original settings before tests
	saveOriginal();

	// Restore after ALL tests done (not afterEach — avoids eating the file)
	after(() => {
		restoreOriginal();
	});

	it("settings with agentTimeoutsMin: {developer: 60} → config.agentTimeoutsMin equals {developer: 60}", () => {
		writeSettings(JSON.stringify({
			supervisor: {
				repo: "test/test",
				projectNumber: 1,
				statusMapping: {
					Architecture: "architect",
					Implementation: "developer",
					Audit: "auditor",
					Research: "researcher",
					TestDesign: "test-designer",
				},
				codeowners: ["testuser"],
				agentTimeoutsMin: { developer: 60 },
			},
		}));

		const config = loadConfig();
		assert.deepStrictEqual(config.agentTimeoutsMin, { developer: 60 });
	});

	it("missing agentTimeoutsMin key → config.agentTimeoutsMin is {}", () => {
		writeSettings(JSON.stringify({
			supervisor: {
				repo: "test/test",
				projectNumber: 1,
				statusMapping: {
					Architecture: "architect",
					Implementation: "developer",
					Audit: "auditor",
					Research: "researcher",
					TestDesign: "test-designer",
				},
				codeowners: ["testuser"],
			},
		}));

		const config = loadConfig();
		assert.deepStrictEqual(config.agentTimeoutsMin, {});
	});

	it("agentTimeoutsMin: {} → config.agentTimeoutsMin is {}", () => {
		writeSettings(JSON.stringify({
			supervisor: {
				repo: "test/test",
				projectNumber: 1,
				statusMapping: {
					Architecture: "architect",
					Implementation: "developer",
					Audit: "auditor",
					Research: "researcher",
					TestDesign: "test-designer",
				},
				codeowners: ["testuser"],
				agentTimeoutsMin: {},
			},
		}));

		const config = loadConfig();
		assert.deepStrictEqual(config.agentTimeoutsMin, {});
	});

	it("agentTimeoutsMin: {developer: 0} → loadConfig() throws", () => {
		writeSettings(JSON.stringify({
			supervisor: {
				repo: "test/test",
				projectNumber: 1,
				statusMapping: {
					Architecture: "architect",
					Implementation: "developer",
					Audit: "auditor",
					Research: "researcher",
					TestDesign: "test-designer",
				},
				codeowners: ["testuser"],
				agentTimeoutsMin: { developer: 0 },
			},
		}));

		assert.throws(
			() => loadConfig(),
			/agentTimeoutsMin\.developer must be a positive integer, got 0/,
		);
	});

	it("agentTimeoutsMin: {developer: -5} → loadConfig() throws", () => {
		writeSettings(JSON.stringify({
			supervisor: {
				repo: "test/test",
				projectNumber: 1,
				statusMapping: {
					Architecture: "architect",
					Implementation: "developer",
					Audit: "auditor",
					Research: "researcher",
					TestDesign: "test-designer",
				},
				codeowners: ["testuser"],
				agentTimeoutsMin: { developer: -5 },
			},
		}));

		assert.throws(
			() => loadConfig(),
			/agentTimeoutsMin\.developer must be a positive integer, got -5/,
		);
	});

	it("agentTimeoutsMin: {developer: 'sixty'} → loadConfig() throws", () => {
		writeSettings(JSON.stringify({
			supervisor: {
				repo: "test/test",
				projectNumber: 1,
				statusMapping: {
					Architecture: "architect",
					Implementation: "developer",
					Audit: "auditor",
					Research: "researcher",
					TestDesign: "test-designer",
				},
				codeowners: ["testuser"],
				agentTimeoutsMin: { developer: "sixty" },
			},
		}));

		assert.throws(
			() => loadConfig(),
			/agentTimeoutsMin\.developer must be a positive integer/,
		);
	});

	it("agentTimeoutsMin: {develper: 10} → warning logged, config.agentTimeoutsMin is {}", () => {
		writeSettings(JSON.stringify({
			supervisor: {
				repo: "test/test",
				projectNumber: 1,
				statusMapping: {
					Architecture: "architect",
					Implementation: "developer",
					Audit: "auditor",
					Research: "researcher",
					TestDesign: "test-designer",
				},
				codeowners: ["testuser"],
				agentTimeoutsMin: { develper: 10 },
			},
		}));

		const warnSpy = mock.method(console, "warn", () => {});
		const config = loadConfig();
		assert.deepStrictEqual(config.agentTimeoutsMin, {});
		assert.ok(warnSpy.mock.calls.length >= 1, "Expected console.warn to be called");
		const warnMsgs = warnSpy.mock.calls.map(c => c.arguments[0]).join(" ");
		assert.ok(warnMsgs.includes("develper"), `Warning should mention 'develper', got: ${warnMsgs}`);
		mock.reset();
	});
});
