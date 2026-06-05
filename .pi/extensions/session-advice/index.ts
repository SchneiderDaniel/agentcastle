/**
 * session-advice — Session advice extension
 *
 * Generates .advice.md alongside .jsonl session files.
 * Detects waste signals from session data, uses LLM to generate
 * actionable advice. Injects past lessons into agent system prompt.
 *
 * Detection logic in advisor.ts (pure).
 * LLM advice generation + signal review in llm-advisor.ts.
 * Report pipeline in advice-pipeline.ts.
 * Symlink management in symlink-manager.ts.
 * Fix constants in fixes.ts.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { dirname } from "node:path";

// ── Shared extension state writer ──

function writeExtState(value: boolean): void {
	try {
		const statePath = ".pi/state/session-extensions.json";
		fs.mkdirSync(dirname(statePath), { recursive: true });
		let data: Record<string, boolean | null> = {};
		try {
			const raw = fs.readFileSync(statePath, "utf-8");
			data = JSON.parse(raw);
		} catch {
			// Fresh file
		}
		data.advice = value;
		fs.writeFileSync(statePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	} catch {
		// Best-effort
	}
}

export function getSessionAdviceState(): boolean {
	try {
		const statePath = ".pi/state/session-extensions.json";
		const raw = fs.readFileSync(statePath, "utf-8");
		const data = JSON.parse(raw) as Record<string, boolean | null>;
		return data.advice ?? true;
	} catch {
		return true;
	}
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AdvicePipeline } from "./advice-pipeline.ts";
import {
	backfillMissingAdvice,
	handleShutdown,
	createGhIssue,
	createSignalIssues,
	generateAdviceReport,
	writeAdvice,
} from "./advice-pipeline.ts";
import { analyzeSession, parseJsonlFile } from "./advisor.ts";

const pipeline = new AdvicePipeline();

export { generateAdviceReport, writeAdvice, backfillMissingAdvice, handleShutdown, createGhIssue };

export default function (pi: ExtensionAPI): void {
	let enabled = true;
	writeExtState(true);

	function syncAdviceState() {
		writeExtState(enabled);
	}

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

				ctx.ui.notify("Generating session waste report...", "info");

				const model = ctx.model;
				const modelRegistry = ctx.modelRegistry;
				const { markdown, reportPath, report } = await pipeline.generateReport(
					sessionsDir,
					model,
					modelRegistry,
				);

				ctx.ui.notify(`Report written: ${reportPath}`, "info");

				// Helper to resolve repo from settings
				function getRepo(): string | null {
					const settingsPath = path.resolve(cwd, ".pi", "settings.json");
					try {
						const raw = fs.readFileSync(settingsPath, "utf-8");
						const settings = JSON.parse(raw);
						return settings?.supervisor?.repo ?? null;
					} catch {
						return null;
					}
				}

				// Ask about report GitHub issue
				const createReportIssue = await ctx.ui.confirm(
					"Create GitHub issue from report?",
					"Create a GitHub issue from the waste report in the project repo (.pi/settings.json → supervisor.repo)?",
				);

				if (createReportIssue) {
					const repo = getRepo();
					if (!repo) {
						ctx.ui.notify("No repo found in .pi/settings.json (supervisor.repo)", "error");
					} else {
						ctx.ui.notify(`Creating issue in ${repo}...`, "info");
						try {
							const wasteMatch = markdown.match(/\| Total waste \|.*?\(([\d.]+)%\)/);
							const wastePct = wasteMatch ? wasteMatch[1] : "?";
							const date = new Date().toISOString().slice(0, 10);
							const title = `Session Waste Report — ${date} (${wastePct}% waste)`;
							const result = createGhIssue(repo, title, markdown, sessionsDir);
							ctx.ui.notify(`Issue created: ${result}`, "info");
						} catch (err) {
							ctx.ui.notify(`Failed to create issue: ${(err as Error).message}`, "error");
						}
					}
				}

				// Ask about signal review issues (if review ran)
				if (report.review) {
					const hasRemovals = report.review.verdicts.some((v) => v.verdict === "remove");
					const hasAdditions = report.review.newSignals.length > 0;

					if (hasRemovals || hasAdditions) {
						const createSignalIssuesConfirm = await ctx.ui.confirm(
							"Create signal review issues?",
							`${hasRemovals ? "Detector removals proposed. " : ""}${hasAdditions ? "New detector proposals. " : ""}Create GitHub issues for detector changes?`,
						);

						if (createSignalIssuesConfirm) {
							const repo = getRepo();
							if (!repo) {
								ctx.ui.notify("No repo found in .pi/settings.json (supervisor.repo)", "error");
							} else {
								const urls = createSignalIssues(
									repo,
									report.review,
									report.totalSessions,
									sessionsDir,
								);
								if (urls.length > 0) {
									ctx.ui.notify(`Signal issues created: ${urls.join(", ")}`, "info");
								} else {
									ctx.ui.notify("No signal issues were created.", "info");
								}
							}
						}
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

			// Toggle
			if (cmd === "on") enabled = true;
			else if (cmd === "off") enabled = false;
			else enabled = !enabled;
			syncAdviceState();
			ctx.ui.notify(`Session advice: ${enabled ? "ON" : "OFF"} (applies to next session)`, "info");
		},
	});

	// ── Recovery: generate advice for past sessions missing .advice.md ──

	pi.on("session_start", async (_event, ctx) => {
		syncAdviceState();
		if (!enabled) return;

		const sm = ctx.sessionManager;
		const cwd = sm.getCwd();
		if (!cwd) return;

		const sessionsDir = path.resolve(cwd, ".pi", "sessions");
		if (!fs.existsSync(sessionsDir)) return;

		await backfillMissingAdvice(sessionsDir, sm.getSessionFile(), ctx.model, ctx.modelRegistry);
	});

	// ── Generate advice for current closing session ──

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enabled) return;

		await handleShutdown(ctx.sessionManager.getSessionFile(), ctx.model, ctx.modelRegistry);
	});

	// ── before_agent_start: inject past session waste lessons into system prompt ──

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!enabled) return;

		const cwd = process.cwd();
		const latestAdvicePath = path.resolve(cwd, ".pi", "sessions", "latest.advice.md");
		if (!fs.existsSync(latestAdvicePath)) return;

		try {
			const adviceContent = fs.readFileSync(latestAdvicePath, "utf-8");
			if (!adviceContent || adviceContent.includes("Clean session")) return;

			const actions: string[] = [];
			const lines = adviceContent.split("\n");
			let inActions = false;
			let actionCount = 0;

			for (const line of lines) {
				if (line.includes("### Recommended Actions")) {
					inActions = true;
					continue;
				}
				if (line.includes("### Waste Signals")) {
					inActions = false;
					continue;
				}
				if (inActions && line.startsWith("-")) {
					const actionText = line.replace(/^- [🔴🟡🟢]\s*\*\*(.*?)\*\*.*$/, "$1").trim();
					if (actionText && actionText.length > 10 && actionCount < 3) {
						actions.push(actionText);
						actionCount++;
					}
				}
			}

			if (actions.length === 0) {
				for (const line of lines) {
					if (line.startsWith("- `") && actionCount < 3) {
						const detail = line.slice(0, 200);
						actions.push(detail);
						actionCount++;
					}
				}
			}

			if (actions.length === 0) return;

			const top3 = actions
				.slice(0, 3)
				.map((a) => `  - ${a}`)
				.join("\n");
			const lessonsBlock = `\n\n⚠️ Past Session Lessons (from session advisor)\n${top3}\n`;

			return {
				systemPrompt: event.systemPrompt + lessonsBlock,
			};
		} catch {
			// Silently fail
		}
	});
}
