/**
 * check-extensions — Audit extensions against pi CHANGELOG API changes
 *
 * Entry-point: registers /check-extensions command and delegates to
 * ChangelogPipeline for all phases.
 *
 * Usage: /check-extensions
 *
 * Security: pipeline only runs when project is trusted.
 * Mode-adaptive output: uses ctx.ui.notify in TUI/RPC modes,
 *   pi.sendMessage fallback in JSON/print modes.
 * Flag parsing: local parseArgs wrapper for future structured flags.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPipeline, type PipelineContext, type ParsedArgs } from "./pipeline.ts";

// ── Args type (mirrors parseArgs from @earendil-works/pi-coding-agent v0.78.0+) ──

/**
 * Local parseArgs wrapper — mirrors the pi-coding-agent v0.78.0+ API.
 * When pi is upgraded to >=0.78.0, replace with:
 *   import { parseArgs } from "@earendil-works/pi-coding-agent";
 */
export function parseCheckExtensionsArgs(raw: string | undefined): ParsedArgs {
	const result: ParsedArgs = {
		unknownFlags: new Map(),
		messages: [],
	};

	if (!raw || !raw.trim()) {
		return result;
	}

	const parts = raw.trim().split(/\s+/);

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]!;

		if (p.startsWith("--") && p.length > 2) {
			const eqIdx = p.indexOf("=");
			if (eqIdx !== -1) {
				const flagName = p.slice(2, eqIdx);
				const flagValue = p.slice(eqIdx + 1);
				result.unknownFlags.set(flagName, flagValue);
			} else {
				const flagName = p.slice(2);
				if (i + 1 < parts.length && !parts[i + 1]!.startsWith("--")) {
					result.unknownFlags.set(flagName, parts[++i]!);
				} else {
					result.unknownFlags.set(flagName, true);
				}
			}
		} else {
			result.messages.push(p);
		}
	}

	return result;
}

/**
 * Register the /check-extensions command with pi.
 * Named export so tests can reference it directly.
 */
export function registerCheckExtensions(pi: ExtensionAPI): void {
	pi.registerCommand("check-extensions", {
		description:
			"Audit extensions against pi CHANGELOG API changes. " +
			"Parses CHANGELOG.md, scans .pi/extensions/, " +
			"creates GitHub issues for affected extensions.",
		handler: async (args, ctx) => {
			// ── Project Trust Gate ────────────────────────────────────
			// Only scan project-local extensions when the project is trusted.
			// isProjectTrusted may not be in type definitions for older pi versions
			// but it exists at runtime in v0.79.1+. Use optional chaining via cast.
			const isTrusted = (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted?.();
			if (isTrusted === false) {
				const msg =
					"Project not trusted. Skipping extension scan. " +
					"Trust the project with /trust or run `pi trust` to enable extension auditing.";
				pi.sendUserMessage(msg);
				return;
			}

			// ── Parse Args ────────────────────────────────────────────
			// Parse structured flags (future use: --dry-run, --since, --extension).
			// Currently unused but establishes argument infrastructure.
			const parsedArgs = parseCheckExtensionsArgs(args);

			// Pass through to pipeline
			const pipelineCtx: PipelineContext = {
				cwd: ctx.cwd,
				ui: ctx.ui,
				hasUI: ctx.hasUI,
			};
			await runPipeline(pi, pipelineCtx, parsedArgs);
		},
	});
}

export default registerCheckExtensions;
