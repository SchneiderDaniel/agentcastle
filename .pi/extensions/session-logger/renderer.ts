/**
 * Markdown session report renderer.
 *
 * Reads any .pi/sessions/*.jsonl file and produces a human-readable .md report.
 * Pure function — no side effects, no extension dependencies.
 */

import { readFileSync } from "node:fs";

const TRUNCATE_RESULT_LINES = 8;
const THINKING_PREVIEW_CHARS = 120;

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return String(n);
}

function fmtCost(c: number | undefined | null): string {
	if (c == null || c === 0) return "$0";
	if (c < 0.001) return `$${c.toFixed(6)}`;
	if (c < 1) return `$${c.toFixed(4)}`;
	return `$${c.toFixed(2)}`;
}

function truncate(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n) + `…(+${s.length - n} chars)`;
}

function resultPreview(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= TRUNCATE_RESULT_LINES && text.length <= 500) return text;
	return (
		lines.slice(0, TRUNCATE_RESULT_LINES).join("\n") +
		`\n…(+${lines.length - TRUNCATE_RESULT_LINES} more lines, ${text.length} total chars)`
	);
}

function escMd(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/`/g, "\\`");
}

/** Render a .jsonl session file to Markdown. */
export function renderSessionToMarkdown(filepath: string): string {
	const raw = readFileSync(filepath, "utf-8").trim();
	if (!raw) return "*Empty session*";

	const lines = raw
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	if (lines.length === 0) return "*Empty session*";

	const sections: string[] = [];

	// ── Header ──
	const header = lines[0];
	const sid = header.id ?? "?";
	const ts = header.timestamp ?? "?";
	const cwd = header.cwd ?? "?";
	const ver = header.version ?? "?";
	const parentSession = header.parentSession;

	sections.push(`# Session Report`);
	sections.push(``);
	sections.push(`| Field | Value |`);
	sections.push(`|-------|-------|`);
	sections.push(`| **Session** | \`${sid}\` |`);
	sections.push(`| **Start** | \`${ts}\` |`);
	sections.push(`| **CWD** | \`${cwd}\` |`);
	sections.push(`| **Version** | ${ver} |`);
	sections.push(`| **Entries** | ${lines.length} |`);
	if (parentSession) sections.push(`| **Parent** | \`${parentSession}\` |`);
	sections.push(``);

	// ── Model / thinking summary ──
	const models = new Set<string>();
	const thinkLevels = new Set<string>();
	for (const l of lines) {
		if (l.type === "model_change") models.add(`${l.provider}/${l.modelId}`);
		if (l.type === "thinking_level_change") thinkLevels.add(l.thinkingLevel);
	}
	if (models.size) sections.push(`**Models:** ${[...models].join(", ")}  `);
	if (thinkLevels.size) sections.push(`**Thinking:** ${[...thinkLevels].join(", ")}  `);
	sections.push(``);

	// ── Token / cost totals ──
	let totalTokens = 0;
	let totalCost = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	for (const l of lines) {
		if (l.type === "message") {
			const usage = l.message?.usage;
			if (usage) {
				inputTokens += usage.input ?? 0;
				outputTokens += usage.output ?? 0;
				cacheRead += usage.cacheRead ?? 0;
				cacheWrite += usage.cacheWrite ?? 0;
				totalTokens += usage.totalTokens ?? 0;
				if (usage.cost?.total) totalCost += usage.cost.total;
			}
		}
	}

	sections.push(`| | |`);
	sections.push(`|---|---|`);
	sections.push(`| **Input tokens** | ${fmtTokens(inputTokens)} |`);
	sections.push(`| **Output tokens** | ${fmtTokens(outputTokens)} |`);
	sections.push(`| **Cache read** | ${fmtTokens(cacheRead)} |`);
	sections.push(`| **Cache write** | ${fmtTokens(cacheWrite)} |`);
	sections.push(`| **Total tokens** | ${fmtTokens(totalTokens)} |`);
	sections.push(`| **Total cost** | ${fmtCost(totalCost)} |`);
	sections.push(``);

	// ── Tool usage ──
	const toolCounts: Record<string, { calls: number; errors: number }> = {};
	for (const l of lines) {
		if (l.type === "message" && l.message?.role === "toolResult") {
			const tn = l.message.toolName ?? "?";
			if (!toolCounts[tn]) toolCounts[tn] = { calls: 0, errors: 0 };
			toolCounts[tn].calls++;
			if (l.message.isError) toolCounts[tn].errors++;
		}
	}

	if (Object.keys(toolCounts).length > 0) {
		sections.push(`## Tool Usage`);
		sections.push(``);
		sections.push(`| Tool | Calls | Errors |`);
		sections.push(`|------|-------|--------|`);
		for (const [name, stats] of Object.entries(toolCounts).sort()) {
			const errStr = stats.errors > 0 ? String(stats.errors) : "—";
			sections.push(`| \`${escMd(name)}\` | ${stats.calls} | ${errStr} |`);
		}
		sections.push(``);
	}

	// ── File modifications summary ──
	const fileActions: Array<{ action: string; path: string }> = [];
	for (const l of lines) {
		if (l.type === "message" && l.message?.role === "assistant") {
			for (const c of l.message.content ?? []) {
				if (c.type === "toolCall" && c.name === "read") {
					fileActions.push({ action: "📖 read", path: c.arguments?.path ?? "?" });
				}
				if (c.type === "toolCall" && c.name === "write") {
					fileActions.push({ action: "✏️ write", path: c.arguments?.path ?? "?" });
				}
				if (c.type === "toolCall" && c.name === "edit") {
					fileActions.push({ action: "🔧 edit", path: c.arguments?.path ?? "?" });
				}
			}
		}
	}
	if (fileActions.length > 0) {
		sections.push(`## File Access`);
		sections.push(``);
		sections.push(`| Action | File |`);
		sections.push(`|--------|------|`);
		// Deduplicate consecutive same-action same-path
		let last = "";
		for (const fa of fileActions) {
			const key = `${fa.action}|${fa.path}`;
			if (key === last) continue;
			last = key;
			sections.push(`| ${fa.action} | \`${escMd(fa.path)}\` |`);
		}
		sections.push(``);
	}

	// ── Conversation ──
	sections.push(`## Conversation`);
	sections.push(``);

	// Build turns: walk entries, group into user → assistant exchanges
	let turnIdx = 0;
	let inTurn = false;

	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];

		// Skip header
		if (i === 0 && l.type === "session") continue;

		// Pass-through entries
		if (l.type === "model_change") {
			sections.push(`> **Model:** \`${l.provider}/${l.modelId}\``);
			sections.push(``);
			continue;
		}
		if (l.type === "thinking_level_change") {
			sections.push(`> **Thinking:** \`${l.thinkingLevel}\``);
			sections.push(``);
			continue;
		}
		if (l.type === "custom") {
			const data = JSON.stringify(l.data ?? {});
			sections.push(`> *${l.customType}* ${data !== "{}" ? `— ${data}` : ""}`);
			sections.push(``);
			continue;
		}
		if (l.type === "compaction") {
			sections.push(
				`> **Context compacted** — ${fmtTokens(l.tokensBefore ?? 0)} tokens summarized`,
			);
			sections.push(``);
			continue;
		}

		if (l.type !== "message") continue;

		const msg = l.message ?? {};
		const role = msg.role ?? "?";
		const content = msg.content ?? [];

		if (role === "user") {
			// Close previous turn
			if (inTurn) {
				sections.push(`---`);
				sections.push(``);
			}
			turnIdx++;
			inTurn = true;

			const texts = content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			sections.push(`### Turn ${turnIdx} — User`);
			sections.push(``);
			sections.push(`${texts}`);
			sections.push(``);
		} else if (role === "assistant") {
			if (!inTurn) {
				turnIdx++;
				inTurn = true;
				sections.push(`### Turn ${turnIdx} — Assistant`);
				sections.push(``);
			}

			const usage = msg.usage ?? {};
			const toks = usage.totalTokens ?? 0;
			const cost = usage.cost?.total;
			const stop = msg.stopReason ?? "";

			// Metadata line
			const metaParts: string[] = [];
			if (toks) metaParts.push(`tokens=${fmtTokens(toks)}`);
			if (cost) metaParts.push(`cost=${fmtCost(cost)}`);
			if (stop) metaParts.push(`stop=\`${stop}\``);

			// Extract parts
			const thinkBlocks = content
				.filter((c: any) => c.type === "thinking")
				.map((c: any) => c.thinking);
			const textBlocks = content.filter((c: any) => c.type === "text").map((c: any) => c.text);
			const toolCalls = content.filter((c: any) => c.type === "toolCall");

			const thinkTotal = thinkBlocks.reduce((s: number, t: string) => s + t.length, 0);

			if (metaParts.length || thinkTotal) {
				const line = metaParts.join(", ");
				sections.push(`*${line}*`);
				sections.push(``);
			}

			// Thinking — collapsed
			if (thinkTotal > 0) {
				const firstLine = thinkBlocks[0].split("\n")[0].slice(0, THINKING_PREVIEW_CHARS);
				sections.push(`> 💭 ${firstLine}`);
				if (thinkTotal > THINKING_PREVIEW_CHARS) {
					sections.push(`> *(…${fmtTokens(thinkTotal)} chars thinking)*`);
				}
				sections.push(``);
			}

			// Text blocks
			for (const txt of textBlocks) {
				if (txt.trim()) {
					sections.push(txt.trim());
					sections.push(``);
				}
			}

			// Tool calls — inline
			for (const tc of toolCalls) {
				const tName = tc.name ?? "?";
				const args = tc.arguments ?? {};
				let argStr = "";
				if (typeof args === "object") {
					const parts: string[] = [];
					for (const [k, v] of Object.entries(args)) {
						const vStr = typeof v === "string" ? truncate(v, 80) : JSON.stringify(v);
						parts.push(`${k}=\`${escMd(vStr)}\``);
					}
					argStr = parts.join(", ");
				} else {
					argStr = truncate(String(args), 120);
				}
				sections.push(`- 🔧 \`${tName}(${argStr})\``);
			}
			if (toolCalls.length > 0) sections.push(``);
		} else if (role === "toolResult") {
			const tn = msg.toolName ?? "?";
			const isErr = msg.isError ?? false;
			const resultText = content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			const errMark = isErr ? " ⚠️" : "";
			const sizeLabel = fmtTokens(resultText.length);

			sections.push(`  📥 \`${tn}\`${errMark} — ${sizeLabel}`);
			if (isErr) {
				sections.push(`  \`\`\``);
				sections.push(`  ${truncate(resultText, 300)}`);
				sections.push(`  \`\`\``);
			} else if (resultText.length > 0) {
				const preview = resultPreview(resultText);
				if (preview.includes("\n")) {
					sections.push(`  \`\`\``);
					for (const line of preview.split("\n")) {
						sections.push(`  ${line}`);
					}
					sections.push(`  \`\`\``);
				} else {
					sections.push(`  \`${truncate(escMd(resultText), 200)}\``);
				}
			}
			sections.push(``);
		}
	}

	return sections.join("\n");
}
