// ─── Tests: shared-prompts.ts — Tool discipline prompts ────────────
// Pure function tests — no infra needed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	TOOL_DISCIPLINE_SNIPPET,
	buildAgentSystemPrompt,
	DEDUPLICATION_SCAN_INSTRUCTION,
	README_CHECK_INSTRUCTION,
} from "../config/shared-prompts.ts";

// ─── Tests: TOOL_DISCIPLINE_SNIPPET ───────────────────────────────

describe("TOOL_DISCIPLINE_SNIPPET", () => {
	it("contains the read discipline rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("read(path, offset?, limit?)"));
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("NOT `bash cat`"));
	});

	it("contains the search discipline rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("ripgrep_search"));
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("NOT `bash | grep`"));
	});

	it("contains the error rethink rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("Error means rethink"));
	});

	it("contains the batch same-tool rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("Batch same-tool calls"));
	});

	it("contains the read-once rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("Read once"));
	});

	it("contains the find symbols rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("ranked_map"));
	});

	it("contains the edit files rule", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("edit"));
		assert.ok(TOOL_DISCIPLINE_SNIPPET.includes("bash sed"));
	});

	it("starts with a tool discipline header", () => {
		assert.ok(TOOL_DISCIPLINE_SNIPPET.startsWith("🛠 Tool Discipline"));
	});
});

// ─── Tests: buildAgentSystemPrompt ────────────────────────────────

describe("buildAgentSystemPrompt", () => {
	it("prepends tool discipline to existing system prompt", () => {
		const result = buildAgentSystemPrompt(
			"## Your Role\nYou are the Developer agent.",
			"developer",
		);
		assert.ok(result.startsWith("🛠 Tool Discipline"));
		assert.ok(result.includes("## Your Role\nYou are the Developer agent."));
	});

	it("includes developer-specific overrides for developer agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "developer");
		assert.ok(result.includes("structural_search for code"));
	});

	it("includes auditor-specific overrides for auditor agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "auditor");
		assert.ok(result.includes("git diff"));
	});

	it("includes researcher-specific overrides for researcher agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "researcher");
		assert.ok(result.includes("web_crawl"));
	});

	it("includes architect-specific overrides for architect agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "architect");
		assert.ok(result.includes("structural_search"));
	});

	it("includes test-designer-specific overrides for test-designer agent", () => {
		const result = buildAgentSystemPrompt("Some prompt", "test-designer");
		assert.ok(result.includes("structural_search"));
	});

	it("handles empty base prompt", () => {
		const result = buildAgentSystemPrompt("", "developer");
		assert.ok(result.startsWith("🛠 Tool Discipline"));
	});
});

// ─── Tests: DEDUPLICATION_SCAN_INSTRUCTION ────────────────────────

describe("DEDUPLICATION_SCAN_INSTRUCTION", () => {
	it("references the `## Research Findings` marker", () => {
		assert.ok(DEDUPLICATION_SCAN_INSTRUCTION.includes("## Research Findings"));
	});

	it("indicates skip behavior", () => {
		assert.ok(DEDUPLICATION_SCAN_INSTRUCTION.toLowerCase().includes("skip"));
	});
});

// ─── Tests: README_CHECK_INSTRUCTION ─────────────────────────────

describe("README_CHECK_INSTRUCTION", () => {
	it("references README.md", () => {
		assert.ok(README_CHECK_INSTRUCTION.includes("README.md"));
	});

	it("references git diff", () => {
		assert.ok(README_CHECK_INSTRUCTION.includes("git diff"));
	});
});
