/**
 * Tests for resolveExtensions() — per-agent extension resolution logic
 * from .pi/extensions/supervisor.ts
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-extensions.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// resolveExtensions — duplicated from supervisor.ts for pure-unit testing
// (supervisor.ts has unresolvable runtime imports in test context)
// ---------------------------------------------------------------------------

function resolveExtensions(extensionsRaw: string | undefined): string[] {
	if (!extensionsRaw || !extensionsRaw.trim()) {
		return ["--no-extensions"];
	}

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	if (extensions.length === 0) {
		return ["--no-extensions"];
	}

	return ["--extensions", extensions.join(",")];
}

// ---------------------------------------------------------------------------
// Tests — AgentFrontmatter type (frontmatter key flows through)
// ---------------------------------------------------------------------------

describe("AgentFrontmatter extensions field", () => {
	it("1.1: parses extensions: 'mcp,browser'", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, ["--extensions", "mcp,browser"]);
	});

	it("1.2: undefined extensions → --no-extensions", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});

	it("1.3: empty string extensions → --no-extensions", () => {
		const result = resolveExtensions("");
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — runAgent() Extension Resolution Logic
// ---------------------------------------------------------------------------

describe("runAgent() extension resolution", () => {
	it("2.1: agent has extensions 'mcp,browser' → --extensions mcp,browser", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, ["--extensions", "mcp,browser"]);
	});

	it("2.2: agent has extensions 'supervisor,mcp' → supervisor filtered out", () => {
		const result = resolveExtensions("supervisor,mcp");
		assert.deepStrictEqual(result, ["--extensions", "mcp"]);
	});

	it("2.3: only supervisor → --no-extensions (nothing remains)", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});

	it("2.4: no extensions field (undefined) → --no-extensions", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});

	it("2.5: empty string → --no-extensions", () => {
		const result = resolveExtensions("");
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});

	it("2.6: whitespace around names → trimmed", () => {
		const result = resolveExtensions("  mcp  ,  browser  ");
		assert.deepStrictEqual(result, ["--extensions", "mcp,browser"]);
	});

	it("2.7: mixed case — passes original case to CLI, supervisor check is case-insensitive", () => {
		const result = resolveExtensions("MCP,Browser,Supervisor");
		assert.deepStrictEqual(result, ["--extensions", "MCP,Browser"]);
	});

	it("2.8: supervisor in middle of list → filtered out, order preserved", () => {
		const result = resolveExtensions("mcp,supervisor,browser");
		assert.deepStrictEqual(result, ["--extensions", "mcp,browser"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — Supervisor Auto-Exclusion (Case-Insensitive)
// ---------------------------------------------------------------------------

describe("supervisor auto-exclusion (case-insensitive)", () => {
	it("3.1: exclude lowercase 'supervisor'", () => {
		const result = resolveExtensions("mcp,supervisor,browser");
		assert.deepStrictEqual(result, ["--extensions", "mcp,browser"]);
	});

	it("3.2: exclude uppercase 'SUPERVISOR'", () => {
		const result = resolveExtensions("mcp,SUPERVISOR,browser");
		assert.deepStrictEqual(result, ["--extensions", "mcp,browser"]);
	});

	it("3.3: exclude mixed-case 'Supervisor'", () => {
		const result = resolveExtensions("Supervisor");
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});

	it("3.4: no supervisor in list → passes through", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, ["--extensions", "mcp,browser"]);
	});

	it("3.5: only supervisor in list → --no-extensions", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — Edge Cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("5.1: only commas → --no-extensions", () => {
		const result = resolveExtensions(",,,,");
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});

	it("5.2: 50+ extensions → handles long lists", () => {
		const extensions = Array.from({ length: 55 }, (_, i) => `ext-${i}`).join(",");
		const result = resolveExtensions(extensions);
		assert.strictEqual(result[0], "--extensions");
		assert.strictEqual(result[1]!.split(",").length, 55);
	});

	it("5.3: extension names with hyphens or dots → pass through", () => {
		const result = resolveExtensions("my-custom-tool,my.tool");
		assert.deepStrictEqual(result, ["--extensions", "my-custom-tool,my.tool"]);
	});

	it("5.4: whitespace-only string → --no-extensions", () => {
		const result = resolveExtensions("   ");
		assert.deepStrictEqual(result, ["--no-extensions"]);
	});

	it("caveman,crawl4ai (PS requirement)", () => {
		const result = resolveExtensions("caveman,crawl4ai");
		assert.deepStrictEqual(result, ["--extensions", "caveman,crawl4ai"]);
	});

	it("supervisor with caveman → supervisor excluded", () => {
		const result = resolveExtensions("supervisor,caveman,crawl4ai");
		assert.deepStrictEqual(result, ["--extensions", "caveman,crawl4ai"]);
	});

	it("single extension (not supervisor)", () => {
		const result = resolveExtensions("mcp");
		assert.deepStrictEqual(result, ["--extensions", "mcp"]);
	});
});

// ---------------------------------------------------------------------------
// Integration test — verify existing agent .md files parse extensions field
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

function parseAgentFileExtensions(filePath: string): string | undefined {
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return undefined;
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^extensions\s*:\s*(.+)$/);
		if (kv) {
			let val = kv[1]!.trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			return val;
		}
	}
	return undefined;
}

describe("production agent files — extensions field", () => {
	const agents = [
		{ name: "architect", expected: "caveman,crawl4ai" },
		{ name: "test-designer", expected: "caveman,crawl4ai" },
		{ name: "developer", expected: "caveman,crawl4ai" },
		{ name: "auditor", expected: "caveman,crawl4ai" },
	];

	for (const agent of agents) {
		it(`${agent.name}.md has extensions: "caveman,crawl4ai"`, () => {
			const val = parseAgentFileExtensions(`.pi/agents/${agent.name}.md`);
			assert.strictEqual(val, agent.expected);
		});
	}

	it("supervisor.md does NOT exist (supervisor never loads in subagents)", () => {
		let exists = false;
		try {
			readFileSync(".pi/agents/supervisor.md");
			exists = true;
		} catch { /* expected */ }
		assert.strictEqual(exists, false);
	});
});

describe("production agents resolve without supervisor in output", () => {
	for (const name of ["architect", "test-designer", "developer", "auditor"]) {
		it(`${name} extensions resolve without supervisor`, () => {
			const val = parseAgentFileExtensions(`.pi/agents/${name}.md`);
			const result = resolveExtensions(val);
			// Must not contain --no-extensions (should have --extensions)
			assert.notStrictEqual(result[0], "--no-extensions");
			// Must not contain "supervisor" in the extension list
			const extList = result[1] ?? "";
			assert.ok(!extList.toLowerCase().includes("supervisor"));
		});
	}
});
