/**
 * session-advice — Session advice extension
 *
 * Generates .advice.md alongside .jsonl session files.
 * Analyzes session for inefficient patterns and produces
 * actionable recommendations for the agent.
 *
 * Analysis logic in advisor.ts — shared with post-hoc script.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseJsonlFile, analyzeSession, renderAdviceToMarkdown } from "./advisor.js";
import type { AdviceEntry } from "./advisor.js";

// ── Fix ideas + effort estimates per category ──

interface FixSuggestion {
	idea: string;
	effort: "Low" | "Medium" | "High";
}

const FIXES: Record<string, FixSuggestion> = {
	"tool-mismatch": {
		idea: "Add tool-choice table to AGENTS.md. Whenever agent types `bash | grep`, `bash cat`, etc., trigger a self-correction to use the dedicated tool. Implement pre-call validation that maps intent → tool.",
		effort: "Low",
	},
	"error-not-actioned": {
		idea: "Add rule to AGENTS.md: 'After tool error, do NOT retry same tool+args. Change approach.' Track last 3 errors per tool; if same tool errors twice in a row, force strategy switch.",
		effort: "Medium",
	},
	"identical-call-loop": {
		idea: "Add tool-call dedup cache. Before issuing a tool call, check if identical args were used in last N calls. If so, skip or merge. Detect loops in agent's reasoning loop and break them.",
		effort: "High",
	},
	"same-tool-cascade": {
		idea: "Add batching guidance to AGENTS.md. Implement tool-level batching: when N same-tool calls queued, merge into one (e.g., combine bash with `&&`, batch reads by reading larger region).",
		effort: "Medium",
	},
	"redundant-read": {
		idea: "Add read-result cache keyed by file path + offset/limit. If same file read within 3 turns, return cached content. Add 'read once, use offset to page' to AGENTS.md.",
		effort: "Medium",
	},
	"high-error-rate": {
		idea: "Add pre-flight validation: check file exists before read/edit, check command exists before bash, check path before write. Surface validation errors to user early.",
		effort: "High",
	},
	"excessive-turns": {
		idea: "Add turn budget: if more than X tool calls produce no file change, pause and ask user for direction. Add 'work in larger batches' to AGENTS.md.",
		effort: "Medium",
	},
	"tool-coverage-gap": {
		idea: "Add auto-detection: when code files are read/edited but structural_search never called in first 3 turns, add a reminder to use it. Mention in AGENTS.md.",
		effort: "Low",
	},
};

const DEFAULT_FIX: FixSuggestion = {
	idea: "Review AGENTS.md for relevant rules. Consider adding automated detection for this pattern.",
	effort: "Medium",
};

export default function (pi: ExtensionAPI): void {
	let enabled = true;

	pi.registerCommand("session-advice", {
		description:
			"Toggle session advice on/off, or generate report. Usage: /session-advice [on|off|report]",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim().toLowerCase();

			if (cmd === "report") {
				const cwd = ctx.sessionManager?.getCwd();
				if (!cwd) {
					ctx.ui.notify("Cannot determine project directory.", "error");
					return;
				}
				const sessionsDir = path.resolve(cwd, ".pi", "sessions");
				if (!fs.existsSync(sessionsDir)) {
					ctx.ui.notify(`No sessions directory: ${sessionsDir}`, "error");
					return;
				}

				ctx.ui.notify("Generating session advice report...", "info");

				const reportPath = path.join(sessionsDir, "advice-report.md");
				const md = generateAdviceReport(sessionsDir);
				fs.writeFileSync(reportPath, md, "utf-8");

				ctx.ui.notify(`Report written: ${reportPath}`, "success");

				// Ask about GitHub issue (before cleanup — user may want issue from the data)
				const createIssue = await ctx.ui.confirm(
					"Create GitHub issue?",
					"Create a GitHub issue from the report in the project repo (.pi/settings.json → supervisor.repo)?",
				);

				if (createIssue) {
					const settingsPath = path.resolve(cwd, ".pi", "settings.json");
					let repo = "";
					try {
						const raw = fs.readFileSync(settingsPath, "utf-8");
						const settings = JSON.parse(raw);
						repo = settings?.supervisor?.repo ?? "";
					} catch {
						ctx.ui.notify("Cannot read supervisor.repo from .pi/settings.json", "error");
						return;
					}

					if (!repo) {
						ctx.ui.notify("No repo found in .pi/settings.json (supervisor.repo)", "error");
						return;
					}

					ctx.ui.notify(`Creating GitHub issue in ${repo}...`, "info");

					try {
						const body = fs.readFileSync(reportPath, "utf-8");
						// Count findings for title
						const findingMatch = body.match(/\*\*Total findings:\*\* (\d+)/);
						const findingCount = findingMatch ? findingMatch[1] : "?";
						const date = new Date().toISOString().slice(0, 10);
						const title = `Session Advice Report — ${date} (${findingCount} findings)`;

						// Write body to temp file to avoid shell escaping issues
						const bodyFile = path.join(sessionsDir, ".gh-issue-body.tmp");
						fs.writeFileSync(bodyFile, body, "utf-8");

						const result = execSync(
							`gh issue create --repo "${repo}" --title "${title}" --body-file "${bodyFile}"`,
							{
								cwd,
								timeout: 30_000,
								encoding: "utf-8",
							},
						).trim();

						// Clean up temp file
						try {
							fs.unlinkSync(bodyFile);
						} catch {
							/* ok */
						}

						ctx.ui.notify(`Issue created: ${result}`, "success");
					} catch (err) {
						ctx.ui.notify(`Failed to create issue: ${(err as Error).message}`, "error");
					}
				}

				// Ask about cleanup
				const clean = await ctx.ui.confirm(
					"Clean sessions?",
					"Delete all session files (.jsonl, .md, .metadata.json, .advice.md) from .pi/sessions/?\n\nThis keeps the report but removes raw session data.",
				);

				if (clean) {
					let deleted = 0;
					try {
						const files = fs.readdirSync(sessionsDir);
						for (const f of files) {
							if (
								f === "latest.jsonl" ||
								f === "latest.md" ||
								f === "latest.metadata.json" ||
								f === "latest.advice.md" ||
								f === "advice-report.md" ||
								f.startsWith(".")
							)
								continue;
							const ext = f.split(".").pop();
							if (ext === "jsonl" || ext === "md" || ext === "json") {
								fs.unlinkSync(path.join(sessionsDir, f));
								deleted++;
							}
						}
					} catch (err) {
						ctx.ui.notify(`Cleanup failed: ${(err as Error).message}`, "error");
						return;
					}
					ctx.ui.notify(`Cleaned ${deleted} session files. Report kept.`, "info");
				}

				return;
			}

			// Fall through to toggle
			if (cmd === "on") enabled = true;
			else if (cmd === "off") enabled = false;
			else enabled = !enabled;
			ctx.ui.notify(`Session advice: ${enabled ? "ON" : "OFF"} (applies to next session)`, "info");
		},
	});

	// ── Recovery: generate advice for past sessions missing .advice.md ──

	pi.on("session_start", async (_event, ctx) => {
		if (!enabled) return;

		const sm = ctx.sessionManager;
		const cwd = sm.getCwd();
		if (!cwd) return;

		const sessionsDir = path.resolve(cwd, ".pi", "sessions");
		if (!fs.existsSync(sessionsDir)) return;

		// Find all .jsonl files that lack a matching .advice.md
		let files: string[] = [];
		try {
			files = fs
				.readdirSync(sessionsDir)
				.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));
		} catch {
			return;
		}

		for (const file of files) {
			const prefix = file.replace(/\.jsonl$/, "");
			const jsonlPath = path.join(sessionsDir, file);
			const advicePath = path.join(sessionsDir, `${prefix}.advice.md`);

			if (fs.existsSync(advicePath)) continue;

			writeAdvice(jsonlPath, advicePath, sessionsDir);
		}
	});

	// ── Generate advice for current closing session ──

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enabled) return;

		const sm = ctx.sessionManager;
		const sessionFile = sm.getSessionFile();
		if (!sessionFile) return;

		const sessionDir = path.dirname(sessionFile);
		const advicePath = sessionFile.replace(/\.jsonl$/, ".advice.md");

		if (fs.existsSync(advicePath)) return;

		writeAdvice(sessionFile, advicePath, sessionDir);
	});
}

/**
 * Generate cross-session advice report.
 * Parses all JSONL files in sessionsDir, aggregates findings,
 * maps categories to fix ideas + effort estimates.
 *
 * Pure function — no side effects. Exported for headless use.
 */
export function generateAdviceReport(sessionsDir: string): string {
	const jsonlFiles = fs
		.readdirSync(sessionsDir)
		.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"))
		.sort();

	// Aggregate results across sessions
	let totalSessions = 0;
	let cleanSessions = 0;
	const allIssues: Array<{ session: string; entry: AdviceEntry }> = [];

	for (const file of jsonlFiles) {
		const jsonlPath = path.join(sessionsDir, file);
		totalSessions++;

		try {
			const data = parseJsonlFile(jsonlPath);
			if (!data) continue;

			const result = analyzeSession(data);
			if (result.entries.length === 0) {
				cleanSessions++;
				continue;
			}

			for (const entry of result.entries) {
				allIssues.push({
					session: data.sessionId,
					entry,
				});
			}
		} catch {
			// skip unparseable files
		}
	}

	// Group by category
	const byCategory: Record<
		string,
		{
			category: string;
			issues: Array<{ session: string; detail: string; severity: string }>;
		}
	> = {};

	for (const { session, entry } of allIssues) {
		if (!byCategory[entry.category]) {
			byCategory[entry.category] = { category: entry.category, issues: [] };
		}
		byCategory[entry.category].issues.push({
			session,
			detail: entry.detail,
			severity: entry.severity,
		});
	}

	// Compute per-category severity + pick an example
	const categories = Object.values(byCategory)
		.map((g) => {
			const maxSev = g.issues.reduce(
				(acc, i) => {
					const w = i.severity === "error" ? 2 : i.severity === "warning" ? 1 : 0;
					return w > acc.w ? { sev: i.severity, w } : acc;
				},
				{ sev: "info" as string, w: 0 },
			).sev;

			// Unique sessions this category appeared in
			const sessions = [...new Set(g.issues.map((i) => i.session))];

			const reach = sessions.length * g.issues.length;
			const priority = reach >= 50 ? "High" : reach >= 10 ? "Medium" : "Low";
			const fix = FIXES[g.category] ?? DEFAULT_FIX;

			// Unique details for display
			const sampleDetails = [...new Set(g.issues.map((i) => i.detail))].slice(0, 3);

			// Pick one concrete example
			const firstDetail = g.issues.find((i) => i.detail);
			const example = firstDetail?.detail?.replace(/\s*\(turn.*\)$/, "") ?? "—";

			return {
				category: g.category,
				priority,
				severity: maxSev,
				sessionsAffected: sessions.length,
				issues: g.issues.length,
				sessionIds: sessions,
				example,
				sampleDetails,
				fixIdea: fix.idea,
				effort: fix.effort,
			};
		})
		.sort((a, b) => {
			const p = { High: 3, Medium: 2, Low: 1 };
			return (p[b.priority] ?? 0) - (p[a.priority] ?? 0);
		});

	// Render report
	const sections: string[] = [];
	sections.push(`# Session Advice Report`);
	sections.push(``);
	sections.push(`Generated: ${new Date().toISOString()}`);
	sections.push(``);
	sections.push(`| Metric | Value |`);
	sections.push(`|--------|-------|`);
	sections.push(`| Sessions analyzed | ${totalSessions} |`);
	sections.push(`| Sessions with issues | ${totalSessions - cleanSessions} |`);
	sections.push(`| Clean sessions | ${cleanSessions} |`);
	sections.push(`| Total findings | ${allIssues.length} |`);
	sections.push(`| Unique categories | ${categories.length} |`);
	sections.push(``);

	// Summary table
	sections.push(`## Summary`);
	sections.push(``);
	sections.push(`| Pri | Sev | Category | Sessions | Findings | Example | Effort |`);
	sections.push(`|-----|-----|----------|----------|----------|---------|--------|`);

	for (const c of categories) {
		const pIcon = c.priority === "High" ? "🔴" : c.priority === "Medium" ? "🟡" : "🟢";
		const sIcon = c.severity === "error" ? "❌" : c.severity === "warning" ? "⚠️" : "ℹ️";
		sections.push(
			`| ${pIcon} ${c.priority[0]} | ${sIcon} ${c.severity} | \`${c.category}\` | ${c.sessionsAffected} | ${c.issues} | \`${short(c.example, 65)}\` | ${c.effort} |`,
		);
	}
	sections.push(``);

	// Detail sections by priority
	const byPriority = {
		High: [] as typeof categories,
		Medium: [] as typeof categories,
		Low: [] as typeof categories,
	};
	for (const c of categories) {
		byPriority[c.priority as keyof typeof byPriority]?.push(c);
	}

	for (const [priority, label] of [
		["High", "High Priority"],
		["Medium", "Medium Priority"],
		["Low", "Low Priority"],
	] as const) {
		const group = byPriority[priority];
		if (!group?.length) continue;

		sections.push(`## ${label}`);
		sections.push(``);

		for (const c of group) {
			sections.push(`### ${c.category}`);
			sections.push(``);
			sections.push(`**Sessions affected:** ${c.sessionsAffected}`);
			sections.push(`**Findings count:** ${c.issues}`);
			sections.push(`**Severity:** ${c.severity} (→ ${c.priority} priority)`);
			sections.push(`**Effort estimate:** ${c.effort}`);
			sections.push(``);

			if (c.sessionIds && c.sessionIds.length > 0) {
				const links = c.sessionIds.map((id: string) => `\`${id.slice(0, 8)}\``).join(", ");
				sections.push(`**Session files:** ${links}`);
				sections.push(`*See matching \`.advice.md\` in \`.pi/sessions/\`*`);
				sections.push(``);
			}

			if (c.sampleDetails.length > 0) {
				sections.push(`**Sample findings:**`);
				for (const d of c.sampleDetails) {
					sections.push(`- ${d}`);
				}
				sections.push(``);
			}

			sections.push(`**Fix idea:**`);
			sections.push(``);
			sections.push(c.fixIdea);
			sections.push(``);
			sections.push(`---`);
			sections.push(``);
		}
	}

	// Frequencies
	sections.push(`## Findings per Session`);
	sections.push(``);
	sections.push(`| Session | Count | Top Categories |`);
	sections.push(`|---------|-------|----------------|`);

	const perSession: Record<string, { count: number; cats: Record<string, number> }> = {};
	for (const { session, entry } of allIssues) {
		if (!perSession[session]) perSession[session] = { count: 0, cats: {} };
		perSession[session].count++;
		perSession[session].cats[entry.category] = (perSession[session].cats[entry.category] ?? 0) + 1;
	}

	for (const [sess, info] of Object.entries(perSession).sort((a, b) => b[1].count - a[1].count)) {
		const topCats = Object.entries(info.cats)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([k]) => k)
			.join(", ");
		sections.push(`| \`${sess.slice(0, 8)}\` | ${info.count} | ${topCats} |`);
	}
	sections.push(``);

	sections.push(`---`);
	sections.push(``);
	sections.push(`*Report auto-generated. Run \`/session-advice report\` to refresh.*`);
	sections.push(``);

	return sections.join("\n");
}

function short(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 3) + "...";
}

/** Generate .advice.md for a session .jsonl file. */
function writeAdvice(jsonlPath: string, advicePath: string, symlinkDir: string): void {
	try {
		const data = parseJsonlFile(jsonlPath);
		if (!data) return;

		const result = analyzeSession(data);
		const md = renderAdviceToMarkdown(result);

		fs.writeFileSync(advicePath, md, "utf-8");

		// Update latest symlink
		const latestPath = path.join(symlinkDir, "latest.advice.md");
		const tmpPath = latestPath + ".tmp";
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			/* ok */
		}
		try {
			fs.symlinkSync(path.relative(symlinkDir, advicePath), tmpPath);
			fs.renameSync(tmpPath, latestPath);
		} catch {
			/* symlink optional */
		}
	} catch (err) {
		console.error(`[session-advice] Failed for ${jsonlPath}: ${(err as Error).message}`);
	}
}
