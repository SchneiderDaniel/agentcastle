/**
 * Tests for dead-code-hunter skill added to auditor agent.
 *
 * Phase 1: Skills frontmatter — verify `skills: dead-code-hunter` in YAML
 * Phase 2: Regression — existing resolveSkillPaths behavior unchanged
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/auditor-dead-code-hunter.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSkillPaths, resolveSkillPathsWithFs } from "../config/extensions.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const AUDITOR_MD = resolve(__dirname, "../agents/auditor.md");

function readAuditorMd(): string {
	return readFileSync(AUDITOR_MD, "utf-8");
}

/**
 * Extract YAML frontmatter from auditor.md as an array of lines.
 */
function getFrontmatterLines(content: string): string[] {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return [];
	return match[1]!.split("\n");
}

/**
 * Extract a specific field from YAML frontmatter.
 */
function getFrontmatterField(content: string, field: string): string | undefined {
	const lines = getFrontmatterLines(content);
	for (const line of lines) {
		const kv = line.match(new RegExp(`^${field}\\s*:\\s*(.+)$`));
		if (kv) return kv[1]!.trim();
	}
	return undefined;
}

// ─── Phase 1: Skills frontmatter ──────────────────────────────────

describe("auditor.md — skills frontmatter (Phase 1)", () => {
	it("contains 'skills' field in YAML frontmatter", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal !== undefined, "YAML frontmatter should contain 'skills' field");
	});

	it("skills field value includes 'dead-code-hunter'", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		assert.ok(
			skillsVal!.includes("dead-code-hunter"),
			`skills value '${skillsVal}' should include 'dead-code-hunter'`,
		);
	});

	it("skills field value includes 'duplicate-code-hunter' (existing preserved)", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		assert.ok(
			skillsVal!.includes("duplicate-code-hunter"),
			`skills value '${skillsVal}' should include 'duplicate-code-hunter'`,
		);
	});

	it("skills line appears after 'extensions:' line", () => {
		const content = readAuditorMd();
		const lines = getFrontmatterLines(content);
		const extIdx = lines.findIndex((l) => l.startsWith("extensions:"));
		const skillsIdx = lines.findIndex((l) => l.startsWith("skills:"));
		assert.ok(extIdx >= 0, "extensions field must exist");
		assert.ok(skillsIdx >= 0, "skills field must exist");
		assert.ok(
			skillsIdx > extIdx,
			`skills line (index ${skillsIdx}) should appear after extensions line (index ${extIdx})`,
		);
	});

	it("skills value contains both skills separated by comma or space", () => {
		const content = readAuditorMd();
		const skillsVal = getFrontmatterField(content, "skills");
		assert.ok(skillsVal, "skills field must exist");
		const normalized = skillsVal!.replace(/["']/g, "").trim();
		assert.ok(
			normalized.includes("duplicate-code-hunter") && normalized.includes("dead-code-hunter"),
			`skills value '${normalized}' should contain both skills`,
		);
	});
});

// ─── Phase 2: Regression — resolveSkillPaths ──────────────────────

describe("resolveSkillPaths regression (Phase 2)", () => {
	it("resolveSkillPaths('duplicate-code-hunter') returns array with correct path", () => {
		const result = resolveSkillPaths("duplicate-code-hunter");
		assert.equal(result.length, 1);
		assert.ok(
			result[0]!.endsWith(".pi/skills/duplicate-code-hunter/SKILL.md") ||
				result[0]!.endsWith("duplicate-code-hunter/SKILL.md"),
			`Path should end with duplicate-code-hunter/SKILL.md, got ${result[0]}`,
		);
	});

	it("resolveSkillPaths('dead-code-hunter') returns array with correct path", () => {
		const result = resolveSkillPaths("dead-code-hunter");
		assert.equal(result.length, 1);
		assert.ok(
			result[0]!.endsWith(".pi/skills/dead-code-hunter/SKILL.md") ||
				result[0]!.endsWith("dead-code-hunter/SKILL.md"),
			`Path should end with dead-code-hunter/SKILL.md, got ${result[0]}`,
		);
	});

	it("resolveSkillPaths('extension-spec') still resolves correctly (regression)", () => {
		const result = resolveSkillPaths("extension-spec");
		assert.equal(result.length, 1);
		assert.ok(
			result[0]!.endsWith("extension-spec/SKILL.md") || result[0]!.endsWith("extension-spec.md"),
		);
	});

	it("resolveSkillPaths('') returns empty array (regression)", () => {
		assert.deepEqual(resolveSkillPaths(""), []);
	});

	it("resolveSkillPaths(undefined) returns empty array (regression)", () => {
		assert.deepEqual(resolveSkillPaths(undefined), []);
	});

	it("resolveSkillPaths('   ') returns empty array (regression)", () => {
		assert.deepEqual(resolveSkillPaths("   "), []);
	});

	it("resolveSkillPaths('nonexistent-skill-xyz') throws (regression)", () => {
		assert.throws(() => resolveSkillPaths("nonexistent-skill-xyz"), /nonexistent-skill-xyz/);
	});
});
