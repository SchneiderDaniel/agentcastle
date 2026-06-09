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

	it("term with no known suffix: delete → (delete|deleted|deleting|deletes|del)", () => {
		const result = expandTerm("delete");
		assert.ok(result.includes("delete"), "should include original");
		assert.ok(result.includes("deleted"), "should include -ed derivation");
		assert.ok(result.includes("deleting"), "should include -ing derivation");
		assert.ok(result.includes("deletes"), "should include plural");
		// First-3 shorthand for 6-char word starting with 'del'
		assert.ok(result.includes("del"), "should include first-3 shorthand for delete");
	});

	it("uses first-4 shorthand for words > 5 chars: configuration → (configuration|...|conf)", () => {
		const result = expandTerm("configuration");
		assert.ok(result.includes("configuration"), "should include original");
		assert.ok(result.includes("config"), "should include first-4 shorthand");
	});

	it("uses first-3 shorthand for words ending with common prefix: del → delete derivatives", () => {
		// "delete" is 6 chars, so first-N shorthand is first 4 chars
		const result = expandTerm("delete");
		assert.ok(result.includes("del"), "should include shorthand for delete");
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
	it("single character term: a → (a)", () => {
		const result = expandTerm("a");
		assert.equal(result, "(a)");
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

describe("expandQuery — edge cases", () => {
	it("very long query terms produce reasonable patterns", () => {
		const result = expandQuery("internationalization");
		assert.ok(result.length === 1);
		const pattern = result[0]!;
		// Should include original and shorter variants
		assert.ok(pattern.includes("internationalization"), "original");
		assert.ok(pattern.includes("internationaliz"), "first-4 chars prefix base");
	});

	it("synonyms with special characters: regex safe handling", () => {
		const synonyms = {
			file: ["f(oo)", "bar?", "baz*"],
		};
		// Synonyms should be included verbatim (user-provided, so assumed safe for regex)
		const result = expandQuery("file", synonyms);
		const pattern = result[0]!;
		assert.ok(pattern.includes("f(oo)"), "synonym with parens included");
		assert.ok(pattern.includes("bar?"), "synonym with ? included");
		assert.ok(pattern.includes("baz*"), "synonym with * included");
	});
});
