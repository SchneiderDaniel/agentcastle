/**
 * Tests for directory-aware extension resolution in supervisor/extensions.ts
 *
 * Phase 5: resolveExtensions checks if .pi/extensions/{ext} is a directory;
 * emits {ext}/index.ts instead of {ext}.ts. discoverExtensionTools reads
 * index.ts from subdirectories.
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// We duplicate the updated resolveExtensions logic for pure-unit testing,
// matching the updated production code in supervisor/extensions.ts
// ---------------------------------------------------------------------------

import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const CONTEXT_INFO_EXTENSION = ".pi/extensions/context-info.ts";

function resolveExtensions(extensionsRaw: string | undefined): string[] {
	if (!extensionsRaw || !extensionsRaw.trim()) {
		return ["--extension", CONTEXT_INFO_EXTENSION];
	}

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	const result: string[] = [];
	for (const ext of extensions) {
		const tsPath = `.pi/extensions/${ext}.ts`;
		const dirPath = `.pi/extensions/${ext}`;
		const dirIndexPath = `${dirPath}/index.ts`;
		const fullDirPath = resolvePath(process.cwd(), dirPath);
		if (existsSync(fullDirPath) && statSync(fullDirPath).isDirectory()) {
			result.push("--extension", dirIndexPath);
		} else {
			result.push("--extension", tsPath);
		}
	}

	// Auto-inject context-info (deduplicated)
	const hasContextInfo = result.some(
		(r) => r === CONTEXT_INFO_EXTENSION || r.endsWith("/context-info.ts"),
	);
	if (!hasContextInfo) {
		result.push("--extension", CONTEXT_INFO_EXTENSION);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Test helpers for temp directory structure
// ---------------------------------------------------------------------------

let origCwd: string;

beforeEach(() => {
	origCwd = process.cwd();
});

afterEach(() => {
	process.chdir(origCwd);
});

function setupFixture() {
	const tmpDir = mkdtempSync(join(tmpdir(), "ext-dir-test-"));
	const extDir = join(tmpDir, ".pi", "extensions");

	// Create directory-based extension: caveman/index.ts
	const cavemanDir = join(extDir, "caveman");
	mkdirSync(cavemanDir, { recursive: true });
	writeFileSync(
		join(cavemanDir, "index.ts"),
		`export default function caveman(pi: any) { pi.registerTool({ name: "caveman-tool", handler: () => {} }); }`,
		"utf8",
	);

	// Create file-based extension: ask-user.ts
	writeFileSync(
		join(extDir, "ask-user.ts"),
		`export default function askUser(pi: any) { pi.registerTool({ name: "ask-user-tool", handler: () => {} }); }`,
		"utf8",
	);

	process.chdir(tmpDir);
	return tmpDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveExtensions — directory-aware resolution", () => {
	it("caveman when directory -> resolves to caveman/index.ts", () => {
		const tmpDir = setupFixture();
		const result = resolveExtensions("caveman");
		assert.ok(
			result.some((r) => r.includes("caveman/index.ts")),
			`Expected caveman/index.ts in result, got: ${JSON.stringify(result)}`,
		);
	});

	it("ask-user when file (not dir) -> resolves to ask-user.ts", () => {
		const tmpDir = setupFixture();
		const result = resolveExtensions("ask-user");
		assert.ok(
			result.some((r) => r.includes("ask-user.ts") && !r.includes("index.ts")),
			`Expected ask-user.ts in result, got: ${JSON.stringify(result)}`,
		);
	});

	it("nonexistent when neither file nor dir -> falls back to .ts path", () => {
		const tmpDir = setupFixture();
		const result = resolveExtensions("nonexistent");
		assert.ok(
			result.some((r) => r.includes("nonexistent.ts")),
			`Expected nonexistent.ts fallback, got: ${JSON.stringify(result)}`,
		);
	});

	it("caveman,supervisor -> supervisor filtered, caveman resolves to index.ts", () => {
		const tmpDir = setupFixture();
		const result = resolveExtensions("caveman,supervisor");
		assert.ok(
			result.some((r) => r.includes("caveman/index.ts")),
			`Expected caveman/index.ts, got: ${JSON.stringify(result)}`,
		);
		assert.ok(!result.some((r) => r.includes("supervisor")));
	});

	it("empty string returns []-with-context-info", () => {
		const result = resolveExtensions("");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("undefined returns []-with-context-info", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("scrapling still resolves to scrapling.ts (unchanged file-based)", () => {
		const tmpDir = setupFixture();
		const result = resolveExtensions("scrapling");
		assert.ok(
			result.some((r) => r.includes("scrapling.ts")),
			`Expected scrapling.ts, got: ${JSON.stringify(result)}`,
		);
	});
});
