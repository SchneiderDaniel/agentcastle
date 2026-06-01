/**
 * check-extensions — Audit extensions against pi CHANGELOG API changes
 *
 * Entry-point: registers /check-extensions command and delegates to
 * ChangelogPipeline for all phases.
 *
 * Usage: /check-extensions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPipeline, type PipelineContext } from "./pipeline.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("check-extensions", {
		description:
			"Audit extensions against pi CHANGELOG API changes. " +
			"Parses CHANGELOG.md, scans .pi/extensions/, " +
			"creates GitHub issues for affected extensions.",
		handler: async (_args, ctx) => {
			const pipelineCtx: PipelineContext = {
				cwd: ctx.cwd,
				ui: ctx.ui,
			};
			await runPipeline(pi, pipelineCtx);
		},
	});
}
