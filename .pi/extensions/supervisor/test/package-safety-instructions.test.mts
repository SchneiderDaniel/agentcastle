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
// Phase 2: developer.md content tests
// ═══════════════════════════════════════════════════════════════════════

describe("developer.md — Package Safety Check instructions", () => {
	const content = readFile("agents/developer.md");

	it("contains 'Package Safety Check' reference", () => {
		assert.ok(content.includes("Package Safety"));
	});

	it("references 'npm view <pkg> time.created' before npm install", () => {
		assert.ok(content.includes("npm view <pkg> time.created"));
	});

	it("specifies refusal message with days-old placeholder", () => {
		assert.ok(
			content.includes("<X> days old") ||
				content.includes("X days old") ||
				content.includes("days old"),
		);
	});

	it("specifies fail-closed on command failure", () => {
		assert.ok(
			content.includes("fail closed") ||
				content.includes("fail-closed") ||
				content.includes("command fails"),
		);
	});

	it("mentions scoped packages (@scope/pkg)", () => {
		assert.ok(content.includes("@scope/pkg") || content.includes("@scope/"));
	});

	it("exempts git URLs, tarballs, local paths", () => {
		assert.ok(
			(content.includes("git URLs") || content.includes("git URL")) &&
				(content.includes("tarballs") || content.includes("tarball")),
		);
	});

	it("states no override or block is absolute", () => {
		assert.ok(
			content.includes("No override") ||
				content.includes("no override") ||
				content.includes("absolute"),
		);
	});

	it("appears after '### 3. Implement the changes' heading", () => {
		const implIdx = content.indexOf("### 3. Implement the changes");
		const safetyIdx = content.indexOf("Package Safety");
		assert.ok(implIdx >= 0, "'### 3. Implement the changes' heading must exist");
		assert.ok(safetyIdx >= 0, "'Package Safety' reference must exist");
		assert.ok(
			safetyIdx > implIdx,
			"'Package Safety' must appear after '### 3. Implement the changes'",
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

describe("Cross-file consistency", () => {
	const agentsContent = readFile("../../../AGENTS.md");
	const devContent = readFile("agents/developer.md");
	const resContent = readFile("agents/researcher.md");

	it("all three files reference same 14-day threshold", () => {
		for (const [name, c] of [
			["AGENTS.md", agentsContent],
			["developer.md", devContent],
			["researcher.md", resContent],
		]) {
			assert.ok(c.includes("14-day"), `${name} must reference 14-day threshold`);
		}
	});

	it('all three files reference "npm view" command', () => {
		for (const [name, c] of [
			["AGENTS.md", agentsContent],
			["developer.md", devContent],
			["researcher.md", resContent],
		]) {
			assert.ok(c.includes("npm view"), `${name} must reference npm view command`);
		}
	});

	it("all three files specify fail-closed behavior", () => {
		for (const [name, c] of [
			["AGENTS.md", agentsContent],
			["developer.md", devContent],
			["researcher.md", resContent],
		]) {
			assert.ok(
				c.includes("fail") || c.includes("block") || c.includes("blocking"),
				`${name} must specify fail-closed or block behavior`,
			);
		}
	});
});
