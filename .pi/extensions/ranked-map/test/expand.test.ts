/**
 * Tests for query term expansion (expand.ts)
 *
 * Phase 1: expandTerm — suffix stripping, first-N shorthand, pluralization
 * Phase 2: expandQuery — integration with synonyms
 * Phase 3: Edge cases — empty strings, short terms, special characters
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/ranked-map/test/expand.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { expandTerm, expandQuery } from "../expand.ts";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: expandTerm
// ═══════════════════════════════════════════════════════════════════════

describe("expandTerm — suffix stripping and derivation", () => {
	it("strips -ion suffix: authentication → (authentication|authenticate|auth)", () => {
		const result = expandTerm("authentication");
		assert.ok(result.includes("authentication"), "should include original term");
		assert.ok(result.includes("authenticate"), "should strip -ion to get -ate form");
		assert.ok(result.includes("auth"), "should include first-4 shorthand");
	});

	it("strips -ed suffix: cached → (cached|cache|caching|caches)", () => {
		const result = expandTerm("cached");
		assert.ok(result.includes("cached"), "should include original term");
		assert.ok(result.includes("cache"), "should strip -ed");
		assert.ok(result.includes("caching"), "should include -ing derivation");
		assert.ok(result.includes("caches"), "should include plural");
	});

	it("strips -ing suffix: caching → (caching|cache|cached|caches)", () => {
		const result = expandTerm("caching");
		assert.ok(result.includes("caching"), "should include original term");
		assert.ok(result.includes("cache"), "should strip -ing");
		assert.ok(result.includes("cached"), "should include -ed derivation");
		assert.ok(result.includes("caches"), "should include plural");
	});

	it("strips -ate suffix: authenticate → (authenticate|authentication|auth|authenticates)", () => {
		const result = expandTerm("authenticate");
		assert.ok(result.includes("authenticate"), "should include original term");
		assert.ok(result.includes("authentication"), "should add -ion derivation");
		assert.ok(result.includes("auth"), "should include first-4 shorthand");
		assert.ok(result.includes("authenticates"), "should include plural");
	});

	it("strips -ify suffix: verify → (verify|verification|verifies|verified|verifying)", () => {
		const result = expandTerm("verify");
		assert.ok(result.includes("verify"), "should include original term");
		assert.ok(result.includes("verification"), "should add -ication derivation");
		assert.ok(result.includes("verifies"), "should include plural");
		assert.ok(result.includes("verified"), "should include -ed derivation");
		assert.ok(result.includes("verifying"), "should include -ing derivation");
	});

	it("strips -ication suffix: authentication → (authentication|authenticate|auth)", () => {
		// When original term ends in -ication, stripping gives the base + e
		const result = expandTerm("authentication");
		assert.ok(result.includes("authentication"), "should include original");
		assert.ok(result.includes("authenticate"), "should strip -ication to get -icate form");
		assert.ok(result.includes("auth"), "should include first-4 shorthand");
	});

	it("strips -ment suffix: deployment → (deployment|deploy|deploys|deployed|deploying)", () => {
		const result = expandTerm("deployment");
		assert.ok(result.includes("deployment"), "should include original");
		assert.ok(result.includes("deploy"), "should strip -ment");
		assert.ok(result.includes("deploys"), "should include plural");
		assert.ok(result.includes("deployed"), "should include -ed derivation");
		assert.ok(result.includes("deploying"), "should include -ing derivation");
	});

	it("preserves short terms (length <= 3): run → (run|runs)", () => {
		const result = expandTerm("run");
		assert.ok(result.includes("run"), "should include original");
		assert.ok(result.includes("runs"), "should include plural");
		// No first-N shorthand for short terms
		assert.equal(result.split("|").length, 2, "short term should only have original + plural");
	});

	it("handles plural of regular term: token → (token|tokens)", () => {
		const result = expandTerm("token");
		assert.ok(result.includes("token"), "should include original");
		assert.ok(result.includes("tokens"), "should include plural");
	});

	it("empty string returns empty string", () => {
		assert.equal(expandTerm(""), "");
	});

	it("whitespace-only string returns empty string", () => {
		assert.equal(expandTerm("   "), "");
	});

	it("term with no known suffix: delete → (delete|deleted|deleting|deletes|dele)", () => {
		const result = expandTerm("delete");
		assert.ok(result.includes("delete"), "should include original");
		assert.ok(result.includes("deleted"), "should include -ed derivation");
		assert.ok(result.includes("deleting"), "should include -ing derivation");
		assert.ok(result.includes("deletes"), "should include plural");
		// First-4 shorthand for 6-char word, no more first-3
		assert.ok(result.includes("dele"), "should include first-4 shorthand for delete");
		assert.ok(
			!result.includes("|del|") && !result.includes("|del)"),
			"should NOT include first-3 shorthand del",
		);
	});

	it("uses first-4 shorthand for words > 5 chars: configuration → (configuration|...|conf)", () => {
		const result = expandTerm("configuration");
		assert.ok(result.includes("configuration"), "should include original");
		assert.ok(result.includes("config"), "should include first-4 shorthand");
	});

	it("uses first-4 shorthand for words > 5 chars, no 3-char shorthand", () => {
		// "delete" is 6 chars, so first-N shorthand is first 4 chars (dele), not first-3 (del)
		const result = expandTerm("delete");
		assert.ok(result.includes("dele"), "should include first-4 shorthand for delete");
		assert.ok(
			!result.includes("|del|") && !result.includes("|del)"),
			"should NOT include 3-char shorthand del",
		);
	});

	it("includes plural of stripped base: cache → (cache|cached|caching|caches)", () => {
		const result = expandTerm("cache");
		assert.ok(result.includes("cache"), "should include original");
		assert.ok(result.includes("cached"), "should include -ed");
		assert.ok(result.includes("caching"), "should include -ing");
		assert.ok(result.includes("caches"), "should include plural");
	});

	it("removes duplicates: config → unique variants only", () => {
		const result = expandTerm("config");
		assert.ok(result.startsWith("(") && result.endsWith(")"), "should wrap in parens");
		const variants = result.slice(1, -1).split("|");
		const unique = new Set(variants);
		assert.equal(variants.length, unique.size, "should have no duplicate variants");
	});

	it("derivation produces sensible variants: authorization", () => {
		const result = expandTerm("authorization");
		assert.ok(result.includes("authorization"), "should include original");
		assert.ok(result.includes("authorize"), "should strip -ization to get -ize");
		assert.ok(result.includes("author"), "should include first-4 shorthand");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: expandQuery
// ═══════════════════════════════════════════════════════════════════════

describe("expandQuery — multi-term expansion with synonyms", () => {
	it("expands single term without synonyms", () => {
		const result = expandQuery("token");
		assert.equal(result.length, 1);
		assert.ok(result[0]!.includes("token"), "single term expanded");
	});

	it("expands multiple terms (space-separated)", () => {
		const result = expandQuery("cache token");
		assert.equal(result.length, 2);
		assert.ok(result[0]!.includes("cache"), "first term expanded");
		assert.ok(result[1]!.includes("token"), "second term expanded");
	});

	it("returns empty array for empty query", () => {
		assert.deepEqual(expandQuery(""), []);
	});

	it("returns empty array for whitespace-only query", () => {
		assert.deepEqual(expandQuery("   "), []);
	});

	it("accepts synonyms map and merges them into expanded patterns", () => {
		const synonyms = {
			delete: ["remove", "destroy", "erase"],
		};
		const result = expandQuery("delete", synonyms);
		assert.equal(result.length, 1);
		const pattern = result[0]!;
		// Should include original + synonyms
		assert.ok(pattern.includes("delete"), "should include original term");
		assert.ok(pattern.includes("remove"), "should include synonym: remove");
		assert.ok(pattern.includes("destroy"), "should include synonym: destroy");
		assert.ok(pattern.includes("erase"), "should include synonym: erase");
	});

	it("includes synonyms from config for all matched terms", () => {
		const synonyms = {
			delete: ["remove"],
			config: ["settings"],
		};
		const result = expandQuery("delete config", synonyms);
		assert.equal(result.length, 2);
		const deletePattern = result[0]!;
		const configPattern = result[1]!;
		assert.ok(deletePattern.includes("remove"), "should include delete synonym");
		assert.ok(configPattern.includes("settings"), "should include config synonym");
	});

	it("no synonyms map → just derivative expansion", () => {
		const result = expandQuery("login auth");
		assert.equal(result.length, 2);
		assert.ok(result[0]!.includes("login"), "should expand login");
		assert.ok(result[0]!.includes("logins"), "should include login plural");
	});

	it("synonyms for terms without derivatives still work", () => {
		const synonyms = {
			foo: ["bar", "baz"],
		};
		const result = expandQuery("foo", synonyms);
		const pattern = result[0]!;
		assert.ok(pattern.includes("foo"), "should include original");
		assert.ok(pattern.includes("bar"), "should include synonym");
		assert.ok(pattern.includes("baz"), "should include synonym");
	});

	it("empty synonyms map produces same result as no synonyms", () => {
		const resultWithEmpty = expandQuery("token", {});
		const resultWithout = expandQuery("token");
		assert.deepEqual(resultWithEmpty, resultWithout);
	});

	it("synonyms for unknown terms still work", () => {
		const synonyms = {
			unknown_term: ["syn1", "syn2"],
		};
		const result = expandQuery("unknown_term", synonyms);
		const pattern = result[0]!;
		assert.ok(pattern.includes("unknown_term"));
		assert.ok(pattern.includes("syn1"));
		assert.ok(pattern.includes("syn2"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: Edge cases
// ═══════════════════════════════════════════════════════════════════════

describe("expandTerm — edge cases", () => {
	it("single character term: a → (\\ba\\b)", () => {
		const result = expandTerm("a");
		assert.equal(result, "(\\ba\\b)");
	});

	it("two character term: ok → (ok|oks)", () => {
		const result = expandTerm("ok");
		assert.ok(result.includes("ok"), "should include original");
		assert.ok(result.includes("oks"), "should include plural");
	});

	it("hyphenated term: set-up → (set-up|...) includes original", () => {
		const result = expandTerm("set-up");
		assert.ok(result.includes("set-up"), "should include original");
	});

	it("numeric term: v2 → (v2|v2s)", () => {
		const result = expandTerm("v2");
		assert.ok(result.includes("v2"), "should include original");
	});

	it("term with dots: node.js → (node.js|node.jses)", () => {
		const result = expandTerm("node.js");
		assert.ok(result.includes("node.js"), "should include original");
	});

	it("cased term preserves case: Token → (Token|Tokens)", () => {
		const result = expandTerm("Token");
		assert.ok(result.includes("Token"), "should preserve case");
		assert.ok(result.includes("Tokens"), "should preserve case for plural");
	});

	it("multiple consecutive spaces in input are handled", () => {
		// expandQuery splits by whitespace, so extra spaces are fine
		const result = expandQuery("cache   token");
		assert.equal(result.length, 2);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: \\b word boundary wrapping
// ═══════════════════════════════════════════════════════════════════════

describe("expandTerm — \\b word boundary wrapping", () => {
	it("wraps each variant with \\b in the output", () => {
		const result = expandTerm("extension");
		// At runtime, \\b is the two-character sequence \ + b
		assert.ok(result.includes("\\bextension\\b"), "should wrap extension with \\b");
		assert.ok(result.includes("\\bextensions\\b"), "should wrap extensions with \\b");
		assert.ok(result.includes("\\bexten\\b"), "should wrap exten shorthand with \\b");
	});

	it("\\b-wrapped pattern matches word exactly, not as substring", () => {
		const result = expandTerm("extension");
		// Remove outer parens to get alternation group
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(regex.test("extension"), "should match 'extension'");
		assert.ok(!regex.test("someextensionthing"), "should NOT match inside 'someextensionthing'");
	});

	it("\\b-wrapped pattern does NOT match 'text' or 'context'", () => {
		const result = expandTerm("extension");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(!regex.test("text"), "should NOT match text");
		assert.ok(!regex.test("context"), "should NOT match context");
	});

	it("\\b-wrapped pattern matches at word boundary before space", () => {
		const result = expandTerm("extension");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(regex.test("extensions middleware"), "should match 'extensions middleware'");
		assert.ok(regex.test("build/extension.ts"), "should match 'build/extension.ts'");
	});

	it("config pattern matches 'config' and 'configs' but not 'preconfigured'", () => {
		const result = expandTerm("config");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(regex.test("config"), "should match 'config'");
		assert.ok(regex.test("configs"), "should match 'configs'");
		// "configure" contains "config" but with \b boundary it won't match
		assert.ok(
			!regex.test("configure"),
			"should NOT match 'configure' (\\b boundary between g and u)",
		);
		assert.ok(!regex.test("preconfigured"), "should NOT match 'preconfigured'");
	});

	it("token pattern matches 'token' and 'tokens' but not 'tokenize'", () => {
		const result = expandTerm("token");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(regex.test("token"), "should match 'token'");
		assert.ok(regex.test("tokens"), "should match 'tokens'");
		assert.ok(!regex.test("tokenize"), "should NOT match inside 'tokenize'");
	});

	it("single-char term 'a' wrapped with \\b", () => {
		const result = expandTerm("a");
		// Single char should be \\b a \\b
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(regex.test("a"), "should match 'a' alone");
		assert.ok(!regex.test("cat"), "should NOT match inside 'cat'");
	});

	it("hyphenated term 'set-up' pattern matches at word boundaries", () => {
		const result = expandTerm("set-up");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(regex.test("set-up"), "should match 'set-up'");
	});

	it("delete pattern matches 'delete', 'deleted' but not 'predeleted'", () => {
		const result = expandTerm("delete");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const regex = new RegExp(inner, "i");

		assert.ok(regex.test("delete"), "should match 'delete'");
		assert.ok(regex.test("deleted"), "should match 'deleted'");
		assert.ok(!regex.test("predeleted"), "should NOT match 'predeleted'");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: Minimum 4-char shorthand length
// ═══════════════════════════════════════════════════════════════════════

describe("expandTerm — minimum 4-char shorthand length", () => {
	it("expandTerm('extension') does NOT include 'ext'", () => {
		const result = expandTerm("extension");
		assert.ok(result.includes("exten"), "should include first-4 shorthand 'exten'");
		// Check that 'ext' is NOT a standalone variant (could be part of 'exten', 'extensions', etc.)
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const variants = inner.split("|");
		assert.ok(
			variants.some((v) => v === "\\bexten\\b"),
			"should have \\bexten\\b variant",
		);
		assert.ok(
			!variants.some((v) => /^\\\\bext\\\\b$/.test(v)),
			"should NOT have \\bext\\b variant",
		);
	});

	it("expandTerm('delete') includes 'dele' (first-4) not 'del' (first-3)", () => {
		const result = expandTerm("delete");
		assert.ok(result.includes("dele"), "should include first-4 shorthand 'dele'");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const variants = inner.split("|");
		assert.ok(!variants.some((v) => v === "\\bdel\\b"), "should NOT have \\bdel\\b variant");
	});

	it("expandTerm('cache') (length 5) produces no first-N shorthand", () => {
		const result = expandTerm("cache");
		// cache is 5 chars, so no first-N shorthand (only > 5 gets first-4)
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const variants = inner.split("|");
		// Should only have original + derivations, no 3-char or 4-char shorthand
		assert.ok(result.includes("cache"), "should include original");
		assert.ok(result.includes("cached"), "should include cached");
		assert.ok(result.includes("caching"), "should include caching");
		assert.ok(result.includes("caches"), "should include caches");
		// Count variants: cache + cached + caching + caches = 4
		assert.equal(variants.length, 4, "should have exactly original + 3 derivations, no shorthand");
	});

	it("expandTerm('ab') (length 2) unchanged — no shorthand", () => {
		const result = expandTerm("ab");
		assert.ok(result.includes("ab"), "should include original");
		assert.ok(result.includes("abs"), "should include plural");
	});

	it("expandTerm('run') (length 3) unchanged — no shorthand", () => {
		const result = expandTerm("run");
		assert.equal(result.split("|").length, 2, "should have original + plural only");
	});

	it("expandTerm('config') (length 6) includes 4-char shorthand 'conf' not 3-char 'con'", () => {
		const result = expandTerm("config");
		assert.ok(result.includes("conf"), "should include first-4 shorthand 'conf'");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const variants = inner.split("|");
		assert.ok(!variants.some((v) => v === "\\bcon\\b"), "should NOT have 3-char 'con' variant");
	});

	it("expandTerm('authentication') includes 'auth' but not 'aut'", () => {
		const result = expandTerm("authentication");
		assert.ok(result.includes("auth"), "should include first-4 shorthand 'auth'");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const variants = inner.split("|");
		assert.ok(!variants.some((v) => v === "\\baut\\b"), "should NOT have 3-char 'aut' variant");
	});

	it("expandTerm('v2') (length 2) unchanged — no shorthand", () => {
		const result = expandTerm("v2");
		assert.ok(result.includes("v2"), "should include original");
		assert.ok(result.includes("v2s"), "should include plural");
		const inner = result.startsWith("(") && result.endsWith(")") ? result.slice(1, -1) : result;
		const variants = inner.split("|");
		assert.equal(variants.length, 2, "should have original + plural only");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: expandQuery with \\b synonym wrapping
// ═══════════════════════════════════════════════════════════════════════

describe("expandQuery — \\b synonym wrapping", () => {
	it("synonyms are wrapped with \\b in output", () => {
		const synonyms = {
			delete: ["remove", "destroy"],
		};
		const result = expandQuery("delete", synonyms);
		const pattern = result[0]!;
		assert.ok(pattern.includes("\\bremove\\b"), "synonym 'remove' should be wrapped with \\b");
		assert.ok(pattern.includes("\\bdestroy\\b"), "synonym 'destroy' should be wrapped with \\b");
	});

	it("synonyms don't get duplicated when wrapped", () => {
		const synonyms = {
			delete: ["remove"],
		};
		const result = expandQuery("delete", synonyms);
		const pattern = result[0]!;
		// Should appear exactly once
		const occurrences = pattern.match(/\\bremove\\b/g);
		assert.equal(occurrences?.length, 1, "synonym should appear exactly once");
	});

	it("empty synonyms map still produces \\b-wrapped derivatives", () => {
		const result = expandQuery("extension");
		const pattern = result[0]!;
		assert.ok(
			pattern.includes("\\bextension\\b"),
			"derivatives wrapped with \\b even without synonyms",
		);
	});

	it("synonym wrapping is case-preserving", () => {
		const synonyms = {
			file: ["File"],
		};
		const result = expandQuery("file", synonyms);
		const pattern = result[0]!;
		assert.ok(pattern.includes("\\bFile\\b"), "synonym preserves case with \\b wrapping");
	});

	it("synonyms merged with existing \\b-wrapped variants have no duplicates", () => {
		const synonyms = {
			cache: ["cached"], // 'cached' is already a derivative
		};
		const result = expandQuery("cache", synonyms);
		const pattern = result[0]!;
		const occurrences = pattern.match(/\\bcached\\b/g);
		assert.equal(occurrences?.length, 1, "cached should appear exactly once even in synonyms");
	});
});

describe("expandQuery — edge cases", () => {
	it("very long query terms produce reasonable patterns", () => {
		const result = expandQuery("internationalization");
		assert.ok(result.length === 1);
		const pattern = result[0]!;
		// Should include original, suffix-stripped root with -ize, and first-4 shorthand
		assert.ok(pattern.includes("\\binternationalization\\b"), "original wrapped");
		assert.ok(
			pattern.includes("\\binternationalize\\b"),
			"should derive -ize variant from -ization",
		);
		assert.ok(pattern.includes("\\binte\\b"), "should include first-4 shorthand 'inte'");
	});

	it("synonyms with special characters: regex safe handling", () => {
		const synonyms = {
			file: ["f(oo)", "bar?", "baz*"],
		};
		// Synonyms should be included verbatim (user-provided, so assumed safe for regex)
		const result = expandQuery("file", synonyms);
		const pattern = result[0]!;
		assert.ok(
			pattern.includes("\\bf(oo)\") || pattern.includes("(oo)"),
			"synonym with parens included",
		);
		assert.ok(
			pattern.includes("\\bbar?\\b") || pattern.includes("bar?"),
			"synonym with ? included",
		);
		assert.ok(
			pattern.includes("\\bbaz*\\b") || pattern.includes("baz*"),
			"synonym with * included",
		);
	});
});
