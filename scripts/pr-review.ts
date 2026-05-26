#!/usr/bin/env node

/// <reference types="node" />

/**
 * pr-review.ts — Automated PR review for external contributor PRs.
 *
 * Fetches PR via gh CLI, runs security/quality checks, outputs a structured
 * review comment. With --post, posts the comment to the PR.
 *
 * Usage:
 *   npx tsx scripts/pr-review.ts <pr-number>              # print comment to stdout
 *   npx tsx scripts/pr-review.ts <pr-number> --show        # show in less/pager
 *   npx tsx scripts/pr-review.ts <pr-number> --post        # print + post to PR
 *   npx tsx scripts/pr-review.ts <pr-number> --json        # output as JSON
 *
 * Designed to be called by the pr-review pi skill or run manually.
 *
 * @packageDocumentation
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Types ──

interface PrInfo {
	number: number;
	title: string;
	author: string;
	authorAssociation: string;
	body: string;
	baseRefName: string;
	headRefName: string;
	state: string;
	mergeable: string;
	commits: { totalCount: number };
	additions: number;
	deletions: number;
	changedFiles: number;
	files: Array<{ path: string; status: string }>;
	isCrossRepository: boolean;
}

interface PrComment {
	author: string;
	body: string;
	createdAt: string;
	isMinimized: boolean;
}

interface CheckResult {
	name: string;
	status: "✅" | "⚠️" | "❌" | "⏭️";
	details: string;
}

// ── Helpers ──

function gh(args: string[], opts?: { timeout?: number }): string {
	const result = execSync(`gh ${args.join(" ")}`, {
		encoding: "utf-8",
		maxBuffer: 10 * 1024 * 1024,
		timeout: opts?.timeout ?? 30_000,
	});
	return result.trim();
}

function ghJson<T>(args: string[], opts?: { timeout?: number }): T {
	const out = gh(args, opts);
	if (!out) throw new Error("gh returned empty output");
	return JSON.parse(out) as T;
}

function ghPrView(prNumber: number): PrInfo {
	return ghJson<PrInfo>([
		"pr",
		"view",
		String(prNumber),
		"--json",
		"number,title,author,authorAssociation,body,baseRefName,headRefName,state,mergeable,commits,additions,deletions,changedFiles,files,isCrossRepository",
	]);
}

/** Fetch all non-minimized comments on the PR */
function getPrComments(prNumber: number): PrComment[] {
	try {
		const raw = gh([
			"pr",
			"view",
			String(prNumber),
			"--json",
			"comments",
			"--jq",
			".comments[] | {author: .author.login, body: .body, createdAt: .createdAt, isMinimized: .isMinimized}",
		]);
		if (!raw) return [];
		// gh --jq returns one JSON object per line
		const lines = raw.split("\n").filter((l) => l.trim());
		const comments: PrComment[] = [];
		for (const line of lines) {
			try {
				const c = JSON.parse(line) as PrComment;
				if (!c.isMinimized) comments.push(c);
			} catch {
				// skip malformed lines
			}
		}
		return comments;
	} catch {
		return [];
	}
}

/** Get the raw diff as a string */
function getDiff(prNumber: number): string {
	try {
		return gh(["pr", "diff", String(prNumber), "--color", "never"], { timeout: 60_000 });
	} catch {
		return "";
	}
}

/** Check if a string matches any of the patterns */
function hasPattern(text: string, patterns: RegExp[]): boolean {
	return patterns.some((p) => p.test(text));
}

/** Count pattern matches in text */
function countPattern(text: string, pattern: RegExp): number {
	const matches = text.match(pattern);
	return matches ? matches.length : 0;
}

/** Safely run a shell command and return { stdout, code } */
function tryExec(
	cmd: string,
	opts?: { timeout?: number },
): { stdout: string; code: number; error?: string } {
	try {
		const stdout = execSync(cmd, {
			encoding: "utf-8",
			timeout: opts?.timeout ?? 30_000,
			maxBuffer: 10 * 1024 * 1024,
		});
		return { stdout: stdout.trim(), code: 0 };
	} catch (err: unknown) {
		const e = err as Error & { stderr?: string; stdout?: string; status?: number };
		return {
			stdout: (e.stdout as string) || "",
			code: e.status ?? 1,
			error: e.stderr || e.message,
		};
	}
}

// ── Automated Checks ──

// ── Prompt Injection Defense ──

/** Patterns indicative of prompt injection attempts */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{
		pattern:
			/ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|directions|prompts|commands)/gi,
		label: "ignore-prior-instructions",
	},
	{ pattern: /forget\s+(all\s+)?(previous|prior|above)/gi, label: "forget-prior-instructions" },
	{
		pattern: /you\s+(are|were)\s+(not\s+)?(instructed|told|asked)/gi,
		label: "override-instructions",
	},
	{
		pattern: /disregard\s+(all\s+)?(previous|prior|above|safety|rules)/gi,
		label: "disregard-rules",
	},
	{
		pattern: /new\s+(instructions|directions|prompt|command)\s*[:：]/gi,
		label: "new-instructions-attempt",
	},
	{
		pattern: /override\s+(your|the)\s+(instructions|prompt|guidelines|constraints)/gi,
		label: "override-prompt",
	},
	{ pattern: /you\s+(must|have to|need to)\s+(ignore|bypass|skip)/gi, label: "force-bypass" },
	{ pattern: /say\s+"([^"]+)"\s+(and\s+)?(you\s+)?(will|should)/gi, label: "forced-output" },
	{ pattern: /output\s+(only|just|solely)\s+(the\s+)?word/gi, label: "forced-format" },
	{
		pattern:
			/act\s+(as\s+)?(if|like)\s+(you\s+)?(are|were)\s+(a\s+)?(different|new|unconstrained|jailbreak)/gi,
		label: "role-play-bypass",
	},
	{ pattern: /DAN|jailbreak|prompt\s*injection|ignore\s*previous/i, label: "known-attack-keyword" },
	{ pattern: /```\s*\n?\s*(system|user|assistant)\s*[:：]/gi, label: "role-spoofing-markdown" },
	{
		pattern: /<\s*(system|user|assistant)\s*>.*<\s*\/\s*(system|user|assistant)\s*>/gi,
		label: "role-spoofing-tags",
	},
];

/** Sanitize untrusted content by stripping known injection patterns */
function sanitizeUntrustedContent(
	text: string,
	source: string,
): { sanitized: string; flags: string[] } {
	if (!text) return { sanitized: "", flags: [] };
	const flags: string[] = [];
	let result = text;

	for (const { pattern, label } of INJECTION_PATTERNS) {
		const matches = result.match(pattern);
		if (matches && matches.length > 0) {
			flags.push(`${label} (${source})`);
			// Strip the matched pattern — replace with a safety marker
			result = result.replace(pattern, (match) => `[redacted:${label}] `);
		}
	}

	return { sanitized: result, flags };
}

/** Check PR body + comments for prompt injection attempts */
function checkPromptInjection(pr: PrInfo, comments: PrComment[]): CheckResult {
	const flags: string[] = [];

	// Check PR body
	const bodyResult = sanitizeUntrustedContent(pr.body, "PR body");
	flags.push(...bodyResult.flags);

	// Check all comments
	for (const c of comments) {
		const commentResult = sanitizeUntrustedContent(c.body, `comment by @${c.author}`);
		flags.push(...commentResult.flags);
	}

	if (flags.length > 0) {
		return {
			name: "Prompt injection check",
			status: "❌",
			details: `Potential injection patterns in: ${flags.join("; ")}`,
		};
	}

	return {
		name: "Prompt injection check",
		status: "✅",
		details: "No injection patterns detected",
	};
}

/** Wraps untrusted user content in safety-delimited block */
function wrapUntrustedContent(content: string, sourceLabel: string): string {
	// Clear delimiters identifying content as untrusted — OWASP segregation strategy
	return `\n--- BEGIN ${sourceLabel.toUpperCase()} (untrusted external content) ---\n${content}\n--- END ${sourceLabel.toUpperCase()} ---\n`;
}

/** Apply sanitization to pr body in-place, return flags */
function sanitizePrContent(pr: PrInfo, comments: PrComment[]): string[] {
	const allFlags: string[] = [];

	// Sanitize PR body
	const bodyResult = sanitizeUntrustedContent(pr.body, "PR body");
	pr.body = bodyResult.sanitized;
	allFlags.push(...bodyResult.flags);

	// Sanitize comments
	for (const c of comments) {
		const commentResult = sanitizeUntrustedContent(c.body, `comment by @${c.author}`);
		c.body = commentResult.sanitized;
		allFlags.push(...commentResult.flags);
	}

	return allFlags;
}

function checkLinkedIssue(pr: PrInfo, comments: PrComment[]): CheckResult {
	const body = pr.body || "";
	const issueRefs = body.match(/#(\d+)/g) || [];
	const urlRefs = body.match(/github\.com\/\S+\/issues\/(\d+)/g) || [];
	const refs = [...new Set([...issueRefs, ...urlRefs])];

	if (refs.length > 0) {
		return {
			name: "Linked issue",
			status: "✅",
			details: `References ${refs.slice(0, 3).join(", ")}${refs.length > 3 ? ` +${refs.length - 3} more` : ""}`,
		};
	}

	// Check for keywords that suggest issue context
	const keywords = /\b(fix(es|ed)?|closes?|resolves?|implements?|refs?)\s+#\d+/gi;
	if (keywords.test(body)) {
		return {
			name: "Linked issue",
			status: "✅",
			details: "Issue reference found in PR body keywords",
		};
	}

	// Also scan comments for issue references
	const commentText = comments.map((c) => c.body).join("\n");
	const commentRefs = commentText.match(/#(\d+)/g) || [];
	if (commentRefs.length > 0) {
		return {
			name: "Linked issue",
			status: "✅",
			details: `Issue #${commentRefs[0]!.replace("#", "")} referenced in PR comments`,
		};
	}

	return {
		name: "Linked issue",
		status: "⚠️",
		details: "No linked issue found in PR description",
	};
}

function checkNewDependencies(diff: string, pr: PrInfo): CheckResult {
	const pkgDiff = pr.files.filter((f) => f.path === "package.json");
	if (pkgDiff.length === 0) {
		return {
			name: "New dependencies",
			status: "✅",
			details: "None added (package.json unchanged)",
		};
	}

	// Look for added lines in package.json dependencies
	const addedDeps = diff.match(/^\+[^+].*"@?[a-z0-9_-]+\/[a-z0-9_-]+".*:.*"/gm);
	const addedDepNames: string[] = [];
	if (addedDeps) {
		for (const line of addedDeps) {
			const match = line.match(/"((@[^/]+\/)?[^"]+)"/);
			if (match) addedDepNames.push(match[1]);
		}
	}

	if (addedDepNames.length > 0) {
		return {
			name: "New dependencies",
			status: "⚠️",
			details: `${addedDepNames.length} new package(s): ${addedDepNames.slice(0, 5).join(", ")}${addedDepNames.length > 5 ? ` +${addedDepNames.length - 5} more` : ""}`,
		};
	}

	return { name: "New dependencies", status: "✅", details: "No new packages added" };
}

function runNpmAudit(): CheckResult {
	const { code, stdout } = tryExec("npm audit --audit-level=high 2>&1", { timeout: 60_000 });

	if (code === 0) {
		return { name: "npm audit", status: "✅", details: "No high or critical vulnerabilities" };
	}

	// Parse summary
	const summaryMatch = stdout.match(/(\d+)\s*critical/i);
	const highMatch = stdout.match(/(\d+)\s*high/i);
	const critical = summaryMatch ? parseInt(summaryMatch[1]) : 0;
	const high = highMatch ? parseInt(highMatch[1]) : 0;

	if (critical > 0) {
		return {
			name: "npm audit",
			status: "❌",
			details: `${critical} critical, ${high} high severity advisories`,
		};
	}
	if (high > 0) {
		return {
			name: "npm audit",
			status: "❌",
			details: `${high} high severity advisories`,
		};
	}

	return {
		name: "npm audit",
		status: "⚠️",
		details: "Audit returned warnings (see npm audit output)",
	};
}

function checkSecrets(diff: string): CheckResult {
	const secretPatterns: Array<{ pattern: RegExp; label: string }> = [
		{ pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i, label: "private key" },
		{ pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]+['"]/i, label: "API key" },
		{
			pattern: /(?:secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-=+/\d{20,}]['"]/i,
			label: "secret/token",
		},
		{ pattern: /ghp_[A-Za-z0-9_]{36,}/g, label: "GitHub PAT" },
		{ pattern: /gho_[A-Za-z0-9_]{36,}/g, label: "GitHub OAuth" },
		{
			pattern: /(?:aws_access_key_id|aws_secret_access_key)\s*[:=]\s*['"]?\S+/gi,
			label: "AWS credential",
		},
		{ pattern: /AKIA[0-9A-Z]{16}/g, label: "AWS access key" },
		{ pattern: /sk-[A-Za-z0-9_]{32,}/g, label: "OpenAI/Stripe key" },
	];

	const found: string[] = [];
	for (const { pattern, label } of secretPatterns) {
		if (pattern.test(diff)) {
			found.push(label);
		}
	}

	if (found.length > 0) {
		return {
			name: "Secrets scan",
			status: "❌",
			details: `Potential secrets detected: ${found.join(", ")}`,
		};
	}

	return { name: "Secrets scan", status: "✅", details: "No secrets detected in diff" };
}

function checkTestChanges(pr: PrInfo): CheckResult {
	const testFiles = pr.files.filter(
		(f) =>
			f.path.startsWith("test/") ||
			f.path.endsWith(".test.ts") ||
			f.path.endsWith(".test.mts") ||
			f.path.endsWith(".test.js") ||
			f.path.endsWith(".spec.ts") ||
			f.path.endsWith("__tests__"),
	);

	const codeFiles = pr.files.filter(
		(f) =>
			!f.path.startsWith("test/") &&
			!f.path.endsWith(".test.ts") &&
			!f.path.endsWith(".test.mts") &&
			!f.path.endsWith(".test.js") &&
			!f.path.endsWith(".spec.ts") &&
			!f.path.startsWith(".") &&
			(f.path.endsWith(".ts") ||
				f.path.endsWith(".mts") ||
				f.path.endsWith(".js") ||
				f.path.endsWith(".tsx")),
	);

	if (testFiles.length > 0) {
		return {
			name: "Test changes",
			status: "✅",
			details: `${testFiles.length} test file(s) changed alongside ${codeFiles.length} source file(s)`,
		};
	}

	if (codeFiles.length > 0) {
		return {
			name: "Test changes",
			status: "⚠️",
			details: `${codeFiles.length} source file(s) changed but no test files — consider adding tests`,
		};
	}

	return { name: "Test changes", status: "⏭️", details: "No source code changes to test" };
}

function checkDangerousPatterns(diff: string): CheckResult {
	const patterns: Array<{ pattern: RegExp; label: string }> = [
		{ pattern: /\beval\s*\(/g, label: "eval()" },
		{ pattern: /\bexec\s*\(/g, label: "exec()" },
		{ pattern: /\binnerHTML\s*=/g, label: "innerHTML assignment" },
		{ pattern: /dangerouslySetInnerHTML/g, label: "dangerouslySetInnerHTML" },
		{ pattern: /new\s+Function\s*\(/g, label: "new Function()" },
		{ pattern: /setTimeout\s*\(\s*['"`]/g, label: "setTimeout with string" },
		{ pattern: /child_process\.exec(Sync)?\s*\(/g, label: "child_process exec" },
		{ pattern: /\bsql\s*\+=\s*['"`]/gi, label: "SQL string concatenation" },
		{ pattern: /\$\{.*\}.*\.query\(/g, label: "template literal in query" },
	];

	const found: string[] = [];
	for (const { pattern, label } of patterns) {
		const count = countPattern(diff, pattern);
		if (count > 0) {
			found.push(`${label} (${count}x)`);
		}
	}

	if (found.length > 0) {
		return {
			name: "Dangerous patterns",
			status: "⚠️",
			details: `Found: ${found.join(", ")}`,
		};
	}

	return { name: "Dangerous patterns", status: "✅", details: "None detected" };
}

function checkLint(): CheckResult {
	// Try typescript check first (project style)
	const tsc = tryExec("npx tsc --noEmit --project .pi/tsconfig.json 2>&1", { timeout: 60_000 });
	if (tsc.code === 0) {
		return {
			name: "TypeScript check",
			status: "✅",
			details: "TypeScript compiles without errors",
		};
	}

	// Extract error count
	const errorLines = tsc.stdout.split("\n").filter((l) => l.includes("error"));
	if (errorLines.length > 0) {
		return {
			name: "TypeScript check",
			status: "❌",
			details: `${errorLines.length} TypeScript error(s)`,
		};
	}

	return { name: "TypeScript check", status: "⚠️", details: "Check completed with warnings" };
}

function checkBranchState(pr: PrInfo): CheckResult {
	try {
		const repoInfo = ghJson<{ baseRefName: string; headRefName: string }>([
			"pr",
			"view",
			String(pr.number),
			"--json",
			"baseRefName,headRefName",
		]);

		// Check commits behind base
		const behind = gh([
			"repo",
			"sync",
			"--dry-run",
			"--base",
			repoInfo.baseRefName,
			"--head",
			repoInfo.headRefName,
		]);
		// This approach is fragile; alternative: use gh pr view mergeStateStatus
		const mergeInfo = ghJson<{ mergeStateStatus: string }>([
			"pr",
			"view",
			String(pr.number),
			"--json",
			"mergeStateStatus",
		]);

		switch (mergeInfo.mergeStateStatus) {
			case "CLEAN":
				return { name: "Branch state", status: "✅", details: "Up to date with base branch" };
			case "BEHIND":
				return {
					name: "Branch state",
					status: "⚠️",
					details: "Branch is behind base — rebase recommended",
				};
			case "BLOCKED":
				return {
					name: "Branch state",
					status: "⚠️",
					details: "Merge blocked (merge checks failing)",
				};
			case "DIRTY":
				return {
					name: "Branch state",
					status: "❌",
					details: "Merge conflicts detected — needs rebase",
				};
			case "UNKNOWN":
			default:
				return {
					name: "Branch state",
					status: "⚠️",
					details: "Merge state unknown — may need rebase",
				};
		}
	} catch {
		return {
			name: "Branch state",
			status: "⏭️",
			details: "Could not determine (requires push access)",
		};
	}
}

function checkCommitStyle(pr: PrInfo): CheckResult {
	try {
		const commits = ghJson<Array<{ messageHeadline: string; sha: string }>>([
			"pr",
			"view",
			String(pr.number),
			"--json",
			"commits",
			"--jq",
			".commits[] | {messageHeadline: .messageHeadline, sha: .oid}",
		]);

		const commitList = Array.isArray(commits) ? commits : [];
		if (commitList.length === 0) {
			return { name: "Commit style", status: "⏭️", details: "No commits to check" };
		}

		const conventionalPattern =
			/^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?: .+/i;
		const badCommits = commitList.filter((c) => !conventionalPattern.test(c.messageHeadline));

		if (badCommits.length === 0) {
			return {
				name: "Commit style",
				status: "✅",
				details: `All ${commitList.length} commit(s) follow conventional-commits format`,
			};
		}

		return {
			name: "Commit style",
			status: "⚠️",
			details: `${badCommits.length}/${commitList.length} commit(s) don't follow conventional-commits: ${badCommits
				.slice(0, 3)
				.map((c) => c.messageHeadline)
				.join("; ")}`,
		};
	} catch {
		return { name: "Commit style", status: "⏭️", details: "Could not check commit messages" };
	}
}

// ── AgentCastle Philosophy Alignment ──

function checkPhilosophyAlignment(
	diff: string,
	pr: PrInfo,
	resultsSoFar: CheckResult[],
): CheckResult {
	const newExtFiles = pr.files.filter(
		(f) =>
			f.path.startsWith(".pi/extensions/") && (f.path.endsWith(".ts") || f.path.endsWith(".mts")),
	);
	const violations: string[] = [];
	const warnings: string[] = [];

	// Tenet 1: No MCP servers
	if (hasPattern(diff, [/modelcontextprotocol|mcp\.(json|config)|\"mcpServers\"/i])) {
		violations.push("MCP server config detected — AgentCastle uses pi extensions, not MCP");
	}
	if (hasPattern(diff, [/@modelcontextprotocol\//])) {
		violations.push("MCP SDK dependency (@modelcontextprotocol/*) — not allowed");
	}

	// Tenet 2: Extensions over MCP — no network-exposed endpoints
	if (
		hasPattern(diff, [
			/app\.(listen|run)\(/,
			/server\.(listen|start)\(/,
			/createServer\(/,
			/net\.createServer\(/,
		])
	) {
		warnings.push(
			"Network server detected — verify this doesn't add network-exposed tool endpoints",
		);
	}

	// Tenet 3: All tools run locally — no data exfiltration
	if (
		hasPattern(diff, [
			/axios\.(post|put)\(/,
			/fetch\(["'`]https?:\/\//,
			/request\(["'`]https?:\/\//,
		])
	) {
		warnings.push("HTTP client usage detected — verify no code/data sent to external servers");
	}

	// Tenet 4: Token efficiency — skills vs extensions
	if (hasPattern(diff, [/\.pi\/skills\//])) {
		warnings.push(
			"Skill file changed — ensure a skill is truly needed (prefer extension for tools)",
		);
	}

	// Tenet 5: Security guardrails
	if (hasPattern(diff, [/piignore/, /agent-harness/, /npm.*--age/, /14.day/])) {
		warnings.push("Security guardrail code changed — review carefully for weakening");
	}

	// Tenet 6: No GPL/AGPL dependencies
	const addedDeps = diff.match(/^\\+.*"license".*"(GPL|AGPL)/gim);
	if (addedDeps && addedDeps.length > 0) {
		violations.push(
			"GPL/AGPL licensed dependency detected — not compatible with project MIT license",
		);
	}

	// Tenet 7: Over-engineering
	if (pr.changedFiles > 20 && pr.additions > 1000) {
		warnings.push("Large change set — verify it's not over-engineered or speculative");
	}

	// Tenet 8: Kanban pipeline — quality gates
	if (hasPattern(diff, [/\.pi\/extensions\/supervisor\//])) {
		warnings.push("Supervisor changed — verify pipeline quality gates intact");
	}

	// Assemble result
	const allBlocking = [...violations];
	const allWarnings = [...warnings];

	if (allBlocking.length > 0) {
		const msg = allBlocking.join("; ");
		if (allWarnings.length > 0) {
			return {
				name: "Philosophy alignment",
				status: "❌",
				details: msg + " (also: " + allWarnings.join("; ") + ")",
			};
		}
		return { name: "Philosophy alignment", status: "❌", details: msg };
	}
	if (allWarnings.length > 0) {
		return { name: "Philosophy alignment", status: "⚠️", details: allWarnings.join("; ") };
	}
	return { name: "Philosophy alignment", status: "✅", details: "Aligned with AgentCastle tenets" };
}

// ── Pi Documentation Compliance ──

function checkPiDocsCompliance(diff: string, pr: PrInfo): CheckResult {
	const extFiles = pr.files.filter(
		(f) =>
			f.path.startsWith(".pi/extensions/") && (f.path.endsWith(".ts") || f.path.endsWith(".mts")),
	);

	if (extFiles.length === 0 && !hasPattern(diff, [/pi\.registerTool|pi\.on\(/])) {
		return { name: "Pi docs compliance", status: "⏭️", details: "No extension changes to check" };
	}

	const violations: string[] = [];

	// Rule 1: No `any` types
	const anyCount = countPattern(diff, /\bany\b/g);
	if (anyCount > 5) {
		violations.push(`Heavy use of \`any\` type (${anyCount}x) — prefer specific types`);
	} else if (anyCount > 0) {
		violations.push(`\`any\` type used ${anyCount}x — prefer specific types`);
	}

	// Rule 2: No module-level mutable state
	if (hasPattern(diff, [/\blet\s+\w+\s*[=]/]) && !hasPattern(diff, [/for\s*\(/, /catch\s*\(/])) {
		violations.push("Potential module-level mutable state — use closure or ctx.sessionManager");
	}

	// Rule 3: Uses pi.exec() not child_process directly
	if (
		hasPattern(diff, [/require\(['"`]child_process['"`]\)/, /from ['"`]node:child_process['"`]/])
	) {
		if (!hasPattern(diff, [/pi\.exec\(/])) {
			violations.push("Uses child_process directly — use pi.exec() for subprocess spawning");
		}
	}

	// Rule 4: Uses ctx.ui.* not console.log for user interaction
	if (hasPattern(diff, [/console\.(log|warn|error)/]) && hasPattern(diff, [/pi\.on\(/])) {
		if (!hasPattern(diff, [/ctx\.ui\./])) {
			violations.push("console.log used in extension — use ctx.ui.notify() for user messages");
		}
	}

	// Rule 5: Proper default export pattern
	if (hasPattern(diff, [/pi: ExtensionAPI/]) && !hasPattern(diff, [/export default function/])) {
		violations.push("Extension uses pi.on() but missing default export function pattern");
	}

	// Rule 6: No Typebox for tool inputs
	if (hasPattern(diff, [/registerTool\(/]) && !hasPattern(diff, [/Type\./])) {
		violations.push("Custom tool registered without Typebox schema for inputs");
	}

	if (violations.length > 0) {
		const isBlocking = violations.some((v) => v.includes("child_process") || v.includes("any"));
		return {
			name: "Pi docs compliance",
			status: isBlocking ? "❌" : "⚠️",
			details: violations.join("; "),
		};
	}
	return { name: "Pi docs compliance", status: "✅", details: "Follows pi extension conventions" };
}

// ── Code Style Audit ──

function checkCodeStyle(diff: string, pr: PrInfo): CheckResult {
	const srcFiles = pr.files.filter(
		(f) =>
			!f.path.startsWith(".github/") &&
			!f.path.startsWith("test/") &&
			!f.path.startsWith(".pi/") &&
			(f.path.endsWith(".ts") ||
				f.path.endsWith(".mts") ||
				f.path.endsWith(".js") ||
				f.path.endsWith(".tsx")),
	);
	if (srcFiles.length === 0) {
		return { name: "Code style audit", status: "⏭️", details: "No source files to check" };
	}

	const issues: string[] = [];

	// Naming conventions: camelCase functions
	const funcNames = diff.match(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g);
	if (funcNames) {
		const badNames = funcNames
			.map((f) => f.replace(/function\s+/, "").replace(/\s*\(/, ""))
			.filter((name) => !/^[a-z_]/.test(name) && !/^[A-Z][a-z]/.test(name));
		if (badNames.length > 2) {
			issues.push(`${badNames.length} function names don't follow camelCase convention`);
		}
	}

	// Dead code: console.log in production files
	const consoleLogCount = countPattern(diff, /^\+.*console\.log\(/gm);
	if (consoleLogCount > 2) {
		issues.push(`${consoleLogCount} console.log() statements added — likely debug leftovers`);
	}

	// Empty catch blocks
	if (hasPattern(diff, [/catch\s*\([^)]*\)\s*\{\s*\}/])) {
		issues.push("Empty catch block detected — silently swallows errors");
	}

	// Magic numbers
	const magicNumberPattern = /[^a-zA-Z]if\s*\([^)]*[=!]==\s*\d{2,}[^)]*\)/g;
	const magicCount = countPattern(diff, magicNumberPattern);
	if (magicCount > 3) {
		issues.push(`${magicCount} magic number comparisons — extract to named constants`);
	}

	if (issues.length > 0) {
		return {
			name: "Code style audit",
			status: "⚠️",
			details: issues.join("; "),
		};
	}
	return {
		name: "Code style audit",
		status: "✅",
		details: "Style consistent with project conventions",
	};
}

// ── Comment Formatter ──

/** Extract a concise summary of what this PR does from title + body */
function extractPrSummary(pr: PrInfo): string {
	// Start with the title
	let summary = pr.title;

	if (pr.body) {
		// Walk clean body lines for first meaningful description paragraph
		const lines = pr.body
			.split("\n")
			.map((l) => l.trim())
			.filter(
				(l) =>
					l.length > 20 &&
					!l.startsWith("#") &&
					!l.startsWith("-") &&
					!l.startsWith("<!--") &&
					!l.startsWith("```") &&
					!l.startsWith(">") &&
					!l.match(/^(fix(es|ed)?|closes?|resolves?|refs?)s?\s+#/i),
			);

		for (const line of lines) {
			if (line.length > 20) {
				summary = line.length > 300 ? line.slice(0, 300) + "…" : line;
				break;
			}
		}
	}

	return summary;
}

function formatReviewComment(pr: PrInfo, results: CheckResult[], comments: PrComment[]): string {
	const passCount = results.filter((r) => r.status === "✅").length;
	const warnCount = results.filter((r) => r.status === "⚠️").length;
	const failCount = results.filter((r) => r.status === "❌").length;
	const skipCount = results.filter((r) => r.status === "⏭️").length;

	const hasBlockingIssue = results.some((r) => r.status === "❌");

	const lines: string[] = [];

	// Header
	lines.push("## 🤖 PR Review — Automated Checks");
	lines.push("");
	lines.push(
		`**PR:** #${pr.number} — ${pr.title} by @${pr.author} (${pr.changedFiles} files, +${pr.additions}/-${pr.deletions})`,
	);
	lines.push("");

	// ── What this PR does ──
	const prSummary = extractPrSummary(pr);
	lines.push("### 📋 What This PR Does");
	lines.push("");
	lines.push(prSummary);
	lines.push("");

	// Summary badges
	const summaryParts: string[] = [];
	if (passCount) summaryParts.push(`${passCount} ✅`);
	if (warnCount) summaryParts.push(`${warnCount} ⚠️`);
	if (failCount) summaryParts.push(`${failCount} ❌`);
	if (skipCount) summaryParts.push(`${skipCount} ⏭️`);
	lines.push(`**Summary:** ${summaryParts.join(" · ")}`);
	lines.push("");

	// Results table
	lines.push("| Check | Result | Details |");
	lines.push("|---|---|---|");
	for (const r of results) {
		// Escape any pipe characters in details
		const details = r.details.replace(/\|/g, "\\|");
		lines.push(`| ${r.name} | ${r.status} | ${details} |`);
	}

	lines.push("");

	// Blocking issue banner
	if (hasBlockingIssue) {
		lines.push(
			"> **⚠️ Blocking issues detected** — see above. These must be resolved before merge.",
		);
		lines.push("");
	}

	// ── PR Comments Summary ──
	if (comments.length > 0) {
		lines.push("### 💬 PR Comments");
		lines.push("");
		lines.push(`Total: ${comments.length} comment(s) — review context from discussion:`);
		lines.push("");

		// Show first 5 comments as summary
		const displayComments = comments.slice(0, 5);
		for (const c of displayComments) {
			const preview = c.body.replace(/\n+/g, " ").slice(0, 200);
			lines.push(
				`- **@${c.author}** (${c.createdAt.slice(0, 10)}): ${preview}${c.body.length > 200 ? "…" : ""}`,
			);
		}
		if (comments.length > 5) {
			lines.push(`- … +${comments.length - 5} more comment(s)`);
		}
		lines.push("");
	}

	// ── Human Review Sections ──

	lines.push("---");
	lines.push("### 📋 Human Review Required");
	lines.push("");
	lines.push(
		"The checks below need a **human reviewer**. Mark each item as you complete the review.",
	);
	lines.push("");

	lines.push("#### 1. Context & Motivation");
	lines.push("- [ ] PR description clearly states **what** changed and **why**?");
	lines.push("- [ ] Linked issue fully addressed by this change?");
	lines.push("- [ ] Bug fix includes **steps to reproduce** or a failing test?");
	lines.push("- [ ] Feature includes **acceptance criteria**?");
	lines.push("");

	lines.push("#### 2. Design & Architecture");
	lines.push("- [ ] Change fits within existing architecture (no layering violations)?");
	lines.push("- [ ] New abstractions justified? Not over-engineered?");
	lines.push("- [ ] Error handling consistent with project patterns?");
	lines.push("- [ ] Async/concurrent code free of race conditions?");
	lines.push("");

	lines.push("#### 3. Security (human review)");
	lines.push("- [ ] Input validation on all external inputs (HTTP, files, env)?");
	lines.push("- [ ] Auth/authorization on new endpoints/routes?");
	lines.push("- [ ] No data leakage in logs, errors, or responses?");
	lines.push("- [ ] CORS/CSRF handled correctly (if web-facing)?");
	lines.push("");

	lines.push("#### 4. Bug-Fix Validation");
	lines.push("- [ ] Fix addresses **root cause**, not just symptom?");
	lines.push("- [ ] Edge cases covered (empty input, boundaries, errors)?");
	lines.push("- [ ] Same bug pattern elsewhere in codebase?");
	lines.push("");

	lines.push("#### 5. Efficiency & Performance");
	lines.push("- [ ] Solution as simple as possible?");
	lines.push("- [ ] No N+1 queries, unnecessary loops, redundant computation?");
	lines.push("- [ ] Resources released properly (handles, connections, memory)?");
	lines.push("");

	lines.push("#### 6. Test Quality");
	lines.push("- [ ] Tests actually test the behavior (not tautological)?");
	lines.push("- [ ] Negative/error test cases included?");
	lines.push("- [ ] Tests deterministic (no flakiness)?");
	lines.push("");

	lines.push("#### 6. Test Quality");
	lines.push("- [ ] Tests actually test the behavior (not tautological)?");
	lines.push("- [ ] Negative/error test cases included?");
	lines.push("- [ ] Tests deterministic (no flakiness)?");
	lines.push("");

	lines.push("#### 7. AgentCastle Philosophy");
	lines.push('- [ ] Change respects "extensions over MCP" principle?');
	lines.push("- [ ] All tools/processing stays local (no data exfiltration)?");
	lines.push("- [ ] Token-efficient approach (no unnecessary context bloat)?");
	lines.push("- [ ] No GPL/AGPL dependencies added?");
	lines.push("- [ ] Security guardrails intact (piignore, agent-harness)?");
	lines.push("- [ ] Not over-engineered or speculative?");
	lines.push("");

	lines.push("#### 8. Pi Documentation Compliance");
	lines.push("- [ ] Extensions follow pi SDK patterns (default export, pi.on/pi.registerTool)?");
	lines.push("- [ ] No \`any\` types or module-level mutable state?");
	lines.push("- [ ] Uses \`pi.exec()\` not \`child_process\` directly?");
	lines.push("- [ ] Uses \`ctx.ui.*\` for user interaction (not console.log)?");
	lines.push("- [ ] Files under 300 lines, entry under 100 lines?");
	lines.push("- [ ] Typebox schemas for custom tool inputs?");
	lines.push("");

	lines.push("#### 9. Code Quality & Style");
	lines.push("- [ ] Functions readable at a glance?");
	lines.push("- [ ] Naming clear and consistent with project?");
	lines.push("- [ ] No dead code, debugger statements, or console.log leftovers?");
	lines.push("");

	lines.push("#### 10. Documentation");
	lines.push("- [ ] README/API docs updated if behavior changed?");
	lines.push("- [ ] CHANGELOG entry added?");
	lines.push("");

	lines.push("#### 11. Safety & Reversibility");
	lines.push("- [ ] Change can be rolled back safely?");
	lines.push("- [ ] Backward compatible? If breaking, properly versioned?");
	lines.push("- [ ] Data migrations idempotent (if applicable)?");
	lines.push("");

	// Footer
	lines.push("---");
	lines.push(
		"> _Reviewed using [PR_REVIEW_PROMPT.md](PR_REVIEW_PROMPT.md) — full checklist reference._",
	);

	return lines.join("\n");
}

// ── Main ──

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const prNumber = parseInt(args[0], 10);
	const mode = args.includes("--post") ? "post" : args.includes("--json") ? "json" : "stdout";

	if (!prNumber || isNaN(prNumber)) {
		console.error("Usage: npx tsx scripts/pr-review.ts <pr-number> [--post|--json|--show]");
		console.error("");
		console.error("  <pr-number>  GitHub PR number to review");
		console.error("  --post       Print comment and post to PR");
		console.error("  --json       Output results as JSON");
		console.error("  --show       Print comment to stdout (default)");
		process.exit(1);
	}

	// ── 1. Fetch PR ──
	console.error(`\n📦 Fetching PR #${prNumber}...`);
	const pr = ghPrView(prNumber);

	if (pr.state !== "OPEN") {
		console.error(`PR #${prNumber} is ${pr.state} — skipping review.`);
		process.exit(0);
	}

	console.error(`   Title: ${pr.title}`);
	console.error(`   Author: @${pr.author} (${pr.authorAssociation})`);
	console.error(`   Files: ${pr.changedFiles} changed, +${pr.additions}/-${pr.deletions}`);

	// ── Fetch PR comments ──
	console.error(`\n💬 Fetching PR comments...`);
	const comments = getPrComments(prNumber);
	console.error(`   ${comments.length} comment(s) found`);

	// ── Sanitize untrusted content (prompt injection defense) ──
	console.error(`\n🛡️  Sanitizing untrusted content...`);
	const sanitizeFlags = sanitizePrContent(pr, comments);
	if (sanitizeFlags.length > 0) {
		console.error(`   ⚠️  ${sanitizeFlags.length} injection pattern(s) stripped`);
		for (const f of sanitizeFlags) {
			console.error(`       - ${f}`);
		}
	} else {
		console.error(`   ✅ No injection patterns detected`);
	}

	// ── 2. Run checks ──
	console.error(`\n🔍 Running automated checks...`);

	const diff = pr.changedFiles > 0 ? getDiff(prNumber) : "";
	pr.body = pr.body || "";

	const results: CheckResult[] = [];

	// Prompt injection check
	console.error(`   [1/13] Prompt injection check...`);
	results.push(checkPromptInjection(pr, comments));

	// Context check (includes comments)
	console.error(`   [2/13] Linked issue...`);
	results.push(checkLinkedIssue(pr, comments));

	// Dependencies
	console.error(`   [3/13] New dependencies...`);
	results.push(checkNewDependencies(diff, pr));

	// npm audit (only if deps changed)
	const depsResult = results[results.length - 1];
	if (
		depsResult.status === "⚠️" ||
		pr.files.some((f) => f.path === "package-lock.json" || f.path === "yarn.lock")
	) {
		console.error(`   [4/13] npm audit...`);
		results.push(runNpmAudit());
	} else {
		results.push({ name: "npm audit", status: "⏭️", details: "No dependency changes to audit" });
	}

	// Secrets
	console.error(`   [5/13] Secrets scan...`);
	results.push(checkSecrets(diff));

	// Test changes
	console.error(`   [6/13] Test changes...`);
	results.push(checkTestChanges(pr));

	// Lint/TypeScript check
	console.error(`   [7/13] TypeScript check...`);
	results.push(checkLint());

	// Dangerous patterns
	console.error(`   [8/13] Dangerous patterns...`);
	results.push(checkDangerousPatterns(diff));

	// Branch state
	console.error(`   [10/13] Branch state...`);
	results.push(checkBranchState(pr));

	// Commit style
	console.error(`   [9/13] Commit style...`);
	results.push(checkCommitStyle(pr));

	// Philosophy alignment
	console.error(`   [11/13] Philosophy alignment...`);
	results.push(checkPhilosophyAlignment(diff, pr, results));

	// Pi docs compliance
	console.error(`   [12/13] Pi docs compliance...`);
	results.push(checkPiDocsCompliance(diff, pr));

	// Code style audit
	console.error(`   [13/13] Code style audit...`);
	results.push(checkCodeStyle(diff, pr));

	// ── 3. Format ──
	console.error(`\n📝 Formatting review comment...`);
	const comment = formatReviewComment(pr, results, comments);

	// ── 4. Output ──
	if (mode === "json") {
		const jsonResult = {
			pr: {
				number: pr.number,
				title: pr.title,
				author: pr.author,
				authorAssociation: pr.authorAssociation,
				changedFiles: pr.changedFiles,
				additions: pr.additions,
				deletions: pr.deletions,
			},
			results: results.map((r) => ({ name: r.name, status: r.status, details: r.details })),
			comment,
			timestamp: new Date().toISOString(),
		};
		console.log(JSON.stringify(jsonResult, null, 2));
	} else {
		// stdout mode — print the comment (--post also prints)
		console.log(comment);
	}

	// ── 5. Post ──
	if (mode === "post") {
		const tmpFile = join(tmpdir(), `pr-review-${prNumber}-${Date.now()}.md`);
		writeFileSync(tmpFile, comment, "utf-8");
		console.error(`\n📤 Posting comment to PR #${prNumber}...`);
		try {
			gh(["pr", "comment", String(prNumber), "--body-file", tmpFile], { timeout: 30_000 });
			console.error(`✅ Comment posted to PR #${prNumber}`);
		} catch (err) {
			console.error(`❌ Failed to post comment: ${(err as Error).message}`);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error(`❌ PR review failed: ${(err as Error).message}`);
	process.exit(1);
});
