/**
 * check-extensions — Audit extensions against pi CHANGELOG API changes
 *
 * Enhanced pipeline with AST analysis (replacing regex-only phase 2):
 *   1. Parse pi CHANGELOG.md → ChangeEntry[]
 *   2. Scan .pi/extensions/ with ast-grep → ASTFinding[] (AST-aware)
 *   2.5 Resolve relevance + compute impact scores + generate migration snippets
 *   3. Cross-reference findings against changelog entries
 *   4. Create GitHub issues with migration snippets + impact scores
 *
 * Usage: /check-extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseChangelog, parseStructuredChange, type ChangeEntry } from "./changelog-parser.ts";
import { scanExtensions, type Finding } from "./extension-scanner.ts";
import { scanExtensionsAST, type ASTFinding, type ExecFn as AstExecFn } from "./ast-scanner.ts";
import { resolveRelevance, extractStructuredChange } from "./change-resolver.ts";
import { computeImpactScore, type ImpactScore } from "./impact-scorer.ts";
import { generateMigrationSnippet, type MigrationSnippet } from "./migration-generator.ts";
import { readManifest } from "./manifest-reader.ts";
import {
	buildIssueTitle,
	buildIssueBodyWithSnippets,
	buildIssueBody,
	checkGhAuth,
	ensureLabel,
	checkExistingIssues,
	createIssue,
} from "./issue-builder.ts";

/** Resolve path to pi CHANGELOG.md */
const PI_CHANGELOG_PATH = join(
	homedir(),
	".npm-global",
	"lib",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"CHANGELOG.md",
);

/** The set of API names we look for in changelog entries */
const API_PATTERNS = [
	"pi.on",
	"pi.registerCommand",
	"pi.registerTool",
	"pi.exec",
	"pi.sendUserMessage",
	"ctx.ui",
	"ctx.sessionManager",
	"ctx.abort",
	"pi.registerFlag",
	"pi.registerShortcut",
	"pi.getFlag",
	"pi.setActiveTools",
	"pi.sendMessage",
	"pi.appendEntry",
	"pi.setSessionName",
];

/** Known API term aliases for mapping changelog entries to scan patterns */
const CHANGELOG_API_TO_PATTERN: Record<string, string[]> = {
	on: ["pi.on"],
	registerCommand: ["pi.registerCommand"],
	registerTool: ["pi.registerTool"],
	exec: ["pi.exec"],
	sendUserMessage: ["pi.sendUserMessage"],
	"ctx.ui": ["ctx.ui"],
	sessionManager: ["ctx.sessionManager"],
	abort: ["ctx.abort"],
	registerFlag: ["pi.registerFlag"],
	registerShortcut: ["pi.registerShortcut"],
	getFlag: ["pi.getFlag"],
	setActiveTools: ["pi.setActiveTools"],
	sendMessage: ["pi.sendMessage"],
	appendEntry: ["pi.appendEntry"],
	setSessionName: ["pi.setSessionName"],
	tool: ["pi.registerTool", "pi.on"],
	command: ["pi.registerCommand"],
	event: ["pi.on"],
	extension: ["pi.on", "pi.registerCommand"],
	SDK: ["pi.exec", "pi.sendUserMessage"],
	config: ["pi.registerFlag", "pi.getFlag"],
	export: ["pi.sendUserMessage", "pi.sendMessage"],
};

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("check-extensions", {
		description:
			"Audit extensions against pi CHANGELOG API changes. " +
			"Parses CHANGELOG.md, scans .pi/extensions/, " +
			"creates GitHub issues for affected extensions.",
		handler: async (_args, ctx) => {
			const reportLines: string[] = [];

			// ── Phase 0: Validate prerequisites ──
			if (!existsSync(PI_CHANGELOG_PATH)) {
				const msg = `Pi changelog not found at ${PI_CHANGELOG_PATH}`;
				ctx.ui.notify(msg, "error");
				reportLines.push(`❌ ${msg}`);
				reportLines.push(
					"Expected at: ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md",
				);
				pi.sendUserMessage(reportLines.join("\n"));
				return;
			}

			// ── Phase 1: Parse changelog ──
			ctx.ui.notify("Parsing pi CHANGELOG...", "info");
			let changelogContent: string;
			try {
				changelogContent = readFileSync(PI_CHANGELOG_PATH, "utf-8");
			} catch (err) {
				const msg = `Failed to read changelog: ${(err as Error).message}`;
				ctx.ui.notify(msg, "error");
				pi.sendUserMessage(msg);
				return;
			}

			const entries = parseChangelog(changelogContent);
			if (entries.length === 0) {
				ctx.ui.notify("No API changes found in changelog.", "info");
				reportLines.push("No API-visible changes detected in pi changelog.");
				reportLines.push("");
				reportLines.push("Scanned extensions for current API usage anyway (no reference).");
			}

			// Latest version
			const latestVersion = entries.length > 0 ? entries[0]!.version : "latest";

			// Collect unique API names from changelog entries
			const affectedApiPatterns = new Set<string>();
			for (const entry of entries) {
				for (const apiName of entry.apiNames) {
					const patterns = CHANGELOG_API_TO_PATTERN[apiName.toLowerCase()];
					if (patterns) {
						for (const p of patterns) affectedApiPatterns.add(p);
					}
				}
			}

			// If no specific API patterns found, scan all patterns
			if (affectedApiPatterns.size === 0) {
				for (const p of API_PATTERNS) affectedApiPatterns.add(p);
			}

			// ── Phase 2: Scan extensions (AST-based) ──
			ctx.ui.notify("Scanning .pi/extensions/ with ast-grep...", "info");
			const extensionsDir = join(ctx.cwd, ".pi", "extensions");
			const apiNamesList = Array.from(affectedApiPatterns);

			// Resolve ast-grep binary path
			const astGrepPath = resolveAstGrepPath();

			const scanResult = await scanExtensionsAST(
				extensionsDir,
				apiNamesList,
				pi.exec.bind(pi) as unknown as AstExecFn,
				astGrepPath,
			);

			if (scanResult.skipCount > 0) {
				reportLines.push(`⚠️ ${scanResult.skipCount} file(s) could not be read (skipped).`);
			}

			if (scanResult.findings.length === 0) {
				const msg = "All extensions compatible with latest pi changelog.";
				ctx.ui.notify(msg, "info");
				reportLines.push(msg);
				pi.sendUserMessage(reportLines.join("\n"));
				return;
			}

			// ── Phase 2.5: Group, cross-reference, resolve relevance, score, generate snippets ──

			// Read manifests for version filtering
			const manifestCache = new Map<string, ReturnType<typeof readManifest>>();

			// Group findings by extension
			const findingsByExtension = new Map<string, ASTFinding[]>();
			for (const finding of scanResult.findings) {
				const extName = finding.extensionName;
				if (!findingsByExtension.has(extName)) {
					findingsByExtension.set(extName, []);
				}
				findingsByExtension.get(extName)!.push(finding);
			}

			// Cross-reference each finding with changelog metadata + relevance + snippets + score
			const snippetsByExtension = new Map<string, MigrationSnippet[]>();
			const scoresByExtension = new Map<string, ImpactScore>();

			for (const [extName, extFindings] of findingsByExtension) {
				// Read manifest for version info
				const extDir = join(extensionsDir, extName);
				const manifest = readManifest(extDir);
				manifestCache.set(extName, manifest);

				const extSnippets: MigrationSnippet[] = [];

				for (const f of extFindings) {
					f.changelogVersion = latestVersion;

					// Find matching changelog entry by API name
					const matchingEntry = findMatchingEntry(f.apiName, entries);
					if (matchingEntry) {
						f.isBreaking = matchingEntry.isBreaking;
						f.category = matchingEntry.category;

						// Parse structured change and resolve relevance
						const structuredChange = parseStructuredChange(matchingEntry.description);
						if (structuredChange) {
							const relevant = resolveRelevance(matchingEntry, f, structuredChange);
							if (relevant === false) {
								// False positive — changelog change doesn't affect this call
								f.category = "not-applicable";
							}
						}

						// Generate migration snippet for runtime-call findings
						if (f.matchContext === "runtime-call") {
							const snippet = generateMigrationSnippet(matchingEntry.description, f.apiName);
							if (snippet) {
								extSnippets.push(snippet);
							}
						}
					}
				}

				snippetsByExtension.set(extName, extSnippets);

				// Compute impact score
				const score = computeImpactScore(extName, extFindings);
				scoresByExtension.set(extName, score);
			}

			// Filter out extensions where all findings are non-applicable
			const relevantFindingsByExtension = new Map<string, ASTFinding[]>();
			for (const [extName, extFindings] of findingsByExtension) {
				const relevant = extFindings.filter((f) => f.category !== "not-applicable");
				if (relevant.length > 0) {
					relevantFindingsByExtension.set(extName, relevant);
				}
			}

			if (relevantFindingsByExtension.size === 0) {
				const msg = "All findings resolved as non-applicable after changelog cross-reference.";
				ctx.ui.notify(msg, "info");
				reportLines.push(msg);
				pi.sendUserMessage(reportLines.join("\n"));
				return;
			}

			// ── Phase 3: Check gh auth ──
			ctx.ui.notify("Checking GitHub CLI authentication...", "info");
			const authed = await checkGhAuth(pi.exec.bind(pi));
			if (!authed) {
				const msg = "gh not authenticated — run `gh auth status`";
				ctx.ui.notify(msg, "error");
				reportLines.push(`❌ ${msg}`);
				pi.sendUserMessage(reportLines.join("\n"));
				return;
			}

			// ── Phase 4: Create issues with rich bodies ──
			ctx.ui.notify("Creating GitHub issues...", "info");

			// Resolve repo from settings
			let repo = "";
			const settingsPath = join(ctx.cwd, ".pi", "settings.json");
			try {
				const settingsRaw = readFileSync(settingsPath, "utf-8");
				const settings = JSON.parse(settingsRaw);
				repo = settings?.supervisor?.repo ?? "";
			} catch {
				// Fallback: not fatal, gh --repo will error later
			}

			if (!repo) {
				const msg =
					"No repo found in .pi/settings.json (supervisor.repo). " +
					"Pass --repo explicitly or set supervisor.repo.";
				ctx.ui.notify(msg, "error");
				reportLines.push(`❌ ${msg}`);
				pi.sendUserMessage(reportLines.join("\n"));
				return;
			}

			// Ensure label exists
			try {
				await ensureLabel(pi.exec.bind(pi), repo);
			} catch (err) {
				const msg = `Failed to ensure label: ${(err as Error).message}`;
				ctx.ui.notify(msg, "warning");
			}

			// Create issues per extension
			const createdIssues: Array<{
				extName: string;
				url: string;
			}> = [];
			const skippedExtensions: string[] = [];

			for (const [extName, extFindings] of relevantFindingsByExtension) {
				const title = buildIssueTitle(extName, extFindings.length, latestVersion);
				const snippets = snippetsByExtension.get(extName) ?? [];
				const score = scoresByExtension.get(extName);

				// Dedup check
				try {
					const exists = await checkExistingIssues(pi.exec.bind(pi), repo, title);
					if (exists) {
						skippedExtensions.push(extName);
						continue;
					}
				} catch {
					// If dedup check fails, proceed anyway
				}

				// Build body with snippets and impact score (or fallback to basic body)
				let body: string;
				if (score) {
					body = buildIssueBodyWithSnippets(extName, extFindings, latestVersion, snippets, score);
				} else {
					body = buildIssueBody(extName, extFindings, latestVersion);
				}

				try {
					const url = await createIssue(pi.exec.bind(pi), repo, title, body);
					createdIssues.push({ extName, url });
				} catch (err) {
					reportLines.push(`❌ Failed to create issue for ${extName}: ${(err as Error).message}`);
				}
			}

			// ── Report results ──
			if (createdIssues.length > 0) {
				reportLines.push(`✅ Created ${createdIssues.length} issue(s):`);
				for (const { extName, url } of createdIssues) {
					reportLines.push(`- [${extName}](${url})`);
				}
			}

			if (skippedExtensions.length > 0) {
				reportLines.push(
					`⏭️ Skipped ${skippedExtensions.length} extension(s) (duplicate issues exist):`,
				);
				for (const name of skippedExtensions) {
					reportLines.push(`- ${name}`);
				}
			}

			if (createdIssues.length === 0 && skippedExtensions.length === findingsByExtension.size) {
				reportLines.push("✅ All extensions already have tracking issues. No new issues created.");
			}

			reportLines.push("");
			reportLines.push("---");
			reportLines.push(
				`_Scanned ${findingsByExtension.size} extension(s), ` +
					`${scanResult.findings.length} total finding(s)._`,
			);

			pi.sendUserMessage(reportLines.join("\n"));

			if (createdIssues.length > 0) {
				ctx.ui.notify(`Created ${createdIssues.length} tracking issue(s).`, "success");
			} else {
				ctx.ui.notify("No new issues needed.", "info");
			}
		},
	});
}

/**
 * Find a changelog entry matching a given API name.
 */
function findMatchingEntry(apiName: string, entries: ChangeEntry[]): ChangeEntry | undefined {
	const normalized = apiName.replace(/^pi\./, "").replace(/^ctx\./, "");
	return entries.find((e) =>
		e.apiNames.some(
			(name) =>
				name.toLowerCase() === apiName.toLowerCase() ||
				name.toLowerCase() === normalized.toLowerCase(),
		),
	);
}

/**
 * Resolve the path to ast-grep binary.
 * Checks common locations, falls back to PATH.
 */
function resolveAstGrepPath(): string {
	const home = process.env.HOME || "/home/miria";
	const candidates = [
		join(home, ".npm-global", "bin", "ast-grep"),
		"/usr/local/bin/ast-grep",
		"/usr/bin/ast-grep",
	];
	for (const c of candidates) {
		try {
			const { accessSync, constants } = require("node:fs") as typeof import("node:fs");
			accessSync(c, constants.X_OK);
			return c;
		} catch {
			/* try next */
		}
	}
	return "ast-grep"; // fallback — hope it's on PATH
}
