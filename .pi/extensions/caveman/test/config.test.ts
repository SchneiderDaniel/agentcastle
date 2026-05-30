/**
 * Phase 1: Config store adapter — ensureConfigLoaded contract
 *
 * Verifies config.ts no longer sets currentLevel during load.
 * Session-policy decisions moved to use-case layer (session.ts).
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConfigStore } from "../config.ts";
import type { Level } from "../types.ts";
import { LEVELS } from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function randomDir(): string {
	return join(tmpdir(), `caveman-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function writeConfig(data: unknown): Promise<string> {
	const dir = randomDir();
	await mkdir(dir, { recursive: true });
	const path = join(dir, "caveman.json");
	await writeFile(path, JSON.stringify(data));
	return path;
}

async function cleanDir(dir: string): Promise<void> {
	try {
		await unlink(join(dir, "caveman.json"));
	} catch {
		/* ignore */
	}
	try {
		await rmdir(dir);
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfigStore adapter", () => {
	describe("ensureConfigLoaded", () => {
		it("parses valid config file and returns values via getConfig()", async () => {
			const path = await writeConfig({ defaultLevel: "ultra", showStatus: false });
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "ultra");
			assert.equal(store.getConfig().showStatus, false);
			await cleanDir(join(path, ".."));
		});

		it("falls back to DEFAULT_CONFIG when file is missing", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "nonexistent.json");
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "lite"); // DEFAULT_CONFIG
			assert.equal(store.getConfig().showStatus, true);
			await cleanDir(dir);
		});

		it("falls back to DEFAULT_CONFIG when file contains invalid JSON", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			await writeFile(path, "not-json{{{");
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "lite");
			await cleanDir(dir);
		});

		it("falls back to DEFAULT_CONFIG.defaultLevel when file has invalid defaultLevel string", async () => {
			const path = await writeConfig({ defaultLevel: "invalid", showStatus: false });
			const store = createConfigStore(path);
			await store.ensureConfigLoaded();
			assert.equal(store.getConfig().defaultLevel, "lite"); // DEFAULT_CONFIG
			await cleanDir(join(path, ".."));
		});

		it("does NOT mutate currentLevel when defaultLevel=off (no session-policy leak)", async () => {
			const path = await writeConfig({ defaultLevel: "off", showStatus: true });
			const store = createConfigStore(path);
			assert.equal(store.getLevel(), "off"); // initial
			await store.ensureConfigLoaded();
			// After fix: ensureConfigLoaded should NOT set currentLevel
			assert.equal(store.getLevel(), "off");
			await cleanDir(join(path, ".."));
		});

		it("does NOT seed currentLevel when defaultLevel=lite (config loader no longer seeds)", async () => {
			const path = await writeConfig({ defaultLevel: "lite", showStatus: true });
			const store = createConfigStore(path);
			assert.equal(store.getLevel(), "off"); // initial
			await store.ensureConfigLoaded();
			// After fix: config loader should not seed currentLevel
			assert.equal(store.getLevel(), "off");
			await cleanDir(join(path, ".."));
		});
	});

	describe("getLevel / setLevel round-trip", () => {
		it("round-trips all 4 levels", async () => {
			const path = await writeConfig(DEFAULT_CONFIG);
			const store = createConfigStore(path);
			for (const level of LEVELS) {
				store.setLevel(level);
				assert.equal(store.getLevel(), level, `round-trip failed for ${level}`);
			}
			await cleanDir(join(path, ".."));
		});
	});

	describe("saveConfig", () => {
		it("writes correct JSON to disk and subsequent ensureConfigLoaded reads it back", async () => {
			const dir = randomDir();
			await mkdir(dir, { recursive: true });
			const path = join(dir, "caveman.json");
			const store = createConfigStore(path);
			await store.saveConfig({ defaultLevel: "ultra", showStatus: false });

			// New store instance reads what was saved
			const store2 = createConfigStore(path);
			await store2.ensureConfigLoaded();
			assert.equal(store2.getConfig().defaultLevel, "ultra");
			assert.equal(store2.getConfig().showStatus, false);
			await cleanDir(dir);
		});
	});
});

const DEFAULT_CONFIG = { defaultLevel: "lite" as const, showStatus: true as const };
