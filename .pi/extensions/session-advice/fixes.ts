/**
 * fixes.ts — Fix suggestions and effort estimates per advice category
 *
 * Pure data, no side effects. Shared by AdvicePipeline and any headless scripts.
 */

export interface FixSuggestion {
	idea: string;
	effort: "Low" | "Medium" | "High";
}

export const FIXES: Record<string, FixSuggestion> = {
	"tool-mismatch": {
		idea: "Implement pre-call validation in harness: intercept bash commands containing grep/rg/cat/head/tail and auto-route to dedicated tool (ripgrep_search/read). Falls back to tool-choice table in AGENTS.md only if harness hook not feasible.",
		effort: "Low",
	},
	"error-not-actioned": {
		idea: "Track last 3 errors per tool in agent runtime. If same tool errors twice consecutively, force strategy switch — block that tool, surface alternative. AGENTS.md rule only if code-level error tracking unavailable.",
		effort: "Medium",
	},
	"identical-call-loop": {
		idea: "Add tool-call dedup cache in harness: before issuing call, compare args against last N calls. Skip or merge duplicates. Detect loops via arg fingerprinting and break them at runtime. AGENTS.md guidance as secondary guard.",
		effort: "High",
	},
	"same-tool-cascade": {
		idea: "Implement tool-level batching in harness queue: when N same-tool calls collected within a turn, merge into single call (e.g., combine bash with `&&`, batch reads by coalescing offsets). AGENTS.md batching guidance only if queue merge not viable.",
		effort: "Medium",
	},
	"redundant-read": {
		idea: "Add read-result cache in harness keyed by (path, offset, limit). If same file re-read within 3 turns, serve cached content automatically. Fallback: add 'read once, use offset to page' to AGENTS.md.",
		effort: "Medium",
	},
	"high-error-rate": {
		idea: "Add pre-flight validation in harness: check file exists before read/edit, verify command exists before bash, validate path before write. Surface errors early via typed error responses. Code validation preferred over AGENTS.md rules.",
		effort: "High",
	},
	"excessive-turns": {
		idea: "Add turn budget tracker in agent loop: if N tool calls produce no file change, pause and prompt user for direction. Code-based budget enforcement; AGENTS.md guidance only if loop hook not available.",
		effort: "Medium",
	},
	"tool-coverage-gap": {
		idea: "Add auto-detection hook: when code files read/edited but structural_search never called in first 3 turns, emit in-context reminder to use AST queries. Code reminder over AGENTS.md mention.",
		effort: "Low",
	},
	"structural-search-underuse": {
		idea: "Add runtime counter: track read/edit calls on code files. If count hits 3 and structural_search never invoked, auto-prompt agent with AST query suggestion. Code trigger over AGENTS.md instruction.",
		effort: "Low",
	},
};

export const DEFAULT_FIX: FixSuggestion = {
	idea: "Implement automated detection hook for this pattern in code. If code hook not feasible, add fallback rule to AGENTS.md.",
	effort: "Medium",
};
