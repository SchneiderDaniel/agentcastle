/**
 * Tests for supervisor message_update handling and widget rendering.
 *
 * Covers:
 * - Phase 1: message_update handler + state (thinking/text deltas)
 * - Phase 2: buildWidgetLines (12-line cap, live thinking, stats footer)
 * - Phase 3: working message phase detection
 * - Phase 4: message renderer thinking output (expanded/compact)
 * - Phase 5: edge cases (empty deltas, rapid bursts, non-JSON)
 *
 * Pure functions extracted from supervisor.ts for isolated unit testing.
 *
 * Run with:
 *   node --experimental-strip-types --test test/supervisor-stream-activity.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";

// ---------------------------------------------------------------------------
// Replicated pure functions and types from supervisor.ts
// (matches .pi/extensions/supervisor.ts implementation exactly)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const sec = Math.round(ms / 1_000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remainSec = sec % 60;
	return `${min}m ${remainSec}s`;
}

// ─── AgentRunState: mutable state during agent execution ────────────

type AgentPhase = "idle" | "thinking" | "tool" | "text";

interface AgentRunState {
	currentTool?: string;
	currentToolArgs?: string;
	toolCount: number;
	tokenCount: number;
	fullLog: string[];
	liveThinking: string;
	liveText: string;
	textOutputLines: string[];
	thinkingOutputLines: string[];
	lastToolName?: string;
	phase: AgentPhase;
	startedAt: number;
	contextTokens?: number;
	contextWindow?: number;
	contextInfoReceived: boolean;
}

const MAX_FULL_LOG = 200;
const WIDGET_LINES = 12;
const MAX_LIVE_THINKING = 500;

function pushLog(state: AgentRunState, entry: string): void {
	state.fullLog.push(entry);
	if (state.fullLog.length > MAX_FULL_LOG) state.fullLog.shift();
}

// ─── Phase priority ────────────────────────────────────────────────

/** Numeric priority for phase ordering. Higher = more important. */
function phasePriority(phase: AgentPhase): number {
	switch (phase) {
		case "tool": return 3;
		case "thinking": return 2;
		case "text": return 1;
		case "idle": return 0;
	}
}

// ─── Phase detection ────────────────────────────────────────────────

/** Determine phase from a message_update event. Priority: tool > thinking > text > idle */
function getPhaseFromUpdate(ev: any): AgentPhase {
	if (!ev || !ev.type) return "idle";

	if (ev.type === "tool_execution_start") return "tool";
	if (ev.type === "tool_execution_end") return "idle";
	if (ev.type === "message_update") {
		const delta = ev.delta;
		if (!delta) return "idle";
		if (delta.type === "thinking_delta" && delta.thinking_delta) return "thinking";
		if (delta.type === "thinking_start") return "thinking";
		if (delta.type === "text_delta" && delta.text_delta) return "text";
		if (delta.type === "text_start") return "text";
		if (delta.type === "thinking_end") return "idle";
		if (delta.type === "text_end") return "idle";
	}
	if (ev.type === "message_end") return "idle";

	return "idle";
}

// ─── processJsonLine — pure state mutation ──────────────────────────

interface ProcessResult {
	/** true if widget should be flushed */
	flush: boolean;
	/** true if working message should be updated */
	workingChange: boolean;
}

function processJsonLine(
	line: string,
	state: AgentRunState,
): ProcessResult {
	if (!line.trim()) return { flush: false, workingChange: false };
	try {
		const ev = JSON.parse(line);
		switch (ev.type) {
			// ── context_info ──────────────────────────────────
			case "context_info": {
				const tokens = ev.contextTokens;
				const window = ev.contextWindow;
				if (typeof tokens === "number" && typeof window === "number" && window > 0) {
					state.contextTokens = tokens;
					state.contextWindow = window;
					state.contextInfoReceived = true;
					pushLog(state, `📊 Context: ${formatTokens(tokens)}/${formatTokens(window)} (initial)`);
					return { flush: true, workingChange: false };
				}
				return { flush: false, workingChange: false };
			}

			// ── tool_execution_start ─────────────────────────
			case "tool_execution_start": {
				const prevPhase = state.phase;
				state.currentTool = ev.toolName || "tool";
				state.currentToolArgs = ev.args
					? JSON.stringify(ev.args).slice(0, 200)
					: undefined;
				state.lastToolName = ev.toolName;
				state.phase = "tool";
				const logArgs = ev.args
					? JSON.stringify(ev.args).slice(0, 200)
					: "";
				pushLog(state, `🔧 ${ev.toolName}${logArgs ? ` ${logArgs}` : ""}`);
				return {
					flush: true,
					workingChange: prevPhase !== "tool",
				};
			}

			// ── tool_execution_end ───────────────────────────
			case "tool_execution_end": {
				state.toolCount++;
				state.currentTool = undefined;
				state.currentToolArgs = undefined;
				state.phase = "idle";
				pushLog(state, `${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
				return { flush: true, workingChange: true };
			}

			// ── message_update (streaming events) ────────────
			case "message_update": {
				const delta = ev.delta;
				if (!delta) return { flush: false, workingChange: false };

				const prevPhase = state.phase;
				const newPhase = getPhaseFromUpdate(ev);
				// Never downgrade: tool > thinking > text
				if (newPhase !== "idle" && phasePriority(newPhase) >= phasePriority(state.phase)) {
					state.phase = newPhase;
				}

				switch (delta.type) {
					case "thinking_delta": {
						const td = delta.thinking_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveThinking += td;
							// Prevent unbounded buffer growth
							if (state.liveThinking.length > MAX_LIVE_THINKING * 2) {
								state.liveThinking = state.liveThinking.slice(-MAX_LIVE_THINKING);
							}
							return {
								flush: true,
								workingChange: prevPhase !== "thinking",
							};
						}
						return { flush: false, workingChange: false };
					}

					case "text_delta": {
						const td = delta.text_delta;
						if (typeof td === "string" && td.length > 0) {
							state.liveText += td;
							if (state.liveText.length > 10_000) {
								state.liveText = state.liveText.slice(-8_000);
							}
							return {
								flush: true,
								workingChange: prevPhase !== "text",
							};
						}
						return { flush: false, workingChange: false };
					}

					case "thinking_end": {
						if (state.liveThinking.trim()) {
							state.thinkingOutputLines.push(state.liveThinking.trim());
							for (const t of state.liveThinking.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, `💭 ${trimmed.slice(0, 200)}`);
							}
						}
						state.liveThinking = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}

					case "text_end": {
						if (state.liveText.trim()) {
							state.textOutputLines.push(state.liveText.trim());
							for (const t of state.liveText.split("\n")) {
								const trimmed = t.trim();
								if (trimmed) pushLog(state, trimmed);
							}
						}
						// Capture usage from text_end or parent message
						if (ev.usage) {
							state.tokenCount =
								ev.usage.totalTokens || ev.usage.input + ev.usage.output || state.tokenCount;
						}
						state.liveText = "";
						state.phase = "idle";
						return { flush: true, workingChange: true };
					}

					default:
						return { flush: false, workingChange: false };
				}
			}

			// ── message_end ──────────────────────────────────
			case "message_end": {
				const msg = ev.message;
				if (!msg) return { flush: false, workingChange: false };

				if (msg.role === "assistant") {
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "thinking" && block.thinking) {
								const thinkingText = typeof block.thinking === "string"
									? block.thinking
									: JSON.stringify(block.thinking).slice(0, 500);
								for (const t of thinkingText.split("\n")) {
									if (t.trim()) pushLog(state, `💭 ${t.slice(0, 200)}`);
								}
							}
						}
					}
					const text = extractTextFromContent(msg.content);
					if (text && text.trim()) {
						state.textOutputLines.push(text.trim());
						for (const t of text.split("\n")) {
							if (t.trim()) pushLog(state, t);
						}
					}
					if (msg.usage) {
						state.tokenCount =
							msg.usage.totalTokens || msg.usage.input + msg.usage.output;
					}
				} else if (msg.role === "toolResult") {
					const resultText = extractTextFromContent(msg.content);
					const label = msg.toolName || state.lastToolName || "tool";
					if (resultText && resultText.trim()) {
						const lines = resultText.split("\n");
						pushLog(state, `📋 ${label}: ${lines[0]?.slice(0, 300) || "(no output)"}`);
						for (let i = 1; i < Math.min(lines.length, 6); i++) {
							if (lines[i].trim())
								pushLog(state, `   ${lines[i].slice(0, 200)}`);
						}
					} else {
						pushLog(state, `📋 ${label}: (no output)`);
					}
					state.lastToolName = undefined;
				}
				state.phase = "idle";
				return { flush: true, workingChange: true };
			}

			default:
				return { flush: false, workingChange: false };
		}
	} catch {
		return { flush: false, workingChange: false };
	}
}

// ─── buildWidgetLines — pure state → string[] ───────────────────────

function buildWidgetLines(
	state: AgentRunState,
	agentName: string,
): string[] {
	const lines: string[] = [];
	const now = Date.now();

	// Header
	lines.push(`⚙ ${agentName}`);

	// Context line
	if (state.contextInfoReceived && state.contextTokens !== undefined && state.contextWindow !== undefined) {
		lines.push(`  Context: ${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`);
	} else {
		lines.push("  Context: computing...");
	}

	// Live thinking (accent line, ... prefix while incomplete)
	if (state.phase === "thinking" && state.liveThinking.trim()) {
		const live = state.liveThinking.slice(-MAX_LIVE_THINKING);
		const condensed = live.replace(/\s+/g, " ").trim().slice(-100);
		if (condensed) lines.push(`  ... ${condensed}`);
	}

	// Live text (streaming output)
	if (state.phase === "text" && state.liveText.trim()) {
		const live = state.liveText.slice(-500);
		const condensed = live.replace(/\s+/g, " ").trim().slice(-100);
		if (condensed) lines.push(`  ${condensed}`);
	}

	// Current tool display
	if (state.currentTool) {
		const toolLabel = state.currentToolArgs
			? `${state.currentTool}: ${state.currentToolArgs.slice(0, 80)}`
			: state.currentTool;
		lines.push(`  🔧 ${toolLabel}`);
	}

	// Recent fullLog entries (last N to fill remaining lines up to WIDGET_LINES)
	const remaining = WIDGET_LINES - lines.length - 1; // -1 for stats footer
	if (remaining > 0 && state.fullLog.length > 0) {
		const recent = state.fullLog.slice(-remaining);
		for (const entry of recent) {
			// Strip emoji prefixes to avoid clutter (they're in fullLog format)
			const display = entry.replace(/^[^\s]+\s/, "").slice(0, 90);
			lines.push(`  ${display}`);
		}
	}

	// Stats footer
	const statsParts: string[] = [];
	if (state.tokenCount > 0) statsParts.push(`📊 ${formatTokens(state.tokenCount)} tokens`);
	if (state.toolCount > 0) statsParts.push(`🔧 ${state.toolCount} tools`);
	const elapsed = formatDuration(now - state.startedAt);
	statsParts.push(`⏱ ${elapsed}`);
	if (statsParts.length > 0) {
		lines.push(`  ${statsParts.join(" · ")}`);
	}

	// Enforce max lines
	return lines.slice(0, WIDGET_LINES);
}

// ─── working message ────────────────────────────────────────────────

function getWorkingMessage(state: AgentRunState, agentName: string): string | null {
	// Priority: tool > thinking > text
	switch (state.phase) {
		case "tool":
			if (state.currentTool) {
				return `${agentName}: ${state.currentTool}`;
			}
			return `${agentName}: working...`;
		case "thinking":
			return `${agentName}: thinking...`;
		case "text":
			return `${agentName}: responding...`;
		default:
			return null; // clear
	}
}

// ─── extractTextFromContent ─────────────────────────────────────────

function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text" && b.text)
		.map((b: any) => b.text)
		.join("\n");
}

// ─── createState helper ─────────────────────────────────────────────

function createState(overrides: Partial<AgentRunState> = {}): AgentRunState {
	return {
		currentTool: undefined,
		currentToolArgs: undefined,
		toolCount: 0,
		tokenCount: 0,
		fullLog: [],
		liveThinking: "",
		liveText: "",
		textOutputLines: [],
		thinkingOutputLines: [],
		lastToolName: undefined,
		phase: "idle",
		startedAt: Date.now(),
		contextTokens: undefined,
		contextWindow: undefined,
		contextInfoReceived: false,
		...overrides,
	};
}

// ===================================================================
// PHASE 1 — message_update handler + state
// ===================================================================

describe("Phase 1 — message_update handler + state", () => {
	describe("thinking_delta accumulation", () => {
		it("P1.1: thinking_delta accumulates in liveThinking", () => {
			const state = createState();
			const r1 = processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "Hello" },
			}), state);
			assert.ok(r1.flush);
			assert.strictEqual(state.liveThinking, "Hello");

			const r2 = processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: " World" },
			}), state);
			assert.ok(r2.flush);
			assert.strictEqual(state.liveThinking, "Hello World");
		});

		it("P1.2: thinking_end commits to fullLog and clears buffer", () => {
			const state = createState();
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "Let me think" },
			}), state);
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}), state);

			assert.strictEqual(state.liveThinking, "");
			assert.strictEqual(state.thinkingOutputLines.length, 1);
			assert.strictEqual(state.thinkingOutputLines[0], "Let me think");
			assert.ok(state.fullLog.some(e => e.includes("💭") && e.includes("Let me think")));
		});

		it("P1.3: thinking_end with empty buffer → no log entry", () => {
			const state = createState();
			const r = processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_end" },
			}), state);

			// Should still flush and trigger working change
			assert.ok(r.flush);
			assert.strictEqual(state.liveThinking, "");
			assert.strictEqual(state.thinkingOutputLines.length, 0);
		});
	});

	describe("text_delta accumulation", () => {
		it("P1.4: text_delta accumulates in liveText", () => {
			const state = createState();
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "The answer" },
			}), state);
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: " is 42." },
			}), state);

			assert.strictEqual(state.liveText, "The answer is 42.");
		});

		it("P1.5: text_end commits to fullLog and captures usage", () => {
			const state = createState();
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: "Done." },
			}), state);
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
				usage: { totalTokens: 150 },
			}), state);

			assert.strictEqual(state.liveText, "");
			assert.strictEqual(state.textOutputLines.length, 1);
			assert.strictEqual(state.textOutputLines[0], "Done.");
			assert.strictEqual(state.tokenCount, 150);
		});

		it("P1.6: text_end without output → no log entry, still clears", () => {
			const state = createState();
			const r = processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "text_end" },
			}), state);

			assert.ok(r.flush);
			assert.strictEqual(state.liveText, "");
			assert.strictEqual(state.textOutputLines.length, 0);
		});
	});

	describe("edge cases", () => {
		it("P1.7: no-crash on empty delta", () => {
			const state = createState();
			const r = processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "" },
			}), state);
			assert.strictEqual(r.flush, false);
			assert.strictEqual(state.liveThinking, "");
		});

		it("P1.8: no-crash on missing assistantMessageEvent / unknown delta type", () => {
			const state = createState();
			const r = processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "unknown_thing", foo: "bar" },
			}), state);
			assert.strictEqual(r.flush, false);
			assert.strictEqual(r.workingChange, false);
		});

		it("P1.9: no-crash on non-JSON line", () => {
			const state = createState();
			const r = processJsonLine("this is not json", state);
			assert.strictEqual(r.flush, false);
		});

		it("P1.10: no-crash on empty line", () => {
			const state = createState();
			const r = processJsonLine("   ", state);
			assert.strictEqual(r.flush, false);
		});

		it("P1.11: no-crash on missing delta field in message_update", () => {
			const state = createState();
			const r = processJsonLine(JSON.stringify({
				type: "message_update",
				message: { id: "abc" },
			}), state);
			assert.strictEqual(r.flush, false);
		});

		it("P1.12: text_delta with very long text (10K chars) → buffer truncated", () => {
			const state = createState();
			const longText = "x".repeat(9_000);
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: longText },
			}), state);
			assert.strictEqual(state.liveText.length, 9_000);

			const more = "y".repeat(2_000);
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "text_delta", text_delta: more },
			}), state);
			// Should be truncated to last ~8000
			assert.ok(state.liveText.length <= 8_500);
			assert.ok(state.liveText.endsWith(more.slice(-100)));
		});
	});
});

// ===================================================================
// PHASE 2 — buildWidgetLines
// ===================================================================

describe("Phase 2 — buildWidgetLines", () => {
	it("P2.1: returns at most 12 lines", () => {
		const state = createState({
			fullLog: Array.from({ length: 50 }, (_, i) => `log line ${i}`),
			tokenCount: 500,
			toolCount: 3,
			contextInfoReceived: true,
			contextTokens: 1000,
			contextWindow: 128000,
		});
		const lines = buildWidgetLines(state, "test-agent");
		assert.ok(lines.length <= 12);
	});

	it("P2.2: returns exactly header + context when idle with no history", () => {
		const state = createState();
		const lines = buildWidgetLines(state, "test-agent");
		assert.strictEqual(lines.length, 3); // header + context + stats footer (but stats may be empty)
		assert.ok(lines[0].includes("⚙ test-agent"));
		assert.ok(lines[1].includes("Context: computing..."));
	});

	it("P2.3: live thinking with ... prefix when thinking", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "I need to analyze this carefully\nand consider multiple options",
		});
		const lines = buildWidgetLines(state, "agent");
		assert.ok(lines.some(l => l.includes("...")));
		assert.ok(lines.some(l => l.includes("I need to analyze this carefully")));
	});

	it("P2.4: live thinking from liveThinking.slice(-500)", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "x".repeat(600) + " final thought",
			contextInfoReceived: true,
			contextTokens: 100,
			contextWindow: 1000,
		});
		const lines = buildWidgetLines(state, "agent");
		const thinkingLine = lines.find(l => l.startsWith("  ... "));
		assert.ok(thinkingLine);
		// Should contain the end portion (most recent thinking)
		assert.ok(thinkingLine.includes("final thought"));
	});

	it("P2.5: stats footer present", () => {
		const state = createState({
			tokenCount: 1234,
			toolCount: 5,
			contextInfoReceived: true,
			contextTokens: 500,
			contextWindow: 128000,
		});
		const lines = buildWidgetLines(state, "agent");
		const lastLine = lines[lines.length - 1];
		assert.ok(lastLine.includes("📊"));
		assert.ok(lastLine.includes("🔧"));
	});

	it("P2.6: current tool displayed with 🔧 prefix", () => {
		const state = createState({
			phase: "tool",
			currentTool: "read",
			currentToolArgs: "{\"path\":\"/some/file.ts\"}",
		});
		const lines = buildWidgetLines(state, "agent");
		assert.ok(lines.some(l => l.includes("🔧") && l.includes("read")));
	});

	it("P2.7: fullLog capped at 200 entries", () => {
		const state = createState();
		for (let i = 0; i < 250; i++) {
			pushLog(state, `entry ${i}`);
		}
		assert.strictEqual(state.fullLog.length, 200);
		assert.strictEqual(state.fullLog[0], "entry 50");
		assert.strictEqual(state.fullLog[199], "entry 249");
	});

	it("P2.8: whitespace-only thinking filtered from widget", () => {
		const state = createState({
			phase: "thinking",
			liveThinking: "   \n  \n   ",
			contextInfoReceived: true,
			contextTokens: 100,
			contextWindow: 1000,
		});
		const lines = buildWidgetLines(state, "agent");
		// No thinking line ("..." prefix) for whitespace-only thinking
		const thinkingLines = lines.filter(l => l.startsWith("  ... "));
		assert.strictEqual(thinkingLines.length, 0);
	});

	it("P2.9: widget shows text streaming", () => {
		const state = createState({
			phase: "text",
			liveText: "Here is the response to your query about...",
		});
		const lines = buildWidgetLines(state, "agent");
		assert.ok(lines.some(l => l.includes("Here is the response")));
	});

	it("P2.10: widget shows completed tool calls from fullLog", () => {
		const state = createState({
			fullLog: ["🔧 read {\"path\":\"/x.ts\"}", "✓ read", "🔧 write /x.ts", "✓ write"],
			toolCount: 2,
			contextInfoReceived: true,
			contextTokens: 100,
			contextWindow: 1000,
		});
		const lines = buildWidgetLines(state, "agent");
		assert.ok(lines.some(l => l.includes("read")));
		assert.ok(lines.some(l => l.includes("write")));
	});

	it("P2.11: elapsed time in footer", () => {
		const state = createState({
			startedAt: Date.now() - 65_000, // 65 seconds ago
			contextInfoReceived: true,
			contextTokens: 100,
			contextWindow: 1000,
		});
		const lines = buildWidgetLines(state, "agent");
		const lastLine = lines[lines.length - 1];
		assert.ok(lastLine.includes("⏱"));
		assert.ok(lastLine.includes("1m 5s"));
	});
});

// ===================================================================
// PHASE 3 — working message (phase detection)
// ===================================================================

describe("Phase 3 — working message", () => {
	it("P3.1: thinking_delta sets workingMessage to 'thinking...'", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "hmm" },
		}), state);
		const wm = getWorkingMessage(state, "architect");
		assert.ok(wm);
		assert.ok(wm.includes("thinking"));
	});

	it("P3.2: tool_execution_start sets workingMessage to tool name", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "ls" },
		}), state);
		const wm = getWorkingMessage(state, "architect");
		assert.ok(wm);
		assert.ok(wm.includes("bash"));
	});

	it("P3.3: text_delta sets workingMessage to 'responding...'", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_delta", text_delta: "ok" },
		}), state);
		const wm = getWorkingMessage(state, "architect");
		assert.ok(wm);
		assert.ok(wm.includes("responding"));
	});

	it("P3.4: idle phase returns null (clear working message)", () => {
		const state = createState({ phase: "idle" });
		const wm = getWorkingMessage(state, "architect");
		assert.strictEqual(wm, null);
	});

	it("P3.5: tool_end sets phase to idle", () => {
		const state = createState({ phase: "tool", currentTool: "read" });
		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "read",
		}), state);
		assert.strictEqual(state.phase, "idle");
	});

	it("P3.6: thinking_end sets phase to idle", () => {
		const state = createState({ phase: "thinking" });
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_end" },
		}), state);
		assert.strictEqual(state.phase, "idle");
	});

	it("P3.7: text_end sets phase to idle", () => {
		const state = createState({ phase: "text" });
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_end" },
		}), state);
		assert.strictEqual(state.phase, "idle");
	});

	it("P3.8: message_end sets phase to idle", () => {
		const state = createState({ phase: "text" });
		processJsonLine(JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
		}), state);
		assert.strictEqual(state.phase, "idle");
	});

	it("P3.9: tool priority over thinking — tool stays after thinking event", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "bash",
		}), state);
		assert.strictEqual(state.phase, "tool");

		// A spurious thinking_delta should not override tool phase
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "hmm" },
		}), state);
		// Phase remains "tool" because tool has higher priority
		assert.strictEqual(state.phase, "tool");
	});
});

// ===================================================================
// PHASE 4 — thinking output for message renderer
// ===================================================================

describe("Phase 4 — thinking output for message renderer", () => {
	it("P4.1: thinkingOutputLines accumulates across multiple thinking blocks", () => {
		const state = createState();

		// First thinking block
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "First thought" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_end" },
		}), state);

		// Second thinking block
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "Second thought" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_end" },
		}), state);

		assert.strictEqual(state.thinkingOutputLines.length, 2);
		assert.strictEqual(state.thinkingOutputLines[0], "First thought");
		assert.strictEqual(state.thinkingOutputLines[1], "Second thought");
	});

	it("P4.2: textOutputLines accumulates text content", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_delta", text_delta: "Hello" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_delta", text_delta: " World" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_end" },
		}), state);

		assert.strictEqual(state.textOutputLines.length, 1);
		assert.strictEqual(state.textOutputLines[0], "Hello World");
	});

	it("P4.3: thinking with newlines → each line pushed to fullLog", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "Line 1\nLine 2\nLine 3" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_end" },
		}), state);

		assert.strictEqual(state.thinkingOutputLines.length, 1);
		assert.strictEqual(state.thinkingOutputLines[0], "Line 1\nLine 2\nLine 3");
		// Each non-empty line appears in fullLog
		const thinkingLogEntries = state.fullLog.filter(e => e.startsWith("💭"));
		assert.strictEqual(thinkingLogEntries.length, 3);
	});
});

// ===================================================================
// PHASE 5 — edge cases + regression
// ===================================================================

describe("Phase 5 — edge cases + regression", () => {
	it("P5.1: existing tool_execution_start/end handling unchanged", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "read",
			args: { path: "/test.ts" },
		}), state);

		assert.strictEqual(state.currentTool, "read");
		assert.strictEqual(state.fullLog.length, 1);
		assert.ok(state.fullLog[0].includes("🔧 read"));

		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "read",
			isError: false,
		}), state);

		assert.strictEqual(state.toolCount, 1);
		assert.strictEqual(state.currentTool, undefined);
		assert.strictEqual(state.fullLog.length, 2);
		assert.ok(state.fullLog[1].includes("✓ read"));
	});

	it("P5.2: existing message_end handling unchanged", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "The answer" },
					{ type: "thinking", thinking: "I thought about it" },
				],
				usage: { totalTokens: 100 },
			},
		}), state);

		assert.strictEqual(state.tokenCount, 100);
		assert.strictEqual(state.textOutputLines.length, 1);
		assert.strictEqual(state.textOutputLines[0], "The answer");
		// thinking block from message_end should be in fullLog
		const thinkingEntries = state.fullLog.filter(e => e.startsWith("💭"));
		assert.strictEqual(thinkingEntries.length, 1);
	});

	it("P5.3: rapid tool bursts with interleaved events", () => {
		const state = createState();

		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "read",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "read",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "bash",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "bash",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "write",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "write",
		}), state);

		assert.strictEqual(state.toolCount, 3);
		assert.strictEqual(state.currentTool, undefined);
		assert.strictEqual(state.fullLog.length, 6);
	});

	it("P5.4: interleaved thinking and tool events", () => {
		const state = createState();

		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "Analyzing..." },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_end" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "read",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "read",
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_delta", text_delta: "Result: OK" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_end" },
		}), state);

		assert.strictEqual(state.toolCount, 1);
		assert.strictEqual(state.thinkingOutputLines.length, 1);
		assert.strictEqual(state.textOutputLines.length, 1);
		assert.strictEqual(state.thinkingOutputLines[0], "Analyzing...");
		assert.strictEqual(state.textOutputLines[0], "Result: OK");
	});

	it("P5.5: fullLog contains all event types", () => {
		const state = createState({
			contextInfoReceived: true,
			contextTokens: 100,
			contextWindow: 1000,
		});

		// Simulate full session
		processJsonLine(JSON.stringify({
			type: "context_info",
			contextTokens: 100,
			contextWindow: 1000,
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_delta", thinking_delta: "thinking..." },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_end" },
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "read",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "read",
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_delta", text_delta: "Done." },
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_end" },
		}), state);

		// Check all event types present
		const types = new Set(state.fullLog.map(e => e.slice(0, 2)));
		assert.ok(types.has("📊") || state.fullLog.some(e => e.startsWith("📊"))); // context
		assert.ok(state.fullLog.some(e => e.startsWith("💭"))); // thinking
		assert.ok(state.fullLog.some(e => e.startsWith("🔧"))); // tool start
		assert.ok(state.fullLog.some(e => e.startsWith("✓"))); // tool end
	});

	it("P5.6: tool_execution_end with error flag", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "bash",
		}), state);
		processJsonLine(JSON.stringify({
			type: "tool_execution_end",
			toolName: "bash",
			isError: true,
		}), state);

		assert.ok(state.fullLog.some(e => e.startsWith("✗ bash")));
	});

	it("P5.7: usage capture from message_end on tool result", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "tool_execution_start",
			toolName: "read",
		}), state);
		processJsonLine(JSON.stringify({
			type: "message_end",
			message: {
				role: "toolResult",
				toolName: "read",
				content: "file contents here",
			},
		}), state);

		const toolResultEntries = state.fullLog.filter(e => e.startsWith("📋"));
		assert.strictEqual(toolResultEntries.length, 1);
		assert.ok(toolResultEntries[0].includes("read"));
		assert.ok(toolResultEntries[0].includes("file contents"));
	});

	it("P5.8: thinking buffer doesn't exceed limit even with rapid deltas", () => {
		const state = createState();
		// Simulate 20 rapid thinking deltas of 500 chars each (10K total)
		for (let i = 0; i < 20; i++) {
			processJsonLine(JSON.stringify({
				type: "message_update",
				delta: { type: "thinking_delta", thinking_delta: "x".repeat(500) },
			}), state);
		}
		// Buffer should be capped
		assert.ok(state.liveThinking.length <= MAX_LIVE_THINKING * 2);
	});

	it("P5.9: thinking_start followed by thinking_delta → phase thinking", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "thinking_start" },
		}), state);
		assert.strictEqual(state.phase, "thinking");
	});

	it("P5.10: text_start followed by text_delta → phase text", () => {
		const state = createState();
		processJsonLine(JSON.stringify({
			type: "message_update",
			delta: { type: "text_start" },
		}), state);
		assert.strictEqual(state.phase, "text");
	});
});
