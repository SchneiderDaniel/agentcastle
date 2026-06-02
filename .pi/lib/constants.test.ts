/**
 * Tests for shared constants extracted to constants.ts.
 * Verifies exact values, ordering, and readonly nature.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { READ_BASH_CMDS, FILE_MODIFY_SIGNALS } from "./constants.ts";

// ── Entity: READ_BASH_CMDS ──

describe("READ_BASH_CMDS (from constants.ts)", () => {
	it("has exactly the expected values in order", () => {
		assert.deepEqual([...READ_BASH_CMDS], ["cat", "head", "tail", "less", "more"]);
	});

	it("is declared as readonly array", () => {
		// TypeScript readonly: push should not be possible at compile time
		assert.ok(Array.isArray(READ_BASH_CMDS));
		// Verify immutability at runtime — Object.freeze or equivalent
		assert.throws(
			() => {
				(READ_BASH_CMDS as string[]).push("bat");
			},
			/readonly|frozen|immutable|not extensible|Cannot add property/,
			"READ_BASH_CMDS should be frozen or readonly at runtime",
		);
	});

	it("contains cat, head, tail, less, more", () => {
		for (const cmd of ["cat", "head", "tail", "less", "more"]) {
			assert.ok(READ_BASH_CMDS.includes(cmd), `${cmd} should be in READ_BASH_CMDS`);
		}
	});

	it("does not contain bat or other non-read commands", () => {
		assert.equal(READ_BASH_CMDS.includes("bat"), false);
		assert.equal(READ_BASH_CMDS.includes("echo"), false);
		assert.equal(READ_BASH_CMDS.includes("sed"), false);
	});
});

// ── Entity: FILE_MODIFY_SIGNALS ──

describe("FILE_MODIFY_SIGNALS (from constants.ts)", () => {
	it("has exactly the expected values in order", () => {
		assert.deepEqual(
			[...FILE_MODIFY_SIGNALS],
			["sed", "echo", "cat", "tee", "mv", "cp", "rm", "chmod", "dd"],
		);
	});

	it("is declared as readonly array", () => {
		assert.ok(Array.isArray(FILE_MODIFY_SIGNALS));
		assert.throws(
			() => {
				(FILE_MODIFY_SIGNALS as string[]).push("truncate");
			},
			/readonly|frozen|immutable|not extensible|Cannot add property/,
			"FILE_MODIFY_SIGNALS should be frozen or readonly at runtime",
		);
	});

	it("contains all file-modifying commands", () => {
		for (const cmd of ["sed", "echo", "cat", "tee", "mv", "cp", "rm", "chmod", "dd"]) {
			assert.ok(FILE_MODIFY_SIGNALS.includes(cmd), `${cmd} should be in FILE_MODIFY_SIGNALS`);
		}
	});

	it("does not contain read-only commands", () => {
		assert.equal(FILE_MODIFY_SIGNALS.includes("ls"), false);
		assert.equal(FILE_MODIFY_SIGNALS.includes("grep"), false);
		assert.equal(FILE_MODIFY_SIGNALS.includes("rg"), false);
	});
});
