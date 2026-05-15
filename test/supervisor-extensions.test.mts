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

const CONTEXT_INFO_EXTENSION = ".pi/extensions/context-info.ts";

function resolveExtensions(extensionsRaw: string | undefined): string[] {
	if (!extensionsRaw || !extensionsRaw.trim()) {
		return ["--extension", CONTEXT_INFO_EXTENSION];
	}

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	const result: string[] = [];
	for (const ext of extensions) {
		result.push("--extension", `.pi/extensions/${ext}.ts`);
	}

	// Auto-inject context-info (deduplicated)
	const hasContextInfo = result.some(
		(r) => r === CONTEXT_INFO_EXTENSION || r.endsWith("/context-info.ts"),
	);
	if (!hasContextInfo) {
		result.push("--extension", CONTEXT_INFO_EXTENSION);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Tests — AgentFrontmatter type (frontmatter key flows through)
// ---------------------------------------------------------------------------

describe("AgentFrontmatter extensions field", () => {
	it("1.1: parses extensions: 'mcp,browser' + context-info", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("1.2: undefined extensions → includes context-info", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("1.3: empty string extensions → includes context-info", () => {
		const result = resolveExtensions("");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — runAgent() Extension Resolution Logic
// ---------------------------------------------------------------------------

describe("runAgent() extension resolution", () => {
	it("2.1: agent has extensions 'mcp,browser' → --extension per path + context-info", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.2: agent has extensions 'supervisor,mcp' → supervisor filtered out, context-info added", () => {
		const result = resolveExtensions("supervisor,mcp");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.3: only supervisor → context-info only (nothing else remains)", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.4: no extensions field (undefined) → context-info", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.5: empty string → context-info", () => {
		const result = resolveExtensions("");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.6: whitespace around names → trimmed + context-info", () => {
		const result = resolveExtensions("  mcp  ,  browser  ");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.7: mixed case — passes original case to CLI, supervisor check is case-insensitive, context-info added", () => {
		const result = resolveExtensions("MCP,Browser,Supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/MCP.ts", "--extension", ".pi/extensions/Browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("2.8: supervisor in middle of list → filtered out, context-info added", () => {
		const result = resolveExtensions("mcp,supervisor,browser");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — Supervisor Auto-Exclusion (Case-Insensitive)
// ---------------------------------------------------------------------------

describe("supervisor auto-exclusion (case-insensitive)", () => {
	it("3.1: exclude lowercase 'supervisor', context-info added", () => {
		const result = resolveExtensions("mcp,supervisor,browser");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("3.2: exclude uppercase 'SUPERVISOR', context-info added", () => {
		const result = resolveExtensions("mcp,SUPERVISOR,browser");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("3.3: exclude mixed-case 'Supervisor' → context-info only", () => {
		const result = resolveExtensions("Supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("3.4: no supervisor in list → passes through, context-info added", () => {
		const result = resolveExtensions("mcp,browser");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/browser.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("3.5: only supervisor in list → context-info only", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});
});

// ---------------------------------------------------------------------------
// Tests — Edge Cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("5.1: only commas → context-info", () => {
		const result = resolveExtensions(",,,,");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("5.2: 55 extensions → 112 args (55 pairs + context-info)", () => {
		const extensions = Array.from({ length: 55 }, (_, i) => `ext-${i}`).join(",");
		const result = resolveExtensions(extensions);
		assert.strictEqual(result.length, 112);
		assert.strictEqual(result[0], "--extension");
		assert.strictEqual(result[1], ".pi/extensions/ext-0.ts");
		assert.strictEqual(result[110], "--extension");
		assert.strictEqual(result[111], ".pi/extensions/context-info.ts");
	});

	it("5.3: extension names with hyphens or dots → pass through + context-info", () => {
		const result = resolveExtensions("my-custom-tool,my.tool");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/my-custom-tool.ts", "--extension", ".pi/extensions/my.tool.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("5.4: whitespace-only string → context-info", () => {
		const result = resolveExtensions("   ");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("caveman,crawl4ai (PS requirement) + context-info", () => {
		const result = resolveExtensions("caveman,crawl4ai");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/caveman.ts", "--extension", ".pi/extensions/crawl4ai.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("supervisor with caveman → supervisor excluded, context-info added", () => {
		const result = resolveExtensions("supervisor,caveman,crawl4ai");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/caveman.ts", "--extension", ".pi/extensions/crawl4ai.ts", "--extension", ".pi/extensions/context-info.ts"]);
	});

	it("single extension (not supervisor) + context-info", () => {
		const result = resolveExtensions("mcp");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/mcp.ts", "--extension", ".pi/extensions/context-info.ts"]);
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
		{ name: "architect", expected: "caveman,crawl4ai,piignore" },
		{ name: "test-designer", expected: "caveman,crawl4ai,piignore" },
		{ name: "developer", expected: "caveman,crawl4ai,piignore" },
		{ name: "auditor", expected: "caveman,crawl4ai,piignore" },
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
			// Must not contain --no-extensions
			assert.notStrictEqual(result[0], "--no-extensions");
			// Must not contain "supervisor" in any path
			assert.ok(!result.some(r => r.toLowerCase().includes("supervisor")));
		});
	}
});

// ---------------------------------------------------------------------------
// Tests — Context-Info Extension Auto-Injection (Phase 3a)
// ---------------------------------------------------------------------------

describe("context-info extension auto-injection", () => {
	it("P3.1: no extensions → includes context-info path", () => {
		const result = resolveExtensions(undefined);
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});

	it("P3.2: other extensions → appends context-info", () => {
		const result = resolveExtensions("caveman,crawl4ai");
		assert.ok(result.includes("--extension"));
		assert.ok(result.includes(".pi/extensions/context-info.ts"));
		// context-info should be last
		assert.strictEqual(result[result.length - 1], ".pi/extensions/context-info.ts");
	});

	it("P3.3: context-info already in list → no duplication", () => {
		const result = resolveExtensions("caveman,context-info");
		const count = result.filter(r => r === ".pi/extensions/context-info.ts").length;
		assert.strictEqual(count, 1, "context-info should appear exactly once");
	});

	it("P3.4: supervisor filtered out, context-info auto-added", () => {
		const result = resolveExtensions("supervisor");
		assert.deepStrictEqual(result, ["--extension", ".pi/extensions/context-info.ts"]);
	});
});
