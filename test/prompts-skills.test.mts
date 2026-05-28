/**
 * Integration tests for prompts.ts and skills.ts — listLocalPrompts, listLocalSkills, countSkills
 *
 * Reads from actual .pi/prompts/ and .pi/skills/ directories.
 *
 * Run with:
 *   node --experimental-strip-types --test test/prompts-skills.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { listLocalPrompts } from "../.pi/extensions/context-info/prompts.ts";
import { listLocalSkills, countSkills } from "../.pi/extensions/context-info/skills.ts";

// ---------------------------------------------------------------------------
// listLocalPrompts
// ---------------------------------------------------------------------------

describe("listLocalPrompts", () => {
	it("returns array of PromptMeta with name, filePath, description", async () => {
		const prompts = listLocalPrompts();
		assert.ok(Array.isArray(prompts));

		for (const p of prompts) {
			assert.ok(typeof p.name === "string", `name should be string, got ${typeof p.name}`);
			assert.ok(typeof p.filePath === "string", `filePath should be string for ${p.name}`);
			assert.ok(
				p.description === null || typeof p.description === "string",
				`description should be string or null for ${p.name}`,
			);
		}
	});

	it("results sorted by name ascending", () => {
		const prompts = listLocalPrompts();
		if (prompts.length > 1) {
			for (let i = 1; i < prompts.length; i++) {
				assert.ok(
					prompts[i - 1]!.name.localeCompare(prompts[i]!.name) <= 0,
					`prompts not sorted: ${prompts[i - 1]!.name} > ${prompts[i]!.name}`,
				);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// listLocalSkills
// ---------------------------------------------------------------------------

describe("listLocalSkills", () => {
	it("returns array of SkillMeta with name, filePath, description", async () => {
		const skills = listLocalSkills();
		assert.ok(Array.isArray(skills));

		for (const s of skills) {
			assert.ok(typeof s.name === "string", `name should be string, got ${typeof s.name}`);
			assert.ok(typeof s.filePath === "string", `filePath should be string for ${s.name}`);
			assert.ok(
				s.description === null || typeof s.description === "string",
				`description should be string or null for ${s.name}`,
			);
		}
	});

	it("results sorted by name ascending", () => {
		const skills = listLocalSkills();
		if (skills.length > 1) {
			for (let i = 1; i < skills.length; i++) {
				assert.ok(
					skills[i - 1]!.name.localeCompare(skills[i]!.name) <= 0,
					`skills not sorted: ${skills[i - 1]!.name} > ${skills[i]!.name}`,
				);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// countSkills
// ---------------------------------------------------------------------------

describe("countSkills", () => {
	it("returns positive number ≥ listLocalSkills().length", () => {
		const count = countSkills();
		const list = listLocalSkills();
		assert.ok(count >= list.length, `count ${count} should be >= list length ${list.length}`);
	});
});
