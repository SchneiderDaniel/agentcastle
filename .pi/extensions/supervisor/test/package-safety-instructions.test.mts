/**
 * Tests for npm package age check instructions in agent prompt files.
 *
 * Verifies AGENTS.md, .pi/extensions/supervisor/agents/developer.md, and .pi/extensions/supervisor/agents/researcher.md
 * all contain the required package safety rules.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/package-safety-instructions.test.mts
 */

import assert from "node:assert";
import fs from "node:fs";
import { describe, it } from "node:test";

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function readFile(relativePath: string): string {
	const resolved = new URL(`../${relativePath}`, import.meta.url);
	return fs.readFileSync(resolved, "utf-8");
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: AGENTS.md content tests
// ═══════════════════════════════════════════════════════════════════════

describe("AGENTS.md — Package Safety section", () => {
	const content = readFile("../../../AGENTS.md");

	it("contains '## Package Safety' heading", () => {
		assert.ok(content.includes("## Package Safety"));
	});

	it("mentions 14-day threshold", () => {
		assert.ok(content.includes("14-day"));
	});

	it("mentions 'npm view <pkg> time.created' command", () => {
		assert.ok(content.includes("npm view <pkg> time.created"));
	});

	it("excludes git URLs, tarballs, and local paths", () => {
		assert.ok(
			content.includes("does NOT apply to git URLs") ||
				content.includes("does not apply to git URLs") ||
				(content.includes("git URLs") && content.includes("tarballs")),
		);
	});

	it("states no override mechanism exists", () => {
		assert.ok(
			content.includes("No override mechanism") ||
				content.includes("no override mechanism") ||
				content.includes("No override."),
		);
	});

	it("states fail-closed or block behavior", () => {
		assert.ok(content.includes("fail") || content.includes("block"));
	});

	it("is placed after '## Tool Reference' heading", () => {
		const searchToolsIdx = content.indexOf("## Tool Reference");
		const packageSafetyIdx = content.indexOf("## Package Safety");
		assert.ok(searchToolsIdx >= 0, "'## Tool Reference' heading must exist");
		assert.ok(packageSafetyIdx >= 0, "'## Package Safety' heading must exist");
		assert.ok(
			packageSafetyIdx > searchToolsIdx,
			"'## Package Safety' must appear after '## Search Tools'",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: researcher.md content tests
// ═══════════════════════════════════════════════════════════════════════

describe("researcher.md — Package age reference", () => {
	const content = readFile("agents/researcher.md");

	it("references npm package age or 'Package age'", () => {
		assert.ok(
			content.includes("Package age") ||
				content.includes("package age") ||
				content.includes("Package Age"),
		);
	});

	it("mentions 'npm view <pkg> time.created'", () => {
		assert.ok(content.includes("npm view <pkg> time.created"));
	});

	it("references 14-day threshold", () => {
		assert.ok(content.includes("14-day"));
	});

	it("mentions fail-closed on missing or unparseable date", () => {
		assert.ok(
			content.includes("fail-closed") ||
				content.includes("missing or unparseable") ||
				(content.includes("missing") && content.includes("flag")),
		);
	});

	it("mentions typosquatting or dependency confusion", () => {
		assert.ok(content.includes("typosquatting") || content.includes("dependency confusion"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Cross-file consistency tests
// ═══════════════════════════════════════════════════════════════════════
// Note: developer.md no longer contains package safety instructions per Issue #700.
// The Package Safety Check moved to the pipeline gate in stages.ts.

describe("Cross-file consistency", () => {
	const agentsContent = readFile("../../../AGENTS.md");
	const resContent = readFile("agents/researcher.md");

	it("AGENTS.md and researcher.md reference same 14-day threshold", () => {
		for (const [name, c] of [
			["AGENTS.md", agentsContent],
			["researcher.md", resContent],
		]) {
			assert.ok(c.includes("14-day"), `${name} must reference 14-day threshold`);
		}
	});

	it('AGENTS.md and researcher.md reference "npm view" command', () => {
		for (const [name, c] of [
			["AGENTS.md", agentsContent],
			["researcher.md", resContent],
		]) {
			assert.ok(c.includes("npm view"), `${name} must reference npm view command`);
		}
	});

	it("AGENTS.md and researcher.md specify fail-closed behavior", () => {
		for (const [name, c] of [
			["AGENTS.md", agentsContent],
			["researcher.md", resContent],
		]) {
			assert.ok(
				c.includes("fail") || c.includes("block") || c.includes("blocking"),
				`${name} must specify fail-closed or block behavior`,
			);
		}
	});
});
