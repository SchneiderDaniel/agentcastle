/**
 * check-extensions — Audit extensions against pi CHANGELOG API changes
 *
 * Four-phase pipeline:
 *   1. Parse pi CHANGELOG.md → ChangeEntry[]
 *   2. Scan .pi/extensions/ → Finding[]
 *   3. Cross-reference findings against changelog entries
 *   4. Create GitHub issues for affected extensions
 *
 * Usage: /check-extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseChangelog, type ChangeEntry } from "./changelog-parser.ts";
import { scanExtensions, type Finding } from "./extension-scanner.ts";
import {
	buildIssueTitle,
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

			// ── Phase 2: Scan extensions ──
			ctx.ui.notify("Scanning .pi/extensions/...", "info");
			const extensionsDir = join(ctx.cwd, ".pi", "extensions");
			const apiNamesList = Array.from(affectedApiPatterns);
			const scanResult = scanExtensions(extensionsDir, apiNamesList);

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

			// ── Phase 2.5: Group findings by extension ──
			const findingsByExtension = new Map<string, Finding[]>();
			for (const finding of scanResult.findings) {
				const extName = finding.extensionName;
				if (!findingsByExtension.has(extName)) {
					findingsByExtension.set(extName, []);
				}
				findingsByExtension.get(extName)!.push(finding);
			}

			// Cross-reference each finding with changelog metadata
			for (const [extName, extFindings] of findingsByExtension) {
				for (const f of extFindings) {
					f.changelogVersion = latestVersion;
					// Find matching changelog entry by API name
					const matchingEntry = findMatchingEntry(f.apiName, entries);
					if (matchingEntry) {
						f.isBreaking = matchingEntry.isBreaking;
						f.category = matchingEntry.category;
					}
				}
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

			// ── Phase 4: Create issues ──
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

			for (const [extName, extFindings] of findingsByExtension) {
				const title = buildIssueTitle(extName, extFindings.length, latestVersion);

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

				const body = buildIssueBody(extName, extFindings, latestVersion);

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
