/**
 * Tests for .pi/extensions/session-logger.ts
 *
 * Uses Node built-in test runner. Run with:
 *   node --experimental-strip-types --test test/session-logger.test.ts
 */

import assert from "node:assert";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Helpers duplicated from session-logger.ts (not exported)
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT = 2000;
const MAX_TOOL_OUTPUT_TAIL = 500;

function truncate(text: string, head: number, tail = 0): string {
	if (text.length <= head + tail) return text;
	const cut = text.length - head - tail;
	if (tail > 0) {
		return (
			text.slice(0, head) +
			`\n\n[... ${cut} chars truncated ...]\n\n` +
			text.slice(-tail)
		);
	}
	return text.slice(0, head) + `\n\n[... ${cut} chars truncated ...]`;
}

function ts(timestamp: number | string): string {
	const d =
		typeof timestamp === "string" ? new Date(timestamp) : new Date(timestamp);
	return d.toISOString().slice(11, 19);
}

function tok(n: number | undefined): string {
	if (n === undefined) return "?";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function costStr(c: number | undefined): string {
	if (c === undefined) return "?";
	if (c >= 0.01) return `$${c.toFixed(4)}`;
	if (c >= 0.0001) return `$${c.toFixed(6)}`;
	return `$${c.toExponential(1)}`;
}

function extractText(blocks: unknown): string {
	if (typeof blocks === "string") return blocks;
	if (!Array.isArray(blocks)) return "";
	return blocks
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text)
		.join("\n\n");
}

function hasImages(blocks: unknown): boolean {
	if (!Array.isArray(blocks)) return false;
	return blocks.some((b: any) => b.type === "image");
}

function formatUserMessage(msg: any): string {
	const text = extractText(msg.content);
	const images = hasImages(msg.content) ? " 🖼️" : "";
	return `### [%IDX%] 👤 User \`${ts(msg.timestamp)}\`${images}\n${text}\n`;
}

function formatAssistantMessage(msg: any): string {
	const parts: string[] = [];
	for (const block of msg.content) {
		if (block.type === "text" && block.text.trim()) {
			parts.push(block.text.trim());
		} else if (block.type === "thinking") {
			parts.push(`💭 ${block.thinking}`);
		} else if (block.type === "toolCall") {
			const args = block.arguments ?? {};
			const argsStr = Object.entries(args)
				.map(([k, v]: [string, any]) => {
					const s = typeof v === "string" ? v : JSON.stringify(v);
					return s.length > 80 ? `${k}=${s.slice(0, 77)}...` : `${k}=${s}`;
				})
				.join(", ");
			parts.push(`🔧 **${block.name}** \`${argsStr}\``);
		}
	}
	const tokens = msg.usage?.totalTokens;
	const totalCost = msg.usage?.cost?.total;
	const header = `### [%IDX%] 🤖 Assistant \`${ts(msg.timestamp)}\` — ${tok(tokens)} tok · ${costStr(totalCost)}`;
	if (msg.stopReason && msg.stopReason !== "stop") {
		return `${header} · stop=${msg.stopReason}\n${parts.join("\n\n")}\n`;
	}
	return `${header}\n${parts.join("\n\n")}\n`;
}

function formatToolResult(msg: any): string {
	const icon = msg.isError ? "❌" : "✅";
	const output = extractText(msg.content);
	const truncated = truncate(output, MAX_TOOL_OUTPUT, MAX_TOOL_OUTPUT_TAIL);
	const name = msg.toolName || "unknown";
	return `### [%IDX%] 📋 ${name} ${icon} \`${ts(msg.timestamp)}\`\n\`\`\`\n${truncated}\n\`\`\`\n`;
}

function formatBashExecution(msg: any): string {
	const icon = msg.exitCode === 0 ? "✅" : "❌";
	const output = truncate(
		msg.output || "",
		MAX_TOOL_OUTPUT,
		MAX_TOOL_OUTPUT_TAIL,
	);
	const cancelled = msg.cancelled ? " [CANCELLED]" : "";
	const exit = msg.exitCode !== undefined ? ` exit=${msg.exitCode}` : "";
	return (
		`### [%IDX%] 💻 bash ${icon}\`${ts(msg.timestamp)}\`${cancelled}${exit}\n` +
		`\`\`\`sh\n${msg.command}\n\`\`\`\n` +
		`\`\`\`\n${output}\n\`\`\`\n`
	);
}

function formatCustomMessage(msg: any): string {
	const text = extractText(msg.content);
	return `### [%IDX%] 🔌 ${msg.customType || "extension"} \`${ts(msg.timestamp)}\`\n${text}\n`;
}

function formatBranchSummary(msg: any): string {
	return `> 📍 Branch summary (from ${msg.fromId}): ${msg.summary}\n`;
}

function formatCompactionSummary(msg: any): string {
	return `> 🗜️ Compaction: ${msg.summary}\n`;
}

// =========================================================================
// Pure helpers
// =========================================================================

describe("truncate", () => {
	it("returns unchanged when text < head+tail", () => {
		assert.strictEqual(truncate("hello", 10, 5), "hello");
	});

	it("truncates head-only (tail=0)", () => {
		const r = truncate("abcdefghijklmnop", 5);
		assert.ok(r.includes("abcde"));
		assert.ok(r.includes("chars truncated"));
		assert.ok(!r.includes("klmnop"));
	});

	it("truncates head + tail", () => {
		const r = truncate("abcdefghijklmnop", 5, 5);
		assert.ok(r.includes("abcde"));
		assert.ok(r.includes("lmnop"));
		assert.ok(r.includes("chars truncated"));
	});

	it("no truncation at exact length", () => {
		assert.strictEqual(truncate("1234567890", 5, 5), "1234567890");
	});

	it("handles empty string", () => {
		assert.strictEqual(truncate("", 5), "");
	});
});

describe("ts", () => {
	it("formats numeric ts as HH:MM:SS", () => {
		assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(ts(1705333845000)));
	});

	it("formats ISO string ts", () => {
		assert.strictEqual(ts("2025-06-01T08:15:30.000Z"), "08:15:30");
	});
});

describe("tok", () => {
	it("undefined → ?", () => assert.strictEqual(tok(undefined), "?"));
	it("42 → 42", () => assert.strictEqual(tok(42), "42"));
	it("1000 → 1.0K", () => assert.strictEqual(tok(1000), "1.0K"));
	it("5500 → 5.5K", () => assert.strictEqual(tok(5500), "5.5K"));
	it("1_000_000 → 1.0M", () => assert.strictEqual(tok(1_000_000), "1.0M"));
	it("2_500_000 → 2.5M", () => assert.strictEqual(tok(2_500_000), "2.5M"));
});

describe("costStr", () => {
	it("undefined → ?", () => assert.strictEqual(costStr(undefined), "?"));
	it("0.01 → $0.0100", () => assert.strictEqual(costStr(0.01), "$0.0100"));
	it("5 → $5.0000", () => assert.strictEqual(costStr(5), "$5.0000"));
	it("0.001 → $0.001000", () =>
		assert.strictEqual(costStr(0.001), "$0.001000"));
	it("0.00009 → $9.0e-5", () =>
		assert.strictEqual(costStr(0.00009), "$9.0e-5"));
});

describe("extractText", () => {
	it("string passthrough", () =>
		assert.strictEqual(extractText("hello"), "hello"));
	it("non-array → empty", () => {
		assert.strictEqual(extractText(null), "");
		assert.strictEqual(extractText(42), "");
	});
	it("extracts text blocks joined by \\n\\n", () => {
		const blocks = [
			{ type: "text", text: "A" },
			{ type: "thinking", thinking: "hmm" },
			{ type: "text", text: "B" },
		];
		assert.strictEqual(extractText(blocks), "A\n\nB");
	});
	it("no text blocks → empty", () => {
		assert.strictEqual(extractText([{ type: "image", url: "x" }]), "");
	});
});

describe("hasImages", () => {
	it("non-array → false", () => assert.strictEqual(hasImages("x"), false));
	it("no images → false", () =>
		assert.strictEqual(hasImages([{ type: "text", text: "hi" }]), false));
	it("image present → true", () =>
		assert.strictEqual(
			hasImages([{ type: "text" }, { type: "image", url: "x" }]),
			true,
		));
});

// =========================================================================
// Message formatters
// =========================================================================

describe("formatUserMessage", () => {
	it("text-only", () => {
		const r = formatUserMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "text", text: "Hi!" }],
		});
		assert.ok(r.includes("👤 User"));
		assert.ok(r.includes("Hi!"));
		assert.ok(!r.includes("🖼️"));
	});

	it("with image indicator", () => {
		const r = formatUserMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [
				{ type: "text", text: "Look" },
				{ type: "image", url: "p.jpg" },
			],
		});
		assert.ok(r.includes("🖼️"));
	});
});

describe("formatAssistantMessage", () => {
	it("text + tokens", () => {
		const r = formatAssistantMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "text", text: "Ok" }],
			usage: { totalTokens: 42, cost: { total: 0.001 } },
		});
		assert.ok(r.includes("🤖 Assistant"));
		assert.ok(r.includes("Ok"));
		assert.ok(r.includes("42 tok"));
	});

	it("thinking block", () => {
		const r = formatAssistantMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "thinking", thinking: "Hmm..." }],
		});
		assert.ok(r.includes("💭 Hmm..."));
	});

	it("tool call", () => {
		const r = formatAssistantMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "toolCall", name: "read", arguments: { path: "/f" } }],
		});
		assert.ok(r.includes("🔧 **read**"));
		assert.ok(r.includes("/f"));
	});

	it("stop reason (non-stop)", () => {
		const r = formatAssistantMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "text", text: "x" }],
			stopReason: "max_tokens",
		});
		assert.ok(r.includes("stop=max_tokens"));
	});

	it("hides stop reason when 'stop'", () => {
		const r = formatAssistantMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "text", text: "x" }],
			stopReason: "stop",
		});
		assert.ok(!r.includes("stop=stop"));
	});

	it("missing usage → ? tok", () => {
		const r = formatAssistantMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "text", text: "hi" }],
		});
		assert.ok(r.includes("? tok"));
	});

	it("truncates long arg values (100→77)", () => {
		const long = "a".repeat(100);
		const r = formatAssistantMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "toolCall", name: "w", arguments: { c: long } }],
		});
		assert.ok(!r.includes(long));
		assert.ok(r.includes("a".repeat(77) + "..."));
	});
});

describe("formatToolResult", () => {
	it("success", () => {
		const r = formatToolResult({
			timestamp: "2025-06-01T10:00:00.000Z",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "ok" }],
		});
		assert.ok(r.includes("📋 read ✅"));
		assert.ok(r.includes("ok"));
	});

	it("error", () => {
		const r = formatToolResult({
			timestamp: "2025-06-01T10:00:00.000Z",
			toolName: "bash",
			isError: true,
			content: [{ type: "text", text: "fail" }],
		});
		assert.ok(r.includes("📋 bash ❌"));
	});

	it("missing toolName → unknown", () => {
		const r = formatToolResult({
			timestamp: "2025-06-01T10:00:00.000Z",
			isError: false,
			content: "text",
		});
		assert.ok(r.includes("📋 unknown"));
	});

	it("truncates long output", () => {
		const long = "x".repeat(3000);
		const r = formatToolResult({
			timestamp: "2025-06-01T10:00:00.000Z",
			toolName: "r",
			isError: false,
			content: [{ type: "text", text: long }],
		});
		assert.ok(r.includes("chars truncated"));
	});
});

describe("formatBashExecution", () => {
	it("success", () => {
		const r = formatBashExecution({
			timestamp: "2025-06-01T10:00:00.000Z",
			command: "ls",
			output: "x",
			exitCode: 0,
			cancelled: false,
		});
		assert.ok(r.includes("💻 bash ✅"));
		assert.ok(r.includes("ls"));
		assert.ok(r.includes("exit=0"));
	});

	it("failure", () => {
		const r = formatBashExecution({
			timestamp: "2025-06-01T10:00:00.000Z",
			command: "bad",
			output: "err",
			exitCode: 1,
			cancelled: false,
		});
		assert.ok(r.includes("💻 bash ❌"));
		assert.ok(r.includes("exit=1"));
	});

	it("cancelled", () => {
		const r = formatBashExecution({
			timestamp: "2025-06-01T10:00:00.000Z",
			command: "sleep",
			output: "",
			exitCode: -1,
			cancelled: true,
		});
		assert.ok(r.includes("[CANCELLED]"));
	});

	it("no exitCode → no exit=", () => {
		const r = formatBashExecution({
			timestamp: "2025-06-01T10:00:00.000Z",
			command: "x",
			output: "",
			cancelled: false,
		});
		assert.ok(!r.includes("exit="));
	});

	it("truncates long output", () => {
		const long = "y".repeat(3000);
		const r = formatBashExecution({
			timestamp: "2025-06-01T10:00:00.000Z",
			command: "cat",
			output: long,
			exitCode: 0,
			cancelled: false,
		});
		assert.ok(r.includes("chars truncated"));
	});
});

describe("formatCustomMessage", () => {
	it("with customType", () => {
		const r = formatCustomMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			customType: "my-plugin",
			content: [{ type: "text", text: "data" }],
		});
		assert.ok(r.includes("🔌 my-plugin"));
	});

	it("defaults to 'extension'", () => {
		const r = formatCustomMessage({
			timestamp: "2025-06-01T10:00:00.000Z",
			content: [{ type: "text", text: "data" }],
		});
		assert.ok(r.includes("🔌 extension"));
	});
});

describe("formatBranchSummary", () => {
	it("includes fromId and summary", () => {
		const r = formatBranchSummary({ fromId: "abc", summary: "Fix" });
		assert.ok(r.includes("📍 Branch summary"));
		assert.ok(r.includes("abc"));
		assert.ok(r.includes("Fix"));
	});
});

describe("formatCompactionSummary", () => {
	it("includes summary", () => {
		const r = formatCompactionSummary({ summary: "Compact 10→2" });
		assert.ok(r.includes("🗜️ Compaction"));
		assert.ok(r.includes("Compact 10→2"));
	});
});
