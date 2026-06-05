/**
 * advice-pipeline.ts — Waste-based cross-session advice pipeline
 *
 * Phases: parse → detect → (optionally) LLM-advise → render → write
 *
 * Pure detection (no pi dep). LLM advice requires model + modelRegistry.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import {
	parseJsonlFile,
	analyzeSession,
	buildSessionAnalysis,
	renderWasteSummary,
} from "./advisor.ts";
import type { SessionAnalysis, WasteSignal, SessionData } from "./advisor.ts";
import { generateAdvice, generateReportAdvice } from "./llm-advisor.ts";
import type {
	AdviceResult,
	AdviceAction,
	SignalReview,
	ModelLike as ModelRef,
	ModelRegistryLike as ModelRegistryRef,
} from "./llm-advisor.ts";
export type { ModelRef, ModelRegistryRef };
import { FIXES, DEFAULT_FIX } from "./fixes.ts";
import { SymlinkManager } from "./symlink-manager.ts";

// ── Types ──

export interface AggregatedSignal {
	signal: string;
	label: string;
	wastedTokens: number;
	wastedCost: number;
	occurrences: number;
	sessionsAffected: number;
	sessionIds: string[];
	details: string[];
}

export interface WasteReport {
	totalSessions: number;
	totalTokens: number;
	totalWasteTokens: number;
	totalWasteCost: number;
	wasteFraction: number;
	signals: AggregatedSignal[];
	perSession: SessionAnalysis[];
	adviceMd?: string; // LLM-generated cross-session advice
	review?: SignalReview; // LLM signal quality review (if enabled)
}

// ── AdvicePipeline ──

export class AdvicePipeline {
	private _symlinkManager: SymlinkManager;

	constructor() {
		this._symlinkManager = new SymlinkManager();
	}

	/** Expose symlink manager for standalone function access. */
	getSymlinkManager(): SymlinkManager {
		return this._symlinkManager;
	}

	/**
	 * Phase 1: Parse + Detect — read all JSONL files, run detectors.
	 */
	detect(sessionsDir: string): {
		files: string[];
		sessions: Map<string, SessionData>;
		analyses: SessionAnalysis[];
	} {
		const jsonlFiles = fs
			.readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"))
			.sort();

		const sessions = new Map<string, SessionData>();
		const analyses: SessionAnalysis[] = [];

		for (const file of jsonlFiles) {
			const jsonlPath = path.join(sessionsDir, file);
			try {
				const data = parseJsonlFile(jsonlPath);
				if (data) {
					sessions.set(file, data);
					const signals = analyzeSession(data);
					const meta = loadMetadata(sessionsDir, file);
					const analysis = buildSessionAnalysis(data, signals, meta);
					analyses.push(analysis);
				}
			} catch {
				// skip unparseable
			}
		}

		return { files: [...sessions.keys()], sessions, analyses };
	}

	/**
	 * Phase 2: Aggregate — collect all signals across sessions.
	 */
	aggregate(analyses: SessionAnalysis[]): WasteReport {
		const totalTokens = analyses.reduce((s, a) => s + a.totalTokens, 0);
		const totalWasteTokens = analyses.reduce((s, a) => s + a.totalWasteTokens, 0);
		const totalWasteCost = analyses.reduce((s, a) => s + a.totalWasteCost, 0);

		// Aggregate by signal key
		const bySignal = new Map<
			string,
			{
				signal: string;
				label: string;
				wastedTokens: number;
				wastedCost: number;
				occurrences: number;
				sessionIds: Set<string>;
				details: string[];
			}
		>();

		for (const a of analyses) {
			for (const s of a.wasteBySignal) {
				if (!bySignal.has(s.signal)) {
					bySignal.set(s.signal, {
						signal: s.signal,
						label: s.label,
						wastedTokens: 0,
						wastedCost: 0,
						occurrences: 0,
						sessionIds: new Set(),
						details: [],
					});
				}
				const agg = bySignal.get(s.signal)!;
				agg.wastedTokens += s.wastedTokens;
				agg.wastedCost += s.wastedCost;
				agg.occurrences += s.occurrences;
				agg.sessionIds.add(a.sessionId);
				agg.details.push(...s.details);
			}
		}

		const signals: AggregatedSignal[] = [...bySignal.values()]
			.map((s) => ({
				...s,
				sessionsAffected: s.sessionIds.size,
				sessionIds: [...s.sessionIds],
				details: [...new Set(s.details)].slice(0, 5), // top 5 unique details
			}))
			.sort((a, b) => b.wastedTokens - a.wastedTokens);

		return {
			totalSessions: analyses.length,
			totalTokens,
			totalWasteTokens,
			totalWasteCost,
			wasteFraction: totalTokens > 0 ? totalWasteTokens / totalTokens : 0,
			signals,
			perSession: analyses,
		};
	}

	/**
	 * Phase 3: Render — build markdown report.
	 */
	render(report: WasteReport): string {
		const sections: string[] = [];

		const pct = report.totalTokens > 0 ? (report.wasteFraction * 100).toFixed(1) : "0";
		const costDisplay =
			report.totalWasteCost > 0.001 ? `$${report.totalWasteCost.toFixed(4)}` : "< $0.001";

		sections.push(`# Session Waste Report`);
		sections.push(``);
		sections.push(`Generated: ${new Date().toISOString()}`);
		sections.push(``);
		sections.push(`| Metric | Value |`);
		sections.push(`|--------|-------|`);
		sections.push(`| Sessions analyzed | ${report.totalSessions} |`);
		sections.push(`| Total tokens | ${report.totalTokens.toLocaleString()} |`);
		sections.push(`| Total waste | ${report.totalWasteTokens.toLocaleString()} tokens (${pct}%) |`);
		sections.push(`| Waste cost | ${costDisplay} |`);
		sections.push(``);

		// LLM advice section (if generated)
		if (report.adviceMd) {
			sections.push(`## AI-Generated Advice`);
			sections.push(``);
			sections.push(report.adviceMd);
			sections.push(``);
			sections.push(`---`);
			sections.push(``);
		}

		// Waste signals summary
		sections.push(`## Waste by Signal`);
		sections.push(``);
		sections.push(`| Signal | Waste (tokens) | % of Waste | Sessions | Occ |`);
		sections.push(`|--------|----------------|------------|----------|-----|`);

		for (const s of report.signals) {
			const pctOfWaste =
				report.totalWasteTokens > 0
					? ((s.wastedTokens / report.totalWasteTokens) * 100).toFixed(1)
					: "0";
			sections.push(
				`| \`${s.signal}\` | ${s.wastedTokens.toLocaleString()} | ${pctOfWaste}% | ${s.sessionsAffected}/${report.totalSessions} | ${s.occurrences} |`,
			);
		}
		sections.push(``);

		// Detail per signal
		sections.push(`## Signal Details`);
		sections.push(``);
		for (const s of report.signals) {
			sections.push(`### ${s.label} (\`${s.signal}\`)`);
			sections.push(``);
			sections.push(
				`**Wasted:** ${s.wastedTokens.toLocaleString()} tokens across ${s.sessionsAffected} sessions (${s.occurrences} occurrences)`,
			);
			sections.push(``);
			if (s.details.length > 0) {
				sections.push(`**Examples:**`);
				for (const d of s.details) {
					sections.push(`- ${d}`);
				}
				sections.push(``);
			}

			// Look up fix from fixes.ts
			const fix = FIXES[s.signal] ?? DEFAULT_FIX;
			sections.push(`**Fix idea:** ${fix.idea}`);
			sections.push(`**Effort:** ${fix.effort}`);
			sections.push(``);
			sections.push(`---`);
			sections.push(``);
		}

		// Per-session table
		sections.push(`## Per-Session Breakdown`);
		sections.push(``);
		sections.push(`| Session | Tokens | Waste % | Top Signal | LLM Advice |`);
		sections.push(`|---------|--------|---------|------------|------------|`);

		for (const sa of report.perSession) {
			const topSignal = sa.wasteBySignal[0];
			const topName = topSignal ? topSignal.signal : "—";
			const wastePct = (sa.wasteFraction * 100).toFixed(0);
			sections.push(
				`| \`${sa.sessionId.slice(0, 8)}\` | ${sa.totalTokens.toLocaleString()} | ${wastePct}% | ${topName} | — |`,
			);
		}
		sections.push(``);

		// Signal Review section (if LLM review ran)
		if (report.review) {
			sections.push(`## Signal Quality Review`);
			sections.push(``);
			sections.push(report.review.summary);
			sections.push(``);

			const toRemove = report.review.verdicts.filter((v) => v.verdict === "remove");
			const toRefine = report.review.verdicts.filter((v) => v.verdict === "refine");
			const newDetectors = report.review.newSignals;

			if (toRemove.length > 0) {
				sections.push(`### Detectors to Remove`);
				sections.push(``);
				for (const v of toRemove) {
					sections.push(
						`- **\`${v.signal}\`** — ${v.reason} (false-positive risk: ${v.falsePositiveRisk})`,
					);
				}
				sections.push(``);
			}

			if (toRefine.length > 0) {
				sections.push(`### Detectors to Refine`);
				sections.push(``);
				for (const v of toRefine) {
					sections.push(`- **\`${v.signal}\`** — ${v.reason}`);
					if (v.refinementSuggestion) sections.push(`  → ${v.refinementSuggestion}`);
				}
				sections.push(``);
			}

			if (newDetectors.length > 0) {
				sections.push(`### Proposed New Detectors`);
				sections.push(``);
				for (const n of newDetectors) {
					sections.push(`- **\`${n.signal}\`** — ${n.description}`);
					sections.push(`  Why: ${n.reason}`);
					sections.push(`  How: ${n.detectionApproach}`);
				}
				sections.push(``);
			}

			sections.push(`---`);
			sections.push(``);
		}

		// Fix reference
		sections.push(`## Fix Reference`);
		sections.push(``);
		sections.push(`| Signal | Effort | Fix Idea |`);
		sections.push(`|--------|--------|----------|`);
		for (const s of report.signals) {
			const fix = FIXES[s.signal] ?? DEFAULT_FIX;
			sections.push(`| \`${s.signal}\` | ${fix.effort} | ${fix.idea} |`);
		}
		sections.push(``);

		sections.push(`---`);
		sections.push(``);
		sections.push(`*Report auto-generated. Run \`/session-advice report\` to refresh.*`);
		sections.push(``);

		return sections.join("\n");
	}

	/**
	 * Write report to file.
	 */
	write(sessionsDir: string, markdown: string): string {
		const reportPath = path.join(sessionsDir, "advice-report.md");
		fs.writeFileSync(reportPath, markdown, "utf-8");
		return reportPath;
	}

	/**
	 * Full report pipeline: detect → aggregate → (optional LLM advice + review) → render → write.
	 * Returns report data including signal review for GitHub issue creation.
	 */
	async generateReport(
		sessionsDir: string,
		model?: ModelRef,
		modelRegistry?: ModelRegistryRef,
	): Promise<{ markdown: string; reportPath: string; report: WasteReport }> {
		const { analyses } = this.detect(sessionsDir);
		const report = this.aggregate(analyses);

		// Try LLM advice + signal review if model available
		if (model && modelRegistry && analyses.length > 0) {
			try {
				const { reportMd, review } = await generateReportAdvice(analyses, model, modelRegistry);
				report.adviceMd = reportMd;
				report.review = review;
			} catch (err) {
				const msg = (err as Error).message;
				report.adviceMd = `*LLM advice generation failed: ${msg.slice(0, 200)}*`;
			}
		}

		const markdown = this.render(report);
		const reportPath = this.write(sessionsDir, markdown);
		return { markdown, reportPath, report };
	}
}

// ── Standalone functions (backward compatible exports) ──

const defaultPipeline = new AdvicePipeline();

/**
 * Generate cross-session waste report (detection only, no LLM).
 */
export function generateAdviceReport(sessionsDir: string): string {
	const { analyses } = defaultPipeline.detect(sessionsDir);
	const report = defaultPipeline.aggregate(analyses);
	return defaultPipeline.render(report);
}

// ── Session advice writing ──

/**
 * Generate .advice.md for a single session .jsonl file.
 * If model + modelRegistry provided, includes LLM-generated actions.
 */
export async function writeAdvice(
	jsonlPath: string,
	advicePath: string,
	symlinkDir: string,
	model?: ModelRef,
	modelRegistry?: ModelRegistryRef,
	updateSymlink: boolean = true,
): Promise<void> {
	try {
		const data = parseJsonlFile(jsonlPath);
		if (!data) return;

		const signals = analyzeSession(data);
		// Try to load metadata for accurate token counts
		const sessionDir = path.dirname(jsonlPath);
		const baseName = path.basename(jsonlPath, ".jsonl");
		const metaPath = path.join(sessionDir, `${baseName}.metadata.json`);
		let meta: { totalTokens?: number; totalCost?: number } | undefined;
		try {
			const raw = fs.readFileSync(metaPath, "utf-8");
			const m = JSON.parse(raw);
			meta = {
				totalTokens: m.tokens?.total ?? m.totalTokens,
				totalCost: m.cost ?? m.totalCost,
			};
		} catch {
			/* metadata optional */
		}

		const analysis = buildSessionAnalysis(data, signals, meta);
		let llmAdvice: AdviceResult | null = null;

		// Try LLM advice
		if (model && modelRegistry) {
			try {
				llmAdvice = await generateAdvice(analysis, model, modelRegistry);
			} catch (err) {
				// LLM failed — proceed without
				const msg = (err as Error).message;
				console.error(`[session-advice] LLM advice failed: ${msg}`);
			}
		}

		const md = renderSessionAdvice(analysis, llmAdvice);
		fs.writeFileSync(advicePath, md, "utf-8");

		if (updateSymlink) {
			defaultPipeline.getSymlinkManager().updateLatestAdviceSymlink(symlinkDir, advicePath);
		}
	} catch (err) {
		console.error(`[session-advice] Failed for ${jsonlPath}: ${(err as Error).message}`);
	}
}

/**
 * Render per-session advice markdown.
 */
function renderSessionAdvice(analysis: SessionAnalysis, llmAdvice: AdviceResult | null): string {
	const sections: string[] = [];

	sections.push(`# Advice: ${analysis.sessionId}`);
	sections.push(``);
	sections.push(`**Generated:** ${new Date().toISOString()}`);
	sections.push(``);
	sections.push(`| Metric | Value |`);
	sections.push(`|--------|-------|`);
	sections.push(`| Total tokens | ${analysis.totalTokens.toLocaleString()} |`);
	sections.push(
		`| Total wasted | ${analysis.totalWasteTokens.toLocaleString()} (${(analysis.wasteFraction * 100).toFixed(1)}%) |`,
	);
	sections.push(`| Total cost | $${analysis.totalCost.toFixed(6)} |`);
	sections.push(``);

	if (llmAdvice) {
		sections.push(`## AI Advice`);
		sections.push(``);
		sections.push(llmAdvice.summary);
		sections.push(``);

		if (llmAdvice.actions.length > 0) {
			sections.push(`### Recommended Actions`);
			sections.push(``);
			for (const a of llmAdvice.actions) {
				const icon = a.effort === "Low" ? "🟢" : a.effort === "Medium" ? "🟡" : "🔴";
				sections.push(`- ${icon} **${a.action}** — ${a.expectedSavingsLabel}`);
				if (a.code) sections.push(`  \`\`\`\n  ${a.code}\n  \`\`\``);
			}
			sections.push(``);
		}
	}

	if (analysis.wasteBySignal.length > 0) {
		sections.push(`### Waste Signals`);
		sections.push(``);
		sections.push(`| Signal | Wasted Tokens | % of Waste | Occurrences |`);
		sections.push(`|--------|---------------|------------|-------------|`);
		for (const s of analysis.wasteBySignal) {
			const pct =
				analysis.totalWasteTokens > 0
					? ((s.wastedTokens / analysis.totalWasteTokens) * 100).toFixed(1)
					: "0";
			sections.push(
				`| \`${s.signal}\` | ${s.wastedTokens.toLocaleString()} | ${pct}% | ${s.occurrences} |`,
			);
		}
		sections.push(``);

		sections.push(`### Details`);
		sections.push(``);
		for (const s of analysis.wasteBySignal) {
			if (s.details.length === 0) continue;
			sections.push(`**${s.label}:**`);
			for (const d of s.details) {
				sections.push(`- ${d}`);
			}
			sections.push(``);
		}
	} else {
		sections.push(`*No waste signals detected. Clean session.*`);
		sections.push(``);
	}

	return sections.join("\n");
}

/**
 * Backfill .advice.md for past session .jsonl files that lack one.
 */
export async function backfillMissingAdvice(
	sessionsDir: string,
	currentSessionFile?: string | null,
	model?: ModelRef,
	modelRegistry?: ModelRegistryRef,
): Promise<void> {
	let files: string[] = [];
	try {
		files = fs
			.readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"));
	} catch {
		return;
	}

	for (const file of files) {
		const jsonlPath = path.join(sessionsDir, file);
		if (currentSessionFile && jsonlPath === currentSessionFile) continue;

		const prefix = file.replace(/\.jsonl$/, "");
		const advicePath = path.join(sessionsDir, `${prefix}.advice.md`);
		if (fs.existsSync(advicePath)) continue;

		await writeAdvice(jsonlPath, advicePath, sessionsDir, model, modelRegistry, false);
	}
}

/**
 * Handle session shutdown: write .advice.md for the closing session.
 */
export async function handleShutdown(
	sessionFile: string | null | undefined,
	model?: ModelRef,
	modelRegistry?: ModelRegistryRef,
): Promise<void> {
	if (!sessionFile) return;

	const sessionDir = path.dirname(sessionFile);
	const advicePath = sessionFile.replace(/\.jsonl$/, ".advice.md");

	if (fs.existsSync(advicePath)) return;

	await writeAdvice(sessionFile, advicePath, sessionDir, model, modelRegistry);
}

/**
 * Create a GitHub issue using gh CLI.
 */
export function createGhIssue(
	repo: string,
	title: string,
	body: string,
	sessionsDir: string,
	execFn: (
		cmd: string,
		opts: { cwd: string; timeout: number; encoding: string },
	) => string | Buffer = execSync,
): string {
	const bodyFile = path.join(sessionsDir, ".gh-issue-body.tmp");
	try {
		fs.writeFileSync(bodyFile, body, "utf-8");

		const raw = execFn(
			`gh issue create --repo "${repo}" --title "${title}" --body-file "${bodyFile}"`,
			{
				cwd: process.cwd(),
				timeout: 30_000,
				encoding: "utf-8",
			},
		);
		return (typeof raw === "string" ? raw : raw.toString("utf-8")).trim();
	} finally {
		try {
			if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
		} catch {
			/* best-effort */
		}
	}
}

/**
 * Helper: create a single GitHub issue for a signal and push the URL to results.
 * Handles body joining, issue creation via createGhIssue, and error logging.
 */
function createIssueForSignal(
	repo: string,
	title: string,
	body: string[],
	sessionsDir: string,
	signal: string,
	results: string[],
	execFn?: (
		cmd: string,
		opts: { cwd: string; timeout: number; encoding: string },
	) => string | Buffer,
): void {
	try {
		const url = createGhIssue(repo, title, body.join("\n"), sessionsDir, execFn);
		results.push(url);
	} catch (err) {
		console.error(
			`[session-advice] Failed to create issue for \`${signal}\`: ${(err as Error).message}`,
		);
	}
}

/**
 * Create GitHub issues from signal review verdicts.
 * For detectors marked "remove" → issue to remove bad detector.
 * For proposed new detectors → issue to add good detector.
 * Returns array of created issue URLs.
 */
export function createSignalIssues(
	repo: string,
	review: SignalReview,
	analysesCount: number,
	sessionsDir: string,
	execFn?: (
		cmd: string,
		opts: { cwd: string; timeout: number; encoding: string },
	) => string | Buffer,
): string[] {
	const results: string[] = [];
	const date = new Date().toISOString().slice(0, 10);

	// Issues for detectors to remove
	for (const v of review.verdicts) {
		if (v.verdict !== "remove") continue;

		const title = `[session-advice] Remove detector \`${v.signal}\` — ${v.label}`;
		const body = [
			`## Detector Removal Request: \`${v.signal}\``,
			``,
			`**Reviewed:** ${date}`,
			`**Based on:** ${analysesCount} sessions`,
			``,
			`### Reason for Removal`,
			v.reason,
			``,
			`### False-Positive Risk`,
			v.falsePositiveRisk,
			``,
			`### What to Do`,
			`1. Remove \`${v.signal}\` detector from \`.pi/extensions/session-advice/advisor.ts\``,
			`2. Remove corresponding fix entry from \`.pi/extensions/session-advice/fixes.ts\``,
			`3. Run tests to verify no regressions`,
			``,
			`---`,
			`*Auto-generated by session-advice signal review.*`,
		];

		createIssueForSignal(repo, title, body, sessionsDir, v.signal, results, execFn);
	}

	// Issues for proposed new detectors
	for (const n of review.newSignals) {
		const title = `[session-advice] Add detector \`${n.signal}\` — ${n.label}`;
		const body = [
			`## New Detector Proposal: \`${n.signal}\``,
			``,
			`**Proposed:** ${date}`,
			`**Based on:** ${analysesCount} sessions`,
			``,
			`### Description`,
			n.description,
			``,
			`### Value`,
			n.reason,
			``,
			`### Estimated Impact`,
			n.estimatedValue,
			``,
			`### Implementation Approach`,
			n.detectionApproach,
			``,
			`### What to Do`,
			`1. Implement \`${n.signal}\` detector in \`.pi/extensions/session-advice/advisor.ts\``,
			`2. Add test cases in \`.pi/extensions/session-advice/test/\``,
			`3. Add fix entry in \`.pi/extensions/session-advice/fixes.ts\``,
			``,
			`---`,
			`*Auto-generated by session-advice signal review.*`,
		];

		createIssueForSignal(repo, title, body, sessionsDir, n.signal, results, execFn);
	}

	return results;
}

// ── Helpers ──

/**
 * Load metadata.json for a session file to get actual token counts.
 */
function loadMetadata(
	sessionsDir: string,
	jsonlFile: string,
): { totalTokens?: number; totalCost?: number } | undefined {
	try {
		const prefix = jsonlFile.replace(/\.jsonl$/, "");
		const metaPath = path.join(sessionsDir, `${prefix}.metadata.json`);
		if (!fs.existsSync(metaPath)) return undefined;
		const raw = fs.readFileSync(metaPath, "utf-8");
		const m = JSON.parse(raw);
		return {
			totalTokens: m.tokens?.total ?? m.totalTokens,
			totalCost: m.cost ?? m.totalCost,
		};
	} catch {
		return undefined;
	}
}
