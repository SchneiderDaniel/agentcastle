/**
 * Tests for .pi/extensions/context-info/frontmatter.ts — extractDescription()
 *
 * Pure function, no I/O. Tests cover all edge cases from the test plan.
 *
 * Run with:
 *   node --experimental-strip-types --test test/frontmatter.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// Phase 1: extractDescription unit tests
import { extractDescription } from "../.pi/extensions/context-info/frontmatter.ts";

describe("extractDescription", () => {
	it("standard frontmatter + description key → returns description value, trimmed", () => {
		const content = `---
title: Test
description: A test prompt
---
Some content here`;
		assert.strictEqual(extractDescription(content), "A test prompt");
	});

	it("missing frontmatter (no --- delimiters) → null", () => {
		const content = `Just some markdown content
with no frontmatter at all`;
		assert.strictEqual(extractDescription(content), null);
	});

	it("frontmatter present but no description: key → null", () => {
		const content = `---
title: Test
author: me
---
Content here`;
		assert.strictEqual(extractDescription(content), null);
	});

	it("empty content string → null", () => {
		assert.strictEqual(extractDescription(""), null);
	});

	it("content with only whitespace → null", () => {
		assert.strictEqual(extractDescription("   \n  \n  "), null);
	});

	it("description exactly at line 29 (within scan window) → parsed", () => {
		// Build content where description: key is on line 29 (last line of the 30-line scan window)
		const lines: string[] = ["---"];
		for (let i = 0; i < 26; i++) {
			lines.push(`key${i}: value${i}`);
		}
		lines.push("description: found at line 29");
		lines.push("---");
		lines.push("Content");
		const content = lines.join("\n");
		// Head is lines 0-29 (30 lines). Closing --- is at line 28 (0-indexed), within range.
		assert.strictEqual(extractDescription(content), "found at line 29");
	});

	it("description key beyond 30-line scan window → null", () => {
		// Description: key and closing --- are past the 30-line head
		const lines: string[] = ["---"];
		for (let i = 0; i < 30; i++) {
			lines.push(`key${i}: value${i}`);
		}
		lines.push("---");
		lines.push("Content");
		const content = lines.join("\n");
		// The closing --- is at line 31 (0-indexed), beyond slice(0,30)
		assert.strictEqual(extractDescription(content), null);
	});

	it("empty frontmatter block (--- newline ---) → null", () => {
		const content = "---\n---\nContent";
		assert.strictEqual(extractDescription(content), null);
	});

	it("description with leading space (description:    value) → trimmed to value", () => {
		const content = `---
description:    spaced value
---
Content`;
		assert.strictEqual(extractDescription(content), "spaced value");
	});

	it("description with trailing space → trimmed", () => {
		const content = `---
description: trailing space   
---
Content`;
		assert.strictEqual(extractDescription(content), "trailing space");
	});

	it("description with special chars (colons, commas, quotes) → returned as-is", () => {
		const content = `---
description: "complex: value, with commas" and 'quotes'
---
Content`;
		assert.strictEqual(extractDescription(content), "\"complex: value, with commas\" and 'quotes'");
	});

	it("multi-line description — first line only is returned", () => {
		const content = `---
description: First line
  second line not captured
---
Content`;
		assert.strictEqual(extractDescription(content), "First line");
	});

	it("frontmatter with multiple keys, description not first → still extracted", () => {
		const content = `---
title: Test
version: 2
description: Found in middle
status: active
---
Content`;
		assert.strictEqual(extractDescription(content), "Found in middle");
	});

	it("YAML-like fenced code block not actual frontmatter → null", () => {
		const content = "```yaml\n---\ndescription: not real frontmatter\n---\n```\nContent";
		assert.strictEqual(extractDescription(content), null);
	});

	it("description: with no value after colon → null (regex (.+) requires >=1 char)", () => {
		const content = `---
description:
---
Content`;
		assert.strictEqual(extractDescription(content), null);
	});

	it("CRLF line endings → regex still matches frontmatter", () => {
		const content = "---\r\ndescription: CRLF test\r\n---\r\nContent";
		assert.strictEqual(extractDescription(content), "CRLF test");
	});

	it("description: appears after frontmatter (not in frontmatter) → null", () => {
		const content = `---
title: Test
---
description: This is not in frontmatter`;
		assert.strictEqual(extractDescription(content), null);
	});

	it("frontmatter with only description key → returns the value", () => {
		const content = `---
description: only key
---
Content`;
		assert.strictEqual(extractDescription(content), "only key");
	});
});
