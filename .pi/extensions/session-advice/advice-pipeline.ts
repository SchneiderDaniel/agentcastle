/**
 * advice-pipeline.ts — Cross-session advice report pipeline
 *
 * Phases: parse → analyze → aggregate → render → write
 *
 * Pure logic, no pi dependency. Used by the session-advice extension
 * (/session-advice report command) and potentially by headless scripts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { parseJsonlFile, analyzeSession, renderAdviceToMarkdown } from "./advisor.ts";
import type { AdviceEntry, AdviceResult, SessionData } from "./advisor.ts";
import { FIXES, DEFAULT_FIX } from "./fixes.ts";
import type { FixSuggestion } from "./fixes.ts";
import { SymlinkManager } from "./symlink-manager.ts";

// ── Types ──

export interface CategoryGroup {
	category: string;
	issues: Array<{ session: string; detail: string; severity: string }>;
}

export interface CategorySummary {
	category: string;
	priority: string;
	severity: string;
	sessionsAffected: number;
	issues: number;
	sessionIds: string[];
	example: string;
	sampleDetails: string[];
	fixIdea: string;
	effort: string;
}

// ── AdvicePipeline ──

export class AdvicePipeline {
	private symlinkManager: SymlinkManager;

	constructor() {
		this.symlinkManager = new SymlinkManager();
	}

	/**
	 * Phase 1: Parse — read all JSONL files from sessionsDir,
	 * parse them into SessionData objects.
	 */
	parse(sessionsDir: string): { files: string[]; sessions: Map<string, SessionData> } {
		const jsonlFiles = fs
			.readdirSync(sessionsDir)
			.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"))
			.sort();

		const sessions = new Map<string, SessionData>();

		for (const file of jsonlFiles) {
			const jsonlPath = path.join(sessionsDir, file);
			try {
				const data = parseJsonlFile(jsonlPath);
				if (data) {
					sessions.set(file, data);
				}
			} catch {
				// skip unparseable files
			}
		}

		return { files: jsonlFiles, sessions };
	}

	/**
	 * Phase 2: Analyze — run analyzeSession on each parsed session.
	 */
	analyze(
		sessions: Map<string, SessionData>,
	): Map<string, { sessionId: string; result: AdviceResult }> {
		const results = new Map<string, { sessionId: string; result: AdviceResult }>();

		for (const [file, data] of sessions) {
			const result = analyzeSession(data);
			results.set(file, { sessionId: data.sessionId, result });
		}

		return results;
	}

	/**
	 * Phase 3: Aggregate — collect all issues across sessions,
	 * group by category, build recency map, compute priority,
	 * and map to fix suggestions.
	 */
	aggregate(
		files: string[],
		sessions: Map<string, SessionData>,
		analysisResults: Map<string, { sessionId: string; result: AdviceResult }>,
	): {
		allIssues: Array<{ session: string; entry: AdviceEntry }>;
		categories: CategorySummary[];
		sessionRecency: Map<string, number>;
	} {
		const allIssues: Array<{ session: string; entry: AdviceEntry }> = [];

		for (const [, { sessionId, result }] of analysisResults) {
			if (result.entries.length === 0) continue;

			for (const entry of result.entries) {
				allIssues.push({
					session: sessionId,
					entry,
				});
			}
		}

		// Group by category
		const byCategory = new Map<string, CategoryGroup>();
		for (const { session, entry } of allIssues) {
			if (!byCategory.has(entry.category)) {
				byCategory.set(entry.category, { category: entry.category, issues: [] });
			}
			byCategory.get(entry.category)!.issues.push({
				session,
				detail: entry.detail,
				severity: entry.severity,
			});
		}

		// Session recency map: keyed by header.id, value 0 (oldest) to 1 (newest)
		const sessionRecency = new Map<string, number>();
		files.forEach((f, i) => {
			const sessionData = sessions.get(f);
			if (sessionData) {
				sessionRecency.set(sessionData.sessionId, i / Math.max(files.length - 1, 1));
			} else {
				// Fallback: key by filename for unparseable headers
				sessionRecency.set(f.replace(/\.jsonl$/, ""), i / Math.max(files.length - 1, 1));
			}
		});

		// Build category summaries
		const categories: CategorySummary[] = [];
		for (const g of byCategory.values()) {
			const maxSev = g.issues.reduce(
				(acc, i) => {
					const w = i.severity === "error" ? 2 : i.severity === "warning" ? 1 : 0;
					return w > acc.w ? { sev: i.severity, w } : acc;
				},
				{ sev: "info" as string, w: 0 },
			).sev;

			const sessions = [...new Set(g.issues.map((i) => i.session))];

			// Recency-weighted reach
			const recencyWeightedIssues = g.issues.reduce((sum, i) => {
				const recencyFactor = sessionRecency.get(i.session) ?? 0.5;
				return sum + (0.5 + recencyFactor * 0.5);
			}, 0);
			const reach = sessions.length * recencyWeightedIssues;
			const priority = reach >= 50 ? "High" : reach >= 10 ? "Medium" : "Low";
			const fix = FIXES[g.category] ?? DEFAULT_FIX;

			const sampleDetails = [...new Set(g.issues.map((i) => i.detail))].slice(0, 3);
			const firstDetail = g.issues.find((i) => i.detail);
			const example = firstDetail?.detail?.replace(/\s*\(turn.*\)$/, "") ?? "—";

			categories.push({
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
			});
		}

		// Sort by priority
		categories.sort((a, b) => {
			const p: Record<string, number> = { High: 3, Medium: 2, Low: 1 };
			return (p[b.priority] ?? 0) - (p[a.priority] ?? 0);
		});

		return { allIssues, categories, sessionRecency };
	}

	/**
	 * Phase 4: Render — build markdown report string from aggregated data.
	 */
	render(
		files: string[],
		allIssues: Array<{ session: string; entry: AdviceEntry }>,
		categories: CategorySummary[],
	): string {
		const sections: string[] = [];

		// Count unique sessions with issues
		const sessionSet = new Set<string>();
		for (const { session } of allIssues) {
			sessionSet.add(session);
		}
		const totalSessions = files.length;

		sections.push(`# Session Advice Report`);
		sections.push(``);
		sections.push(`Generated: ${new Date().toISOString()}`);
		sections.push(``);
		sections.push(`| Metric | Value |`);
		sections.push(`|--------|-------|`);
		sections.push(`| Sessions analyzed | ${totalSessions} |`);
		sections.push(`| Sessions with issues | ${sessionSet.size} |`);
		sections.push(`| Clean sessions | ${totalSessions - sessionSet.size} |`);
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
		const byPriority: Record<string, CategorySummary[]> = {
			High: [],
			Medium: [],
			Low: [],
		};
		for (const c of categories) {
			byPriority[c.priority]?.push(c);
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

		// Findings per Session
		sections.push(`## Findings per Session`);
		sections.push(``);
		sections.push(`| Session | Count | Top Categories |`);
		sections.push(`|---------|-------|----------------|`);

		const perSession: Record<string, { count: number; cats: Record<string, number> }> = {};
		for (const { session, entry } of allIssues) {
			if (!perSession[session]) perSession[session] = { count: 0, cats: {} };
			perSession[session].count++;
			perSession[session].cats[entry.category] =
				(perSession[session].cats[entry.category] ?? 0) + 1;
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

	/**
	 * Phase 5: Write — write report markdown to file.
	 */
	write(sessionsDir: string, markdown: string): string {
		const reportPath = path.join(sessionsDir, "advice-report.md");
		fs.writeFileSync(reportPath, markdown, "utf-8");
		return reportPath;
	}

	/**
	 * Full report pipeline: parse → analyze → aggregate → render → write.
	 * Returns the generated markdown and the report path.
	 */
	generateReport(sessionsDir: string): { markdown: string; reportPath: string } {
		const { files, sessions } = this.parse(sessionsDir);
		const analysisResults = this.analyze(sessions);
		const { allIssues, categories } = this.aggregate(files, sessions, analysisResults);
		const markdown = this.render(files, allIssues, categories);
		const reportPath = this.write(sessionsDir, markdown);
		return { markdown, reportPath };
	}
}

// ── Standalone generateAdviceReport (backward compatible) ──

const defaultPipeline = new AdvicePipeline();

/**
 * Generate cross-session advice report.
 * Parses all JSONL files in sessionsDir, aggregates findings,
 * maps categories to fix ideas + effort estimates.
 *
 * Pure function — no side effects besides reading files. Exported for headless use.
 * Delegates to AdvicePipeline internally.
 */
export function generateAdviceReport(sessionsDir: string): string {
	return defaultPipeline.generateReport(sessionsDir).markdown;
}

// ── Symlink helper (delegates to SymlinkManager) ──

const defaultSymlinkManager = new SymlinkManager();

/**
 * Atomically update latest.advice.md symlink.
 * Uses tmp + rename pattern.
 */
function updateLatestAdviceSymlink(symlinkDir: string, targetFile: string): void {
	defaultSymlinkManager.updateLatestAdviceSymlink(symlinkDir, targetFile);
}

// ── Session advice writing ──

/**
 * Generate .advice.md for a session .jsonl file.
 */
export function writeAdvice(
	jsonlPath: string,
	advicePath: string,
	symlinkDir: string,
	updateSymlink: boolean = true,
): void {
	try {
		const data = parseJsonlFile(jsonlPath);
		if (!data) return;

		const result = analyzeSession(data);
		const md = renderAdviceToMarkdown(result);

		fs.writeFileSync(advicePath, md, "utf-8");

		if (updateSymlink) {
			updateLatestAdviceSymlink(symlinkDir, advicePath);
		}
	} catch (err) {
		console.error(`[session-advice] Failed for ${jsonlPath}: ${(err as Error).message}`);
	}
}

/**
 * Backfill .advice.md for past session .jsonl files that lack one.
 * Does NOT update latest.advice.md — that is reserved for session_shutdown.
 * Skips the current in-progress session (file may be incomplete).
 */
export function backfillMissingAdvice(
	sessionsDir: string,
	currentSessionFile?: string | null,
): void {
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

		// Skip if this is the current in-progress session
		if (currentSessionFile && jsonlPath === currentSessionFile) continue;

		const prefix = file.replace(/\.jsonl$/, "");
		const advicePath = path.join(sessionsDir, `${prefix}.advice.md`);

		if (fs.existsSync(advicePath)) continue;

		writeAdvice(jsonlPath, advicePath, sessionsDir, false);
	}
}

/**
 * Handle session shutdown: write .advice.md for the closing session
 * and update latest.advice.md symlink.
 * No-op if sessionFile is null/undefined or .advice.md already exists.
 */
export function handleShutdown(sessionFile: string | null | undefined): void {
	if (!sessionFile) return;

	const sessionDir = path.dirname(sessionFile);
	const advicePath = sessionFile.replace(/\.jsonl$/, ".advice.md");

	if (fs.existsSync(advicePath)) return;

	writeAdvice(sessionFile, advicePath, sessionDir);
}

/**
 * Create a GitHub issue using gh CLI.
 * Writes body to a temp file, runs `gh issue create`, and cleans up in finally.
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
		const result = (typeof raw === "string" ? raw : raw.toString("utf-8")).trim();

		return result;
	} finally {
		// Clean up temp file — delete even if execFn throws
		try {
			if (fs.existsSync(bodyFile)) {
				fs.unlinkSync(bodyFile);
			}
		} catch {
			/* ok — best-effort cleanup */
		}
	}
}

// ── Helpers ──

function short(s: string, n: number): string {
	if (s.length <= n) return s;
	return s.slice(0, n - 3) + "...";
}
