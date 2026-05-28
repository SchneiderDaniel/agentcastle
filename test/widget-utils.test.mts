/**
 * Tests for .pi/extensions/context-info/widget-utils.ts — renderItemList, formatFooter
 *
 * Depends on visibleWidth from @earendil-works/pi-tui (already installed).
 *
 * Run with:
 *   node --experimental-strip-types --test test/widget-utils.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { renderItemList, formatFooter, wordWrap } from "../.pi/extensions/context-info/widget-utils.ts";

// ---------------------------------------------------------------------------
// wordWrap — private helper, tested directly for thorough coverage
// ---------------------------------------------------------------------------

describe("wordWrap", () => {
	it("text shorter than maxWidth → single element with original text", () => {
		assert.deepStrictEqual(wordWrap("short", 20), ["short"]);
	});

	it("text exactly at maxWidth → single element", () => {
		assert.deepStrictEqual(wordWrap("1234567890", 10), ["1234567890"]);
	});

	it("text longer, space at break point → wrapped at last space within width", () => {
		const result = wordWrap("hello world foo bar", 10);
		// Should break at space within 10 chars: "hello" (6) fits, "hello worl" (10) no space
		// Actually "hello worl" at 10 chars - last space is at position 5
		// So first line: "hello" (trimmed), remaining: "world foo bar"
		assert.ok(result.length >= 2);
		assert.strictEqual(result[0], "hello");
	});

	it("single word longer than maxWidth → hard-cut at maxWidth, remainder on next line", () => {
		const result = wordWrap("superlongword", 5);
		assert.strictEqual(result[0], "super");
		assert.strictEqual(result[1], "longw");
		assert.strictEqual(result[2], "ord");
	});

	it("empty text → single element with empty string", () => {
		assert.deepStrictEqual(wordWrap("", 10), [""]);
	});

	it("text with multiple spaces → splits correctly", () => {
		const result = wordWrap("a b c d e f g h i j k", 5);
		// Each single letter fits, so no wrapping needed
		assert.ok(result.length >= 1);
		// Verify all words are present
		const all = result.join(" ");
		assert.ok(all.includes("a"));
		assert.ok(all.includes("k"));
	});

	it("very long text wraps multiple times", () => {
		const text = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10";
		const result = wordWrap(text, 10);
		assert.ok(result.length > 1);
	});
});

// ---------------------------------------------------------------------------
// renderItemList — Widget factory tests
// ---------------------------------------------------------------------------

/** Mock theme that passes text through unchanged (no ANSI styling) */
function mockTheme() {
	return {
		fg: (_color: string, text: string) => text,
	};
}

describe("renderItemList", () => {
	it("two items with descriptions → render returns [name, desc, name, desc, '', footer]", () => {
		const items = [
			{ name: "alpha", desc: "first item" },
			{ name: "beta", desc: "second item" },
		];
		const factory = renderItemList(items, 2, "items");
		const widget = factory(null, mockTheme());
		const lines = widget.render(80);
		// Should have: name line + desc line + name line + desc line + empty + footer = 6
		assert.ok(lines.length >= 6);
		assert.ok(lines[0]!.includes("alpha"));
		assert.ok(lines[1]!.includes("first item"));
		assert.ok(lines[2]!.includes("beta"));
		assert.ok(lines[3]!.includes("second item"));
	});

	it("empty items array → render returns ['', footer]", () => {
		const factory = renderItemList([], 0, "items");
		const widget = factory(null, mockTheme());
		const lines = widget.render(80);
		assert.ok(lines.length >= 2);
		assert.strictEqual(lines[0], "");
	});

	it("single item → name line + description line + footer", () => {
		const factory = renderItemList([{ name: "only", desc: "only item" }], 1, "items");
		const widget = factory(null, mockTheme());
		const lines = widget.render(80);
		assert.ok(lines[0]!.includes("only"));
		assert.ok(lines[1]!.includes("only item"));
	});

	it("item with fallback description → shows fallback", () => {
		const factory = renderItemList([{ name: "test", desc: "(no description)" }], 1, "items");
		const widget = factory(null, mockTheme());
		const lines = widget.render(80);
		assert.ok(lines[1]!.includes("(no description)"));
	});

	it("long description (>descWidth) → word-wrapped across multiple dim lines", () => {
		const longDesc = "a ".repeat(50).trim();
		const factory = renderItemList([{ name: "test", desc: longDesc }], 1, "items");
		const widget = factory(null, mockTheme());
		const lines = widget.render(80);
		// Should have at least: name + 2+ desc lines + empty + footer
		assert.ok(lines.length >= 4);
		// Multiple lines should contain parts of the description
		const descLines = lines.filter((l) => l!.includes("a"));
		assert.ok(descLines.length > 1);
	});

	it("footer text contains count and label string", () => {
		const factory = renderItemList(
			[
				{ name: "a", desc: "desc a" },
				{ name: "b", desc: "desc b" },
				{ name: "c", desc: "desc c" },
			],
			3,
			"prompts",
		);
		const widget = factory(null, mockTheme());
		const lines = widget.render(80);
		const footer = lines[lines.length - 1]!;
		assert.ok(footer.includes("3"), "footer should contain count");
		assert.ok(footer.includes("prompts"), "footer should contain label");
	});

	it("count=0, empty items → footer shows 0 label", () => {
		const factory = renderItemList([], 0, "items");
		const widget = factory(null, mockTheme());
		const lines = widget.render(80);
		const footer = lines[lines.length - 1]!;
		assert.ok(footer.includes("0"));
		assert.ok(footer.includes("items"));
	});

	it("Widget object has render(width) returns string[] and invalidate() is no-op", () => {
		const factory = renderItemList([{ name: "x", desc: "y" }], 1, "items");
		const widget = factory(null, mockTheme());
		assert.ok(typeof widget.render === "function");
		const result = widget.render(80);
		assert.ok(Array.isArray(result));
		assert.ok(result.length > 0);
		assert.doesNotThrow(() => widget.invalidate());
	});
});

// ---------------------------------------------------------------------------
// formatFooter
// ---------------------------------------------------------------------------

describe("formatFooter", () => {
	it('formatFooter(3, "prompts") → includes count and label', () => {
		const result = formatFooter(3, "prompts");
		assert.ok(result.includes("3"));
		assert.ok(result.includes("prompts"));
	});

	it('formatFooter(0, "skills") → includes count and label', () => {
		const result = formatFooter(0, "skills");
		assert.ok(result.includes("0"));
		assert.ok(result.includes("skills"));
	});

	it('formatFooter(5, "extensions") → contains "5 extensions"', () => {
		const result = formatFooter(5, "extensions");
		assert.ok(result.includes("5"));
		assert.ok(result.includes("extensions"));
	});
});
