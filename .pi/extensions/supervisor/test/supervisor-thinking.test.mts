/**
 * Tests for thinking level field in agent markdown frontmatter.
 *
 * Tests:
 * - agent-loader.ts: validate thinking values, parse from frontmatter
 * - agent-runner.ts: build args with --thinking flag
 * - Integration: verify each agent .md file has correct thinking field
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/supervisor/test/supervisor-thinking.test.mts
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helper: duplicate parseAgentFile validation logic for pure-unit testing
// (agent-loader.ts has fs dependency for real parsing)
// ---------------------------------------------------------------------------

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Parse frontmatter from raw .md content (same logic as agent-loader.ts) */
function parseFrontmatter(content: string): Record<string, string> {
	const config: Record<string, string> = {};
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return config;

	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
		if (kv) {
			let val = kv[2]!.trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			config[kv[1]!] = val;
		}
	}
	return config;
}

/** Validate thinking level — should be called after frontmatter parse */
function validateThinking(thinking: unknown): void {
	if (thinking === undefined || thinking === null) return;
	const val = String(thinking).trim();
	if (!val) return; // empty string treated as missing
	if (!VALID_THINKING_LEVELS.includes(val)) {
		throw new Error(`Invalid thinking level "${val}". Valid: ${VALID_THINKING_LEVELS.join(", ")}`);
	}
}

/** Build CLI args — duplicated runAgent logic for thinking flag */
function buildArgs(opts: { thinking?: string }): string[] {
	const args: string[] = ["-p", "--mode", "json", "task"];
	if (opts.thinking && opts.thinking.trim()) {
		args.push("--thinking", opts.thinking.trim());
	}
	return args;
}

// ---------------------------------------------------------------------------
// Fixtures — minimal agent markdown content
// ---------------------------------------------------------------------------

const agentWithThinking = `---
name: test-agent
model: opencode-go/deepseek-v4-flash
thinking: medium
---
System prompt here
`;

const agentWithoutThinking = `---
name: test-agent
model: opencode-go/deepseek-v4-flash
---
System prompt here
`;

const agentWithEmptyThinking = `---
name: test-agent
thinking: ""
---
System prompt here
`;

const agentWithInvalidThinking = `---
name: test-agent
thinking: turbo
---
System prompt here
`;

// ---------------------------------------------------------------------------
// Tests: AgentFrontmatter type supports thinking field (parsing)
// ---------------------------------------------------------------------------

describe("AgentFrontmatter thinking field — parsing", () => {
	it("1.1: parses thinking: medium from frontmatter", () => {
		const config = parseFrontmatter(agentWithThinking);
		assert.strictEqual(config.name, "test-agent");
		assert.strictEqual(config.thinking, "medium");
	});

	it("1.2: missing thinking field → undefined", () => {
		const config = parseFrontmatter(agentWithoutThinking);
		assert.strictEqual(config.name, "test-agent");
		assert.strictEqual(config.thinking, undefined);
	});

	it("1.3: empty thinking string → empty string (treated as missing later)", () => {
		const config = parseFrontmatter(agentWithEmptyThinking);
		assert.strictEqual(config.thinking, "");
	});

	it("1.4: thinking with different valid values", () => {
		const configHigh = parseFrontmatter(`---
name: a
thinking: high
---
p`);
		assert.strictEqual(configHigh.thinking, "high");

		const configOff = parseFrontmatter(`---
name: b
thinking: off
---
p`);
		assert.strictEqual(configOff.thinking, "off");

		const configXhigh = parseFrontmatter(`---
name: c
thinking: xhigh
---
p`);
		assert.strictEqual(configXhigh.thinking, "xhigh");
	});
});

// ---------------------------------------------------------------------------
// Tests: thinking validation
// ---------------------------------------------------------------------------

describe("thinking level validation", () => {
	it("2.1: undefined thinking → no error", () => {
		assert.doesNotThrow(() => validateThinking(undefined));
	});

	it("2.2: null thinking → no error", () => {
		assert.doesNotThrow(() => validateThinking(null));
	});

	it("2.3: empty string thinking → no error (treated as missing)", () => {
		assert.doesNotThrow(() => validateThinking(""));
	});

	it("2.4: whitespace-only string thinking → no error (treated as missing after trim)", () => {
		assert.doesNotThrow(() => validateThinking("   "));
	});

	it("2.5: 'off' is valid", () => {
		assert.doesNotThrow(() => validateThinking("off"));
	});

	it("2.6: 'minimal' is valid", () => {
		assert.doesNotThrow(() => validateThinking("minimal"));
	});

	it("2.7: 'low' is valid", () => {
		assert.doesNotThrow(() => validateThinking("low"));
	});

	it("2.8: 'medium' is valid", () => {
		assert.doesNotThrow(() => validateThinking("medium"));
	});

	it("2.9: 'high' is valid", () => {
		assert.doesNotThrow(() => validateThinking("high"));
	});

	it("2.10: 'xhigh' is valid", () => {
		assert.doesNotThrow(() => validateThinking("xhigh"));
	});

	it("2.11: 'turbo' throws error listing valid levels", () => {
		assert.throws(
			() => validateThinking("turbo"),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.ok((err as Error).message.includes('Invalid thinking level "turbo"'));
				assert.ok((err as Error).message.includes("off, minimal, low, medium, high, xhigh"));
				return true;
			},
		);
	});

	it("2.12: 'none' throws error", () => {
		assert.throws(
			() => validateThinking("none"),
			(err: unknown) => {
				assert.ok((err as Error).message.includes("off, minimal, low, medium, high, xhigh"));
				return true;
			},
		);
	});

	it("2.13: 'HIGH' (uppercase) throws error (case-sensitive)", () => {
		assert.throws(() => validateThinking("HIGH"));
	});

	it("2.14: invalid thinking parsed from frontmatter should be rejectable", () => {
		const config = parseFrontmatter(agentWithInvalidThinking);
		assert.strictEqual(config.thinking, "turbo");
		assert.throws(() => validateThinking(config.thinking));
	});
});

// ---------------------------------------------------------------------------
// Tests: agent-runner.ts — --thinking flag construction
// ---------------------------------------------------------------------------

describe("runAgent() thinking flag construction", () => {
	it("3.1: thinking present → --thinking <value> in args", () => {
		const args = buildArgs({ thinking: "high" });
		assert.ok(args.includes("--thinking"));
		assert.ok(args.includes("high"));
	});

	it("3.2: thinking absent → no --thinking flag", () => {
		const args = buildArgs({});
		assert.ok(!args.includes("--thinking"));
	});

	it("3.3: thinking empty string → no --thinking flag", () => {
		const args = buildArgs({ thinking: "" });
		assert.ok(!args.includes("--thinking"));
	});

	it("3.4: thinking whitespace → no --thinking flag (treated as non-present)", () => {
		const args = buildArgs({ thinking: "   " });
		assert.ok(!args.includes("--thinking"));
	});

	it("3.5: thinking medium → --thinking medium", () => {
		const args = buildArgs({ thinking: "medium" });
		const idx = args.indexOf("--thinking");
		assert.ok(idx >= 0);
		assert.strictEqual(args[idx + 1], "medium");
	});

	it("3.6: thinking low → --thinking low", () => {
		const args = buildArgs({ thinking: "low" });
		const idx = args.indexOf("--thinking");
		assert.ok(idx >= 0);
		assert.strictEqual(args[idx + 1], "low");
	});

	it("3.7: thinking off → --thinking off", () => {
		const args = buildArgs({ thinking: "off" });
		const idx = args.indexOf("--thinking");
		assert.ok(idx >= 0);
		assert.strictEqual(args[idx + 1], "off");
	});

	it("3.8: thinking xhigh → --thinking xhigh", () => {
		const args = buildArgs({ thinking: "xhigh" });
		const idx = args.indexOf("--thinking");
		assert.ok(idx >= 0);
		assert.strictEqual(args[idx + 1], "xhigh");
	});

	it("3.9: model present with thinking — both flags appear", () => {
		// Simulate full runAgent arg building with model + thinking
		const model = "opencode-go/deepseek-v4-flash";
		const args = ["-p", "--mode", "json", "task"];
		if (model) args.push("--model", model);
		if ("high") args.push("--thinking", "high");

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("--thinking"));
		assert.ok(args.includes("opencode-go/deepseek-v4-flash"));
		assert.ok(args.includes("high"));
	});

	it("3.10: model present but no thinking → only --model flag", () => {
		const model = "opencode-go/deepseek-v4-flash";
		const args = ["-p", "--mode", "json", "task"];
		if (model) args.push("--model", model);

		assert.ok(args.includes("--model"));
		assert.ok(!args.includes("--thinking"));
	});
});

// ---------------------------------------------------------------------------
// Integration tests — parse each agent .md file and verify thinking field
// ---------------------------------------------------------------------------

function parseAgentFileThinking(filePath: string): string | undefined {
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return undefined;
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^thinking\s*:\s*(.+)$/);
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

describe("production agent files — thinking field", () => {
	const agents = [
		{ name: "architect", expected: "high" },
		{ name: "researcher", expected: "medium" },
		{ name: "developer", expected: "low" },
		{ name: "test-designer", expected: "medium" },
		{ name: "auditor", expected: "medium" },
	];

	for (const agent of agents) {
		it(`${agent.name}.md has thinking: "${agent.expected}"`, () => {
			const val = parseAgentFileThinking(`.pi/agents/${agent.name}.md`);
			assert.strictEqual(val, agent.expected);
		});
	}
});

describe("production agent files — thinking validation passes for all", () => {
	for (const agentName of ["architect", "researcher", "developer", "test-designer", "auditor"]) {
		it(`${agentName}.md thinking passes validation`, () => {
			const val = parseAgentFileThinking(`.pi/agents/${agentName}.md`);
			if (val !== undefined) {
				assert.doesNotThrow(() => validateThinking(val));
			}
		});
	}
});
