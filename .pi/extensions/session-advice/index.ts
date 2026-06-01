/**
 * session-advice — Session advice extension
 *
 * Generates .advice.md alongside .jsonl session files.
 * Analyzes session for inefficient patterns and produces
 * actionable recommendations for the agent.
 *
 * Analysis logic in advisor.ts — shared with post-hoc script.
 * Report pipeline in advice-pipeline.ts.
 * Symlink management in symlink-manager.ts.
 * Fix constants in fixes.ts.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { dirname } from "node:path";

// ── Shared extension state writer (file-based to avoid dual-module hazard) ──

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
		// Best-effort, don't crash extension
	}
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AdvicePipeline } from "./advice-pipeline.ts";
import { backfillMissingAdvice, handleShutdown, createGhIssue } from "./advice-pipeline.ts";

// ── Re-exports for backward compatibility (tests import these) ──

export {
	generateAdviceReport,
	writeAdvice,
	backfillMissingAdvice,
	handleShutdown,
	createGhIssue,
} from "./advice-pipeline.ts";

const pipeline = new AdvicePipeline();

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

				ctx.ui.notify("Generating session advice report...", "info");

				const { markdown, reportPath } = pipeline.generateReport(sessionsDir);

				ctx.ui.notify(`Report written: ${reportPath}`, "info");

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
						// Count findings for title
						const findingMatch = markdown.match(/\*\*Total findings:\*\* (\d+)/);
						const findingCount = findingMatch ? findingMatch[1] : "?";
						const date = new Date().toISOString().slice(0, 10);
						const title = `Session Advice Report — ${date} (${findingCount} findings)`;

						const result = createGhIssue(repo, title, markdown, sessionsDir);

						ctx.ui.notify(`Issue created: ${result}`, "info");
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

		backfillMissingAdvice(sessionsDir, sm.getSessionFile());
	});

	// ── Generate advice for current closing session ──

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!enabled) return;

		handleShutdown(ctx.sessionManager.getSessionFile());
	});

	// ── before_agent_start: inject past session lessons into system prompt ──

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!enabled) return;

		// Read latest.advice.md for past lessons
		const cwd = process.cwd();
		const latestAdvicePath = path.resolve(cwd, ".pi", "sessions", "latest.advice.md");
		if (!fs.existsSync(latestAdvicePath)) return;

		try {
			const adviceContent = fs.readFileSync(latestAdvicePath, "utf-8");
			if (!adviceContent || adviceContent.includes("No issues")) return;

			// Extract top 3 findings by scanning for ### entries with severity icons
			const findings: string[] = [];
			const lines = adviceContent.split("\n");
			let currentCategory = "";

			for (const line of lines) {
				if (/^### [⚠️⚡ℹ️]/.test(line)) {
					currentCategory = line.replace(/^### [⚠️⚡ℹ️] /, "").trim();
				} else if (currentCategory && line.startsWith("- **Detail:**")) {
					const detail = line.replace("- **Detail:** ", "").trim().slice(0, 200);
					findings.push(`- [${currentCategory}] ${detail}`);
					currentCategory = "";
				}
			}

			if (findings.length === 0) return;

			const top3 = findings
				.slice(0, 3)
				.map((f) => `  ${f}`)
				.join("\n");
			const lessonsBlock = `\n\n⚠️ Past Session Lessons\n${top3}\n`;

			return {
				systemPrompt: event.systemPrompt + lessonsBlock,
			};
		} catch {
			// Silently fail — do not block agent start
		}
	});
}
