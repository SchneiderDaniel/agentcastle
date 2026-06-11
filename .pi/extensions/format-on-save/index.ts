/**
 * format-on-save — Auto-formats TS/JS files with Prettier and reports ESLint issues
 *
 * Triggers on every write/edit tool call. Runs Prettier to reformat,
 * then ESLint --fix for lint errors. Non-blocking advisory only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
	shouldFormat,
	shouldLint,
	looksLikeFilePath,
	MAX_FILE_SIZE_BYTES,
	buildPrettierArgs,
} from "./formatting.mts";
import { runEslintOnFile } from "./eslint.mts";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		try {
			// Only handle write and edit tools
			if (event.toolName !== "write" && event.toolName !== "edit") return;

			// Skip errors
			if (event.isError) return;

			// Extract the file path from input
			const filePath = (event.input as { path?: string }).path;
			if (!looksLikeFilePath(filePath)) return;

			// Resolve relative paths against cwd
			const absolutePath = resolve(ctx.cwd, filePath);

			// Skip non-formatable files
			if (!shouldFormat(absolutePath)) return;

			// Skip files that don't exist (shouldn't happen after write, but safe)
			if (!existsSync(absolutePath)) return;

			// Skip files that are too large
			try {
				const stats = statSync(absolutePath);
				if (stats.size > MAX_FILE_SIZE_BYTES) return;
			} catch {
				return;
			}

			// 🔒 Trust gate: skip formatting/linting on untrusted projects
			// Reading and executing project-local config files (prettier, eslint)
			// could be dangerous on untrusted projects, so bail out early.
			if (!ctx.isProjectTrusted()) return;

			// Step 1: Format the file in-place with --write
			const { command, args } = buildPrettierArgs(ctx.cwd, absolutePath);
			const result = await pi.exec.bind(pi)(command, args, { cwd: ctx.cwd, timeout: 15_000 });
			const ok = result.code === 0;

			// Mode-adaptive notification for format result
			if (ok) {
				if (ctx.mode === "tui") {
					ctx.ui.notify(`Formatted: ${filePath}`, "info");
				} else if (ctx.mode === "rpc") {
					pi.sendUserMessage(`Formatted: ${filePath}`, { deliverAs: "followUp" });
				}
				// JSON and print modes: no notification for format
			}

			// Step 2: ESLint on saved file (Tier 1 diagnostics, advisory only)
			if (shouldLint(absolutePath)) {
				const lintMsg = await runEslintOnFile(pi.exec.bind(pi), absolutePath, ctx.cwd);

				// Mode-adaptive notification for ESLint ran
				if (lintMsg && ctx.mode === "tui") {
					ctx.ui.notify(`ESLint ran: ${filePath}`, "info");
				}

				// Send diagnostic details as followUp in all modes (if any issues found)
				if (lintMsg) {
					// Non-blocking — deliver as followUp, Developer can proceed
					const followUp = [
						`## Lint Diagnostics — ${filePath}`,
						``,
						`ESLint found the following issues (advisory — not blocking):`,
						``,
						lintMsg,
					].join("\n");
					pi.sendUserMessage(followUp, { deliverAs: "followUp" });
				}
			}
		} catch (err) {
			console.error("format-on-save: error in tool_result handler:", err);
		}
	});
}
