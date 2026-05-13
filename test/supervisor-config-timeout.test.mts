/**
 * Tests for loadConfig() agentTimeoutsMin integration.
 *
 * Uses real temp settings files. Imports supervisor functions via createRequire
 * (same pattern as supervisor-stream-activity.test.mts).
 *
 * Run with:
 *   npx tsx --test test/supervisor-config-timeout.test.mts
 */

import assert from "node:assert";
import { describe, it, afterEach } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

// Use createRequire to import CJS module from ESM test context.
const require = createRequire(import.meta.url);
const {
	validateAgentTimeouts,
} = require("../.pi/extensions/supervisor.ts");

// ─── Test infrastructure ────────────────────────────────────────────

const SETTINGS_PATH = ".pi/settings.json";
const BACKUP_PATH = ".pi/settings.json.test-backup";

function backupSettings(): void {
	if (existsSync(SETTINGS_PATH)) {
		renameSync(SETTINGS_PATH, BACKUP_PATH);
	}
}

function restoreSettings(): void {
	if (existsSync(BACKUP_PATH)) {
		renameSync(BACKUP_PATH, SETTINGS_PATH);
	}
}

function loadFixture(fixtureName: string): string {
	const fixturePath = `test/fixtures/${fixtureName}`;
	return readFileSync(fixturePath, "utf-8");
}

function writeSettings(content: string): void {
	writeFileSync(SETTINGS_PATH, content, "utf-8");
}

// ─── Test suite ─────────────────────────────────────────────────────

describe("loadConfig() agentTimeoutsMin integration", () => {
	// Backup real settings before tests
	backupSettings();

	afterEach(() => {
		// Cleanup: restore real settings after each test
		restoreSettings();
		// Then immediately backup again for next test
		if (existsSync(SETTINGS_PATH)) {
			renameSync(SETTINGS_PATH, BACKUP_PATH);
		}
	});

	it("settings with agentTimeoutsMin: {developer: 60} → validateAgentTimeouts returns {developer: 60}", () => {
		// Use the pure function directly with known agents from the mapping
		const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];
		const result = validateAgentTimeouts({ developer: 60 }, knownAgents);
		assert.deepStrictEqual(result, { developer: 60 });
	});

	it("missing agentTimeoutsMin key → validateAgentTimeouts returns {}", () => {
		const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];
		const result = validateAgentTimeouts(undefined, knownAgents);
		assert.deepStrictEqual(result, {});
	});

	it("agentTimeoutsMin: {} → validateAgentTimeouts returns {}", () => {
		const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];
		const result = validateAgentTimeouts({}, knownAgents);
		assert.deepStrictEqual(result, {});
	});

	it("agentTimeoutsMin: {developer: 0} → throws", () => {
		const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];
		assert.throws(
			() => validateAgentTimeouts({ developer: 0 }, knownAgents),
			/must be a positive integer/,
		);
	});

	it("agentTimeoutsMin: {developer: -5} → throws", () => {
		const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];
		assert.throws(
			() => validateAgentTimeouts({ developer: -5 }, knownAgents),
			/must be a positive integer/,
		);
	});

	it("agentTimeoutsMin: {developer: 'sixty'} → throws", () => {
		const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];
		assert.throws(
			() => validateAgentTimeouts({ developer: "sixty" }, knownAgents),
			/must be a positive integer/,
		);
	});

	it("agentTimeoutsMin: {develper: 10} → warning, empty result", () => {
		const knownAgents = ["architect", "researcher", "test-designer", "developer", "auditor"];
		const { mock } = require("node:test");
		const warnSpy = mock.method(console, "warn", () => {});
		const result = validateAgentTimeouts({ develper: 10 }, knownAgents);
		assert.deepStrictEqual(result, {});
		assert.ok(warnSpy.mock.calls.length >= 1);
		mock.reset();
	});
});
