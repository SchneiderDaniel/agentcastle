/**
 * session-advice.ts — Post-hoc session analysis runner
 *
 * Scans .pi/sessions/*.jsonl and generates .advice.md files.
 * Updates latest.advice.md symlink after each run.
 *
 * Usage:
 *   npx tsx scripts/session-advice.ts                    # all sessions
 *   npx tsx scripts/session-advice.ts --latest            # latest only
 *   npx tsx scripts/session-advice.ts <prefix>            # matching prefix
 *
 * Output: .pi/sessions/<session>.advice.md
 */

import {
	readdirSync,
	statSync,
	writeFileSync,
	existsSync,
	symlinkSync,
	unlinkSync,
	renameSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import {
	parseJsonlFile,
	analyzeSession,
	renderAdviceToMarkdown,
} from "../.pi/extensions/session-advice/advisor.js";

const SESSIONS_DIR = resolve(import.meta.dirname, "../.pi/sessions");

const args = process.argv.slice(2);
const mode = args.includes("--latest") ? "latest" : args[0] || "all";

function findFiles(): string[] {
	const all = readdirSync(SESSIONS_DIR)
		.filter((f) => f.endsWith(".jsonl") && !f.includes("latest"))
		.sort();

	if (mode === "latest") {
		const newest = all
			.map((f) => ({ name: f, mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);
		return newest.length > 0 ? [newest[0].name] : [];
	}

	if (mode !== "all") {
		return all.filter((f) => f.startsWith(mode));
	}

	return all;
}

function updateLatestSymlink(advicePath: string): void {
	const latestLink = join(SESSIONS_DIR, "latest.advice.md");
	const tmpLink = latestLink + ".tmp";
	try {
		unlinkSync(tmpLink);
	} catch {
		/* ok */
	}
	try {
		symlinkSync(basename(advicePath), tmpLink);
		renameSync(tmpLink, latestLink);
	} catch {
		/* symlink optional */
	}
}

const files = findFiles();

console.log(`=== Session Advice Generator ===`);
console.log(`Files: ${files.length} from ${SESSIONS_DIR}`);
console.log("");

let generated = 0;
let skipped = 0;
let failed = 0;
let lastAdvicePath = "";

for (const file of files) {
	const jsonlPath = join(SESSIONS_DIR, file);
	const advicePath = jsonlPath.replace(/\.jsonl$/, ".advice.md");
	const base = file.replace(/\.jsonl$/, "");

	process.stdout.write(`  ${base.slice(0, 28).padEnd(28)} ... `);

	// Skip if advice file exists and is newer
	if (existsSync(advicePath) && statSync(advicePath).mtimeMs > statSync(jsonlPath).mtimeMs) {
		console.log("⏭️  up to date");
		if (!lastAdvicePath) lastAdvicePath = advicePath;
		skipped++;
		continue;
	}

	try {
		const data = parseJsonlFile(jsonlPath);
		if (!data) {
			console.log("❌ parse error");
			failed++;
			continue;
		}

		const result = analyzeSession(data);
		const md = renderAdviceToMarkdown(result);
		writeFileSync(advicePath, md, "utf-8");

		lastAdvicePath = advicePath;

		if (result.entries.length === 0) {
			console.log(`✅ clean (${result.score})`);
		} else {
			const icon = result.score > 0.4 ? "⚠️" : result.score > 0.2 ? "⚡" : "ℹ️";
			console.log(`${icon} ${result.entries.length} issues (score ${result.score})`);
		}
		generated++;
	} catch (err) {
		console.log(`❌ ${(err as Error).message}`);
		failed++;
	}
}

// Update latest symlink to last processed file
if (lastAdvicePath) {
	updateLatestSymlink(lastAdvicePath);
}

console.log("");
console.log("=== Summary ===");
console.log(`  Generated: ${generated}`);
console.log(`  Skipped:   ${skipped}`);
console.log(`  Failed:    ${failed}`);
console.log(`  Total:     ${files.length}`);
