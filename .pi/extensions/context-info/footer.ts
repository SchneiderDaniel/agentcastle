/**
 * Custom footer installer for context-info extension
 *
 * Rich footer with git info, model, thinking level, TPS, and extension statuses.
 * Time/tokens/tools removed — those now display in supervisor's status bar
 * with threshold-colored styling (context-info styling applied to terminal).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStatusBarConfig, TpsSample } from "./types.js";
import { thinkingIcon, thinkingColor, formatTps, computeTps } from "./formatting.js";

/** Module-scope process start time — captures true pi process launch time */
export const processStartTime = Date.now();

export function installFooter(
	ctx: ExtensionContext,
	config: ContextStatusBarConfig | null,
	worktreeName: string | null,
	thinkingLevel: string,
	tpsSamples: TpsSample[],
	lastComputedTps: { value: number | null },
	lastContextWindow: { value: number | undefined },
	lastSampledOutput: { value: number | undefined },
	toolCallCount: { value: number },
): void {
	if (!config || config.enabled === false) {
		ctx.ui.setFooter(undefined);
		return;
	}

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				// ── LEFT: Git info ───────────────────────────
				const branch = footerData.getGitBranch();
				let leftStr = "";
				if (branch) {
					leftStr = theme.fg("accent", " ") + theme.fg("muted", branch);
					if (worktreeName) {
						leftStr += " " + theme.fg("dim", `[${worktreeName}]`);
					}
				} else {
					leftStr = theme.fg("dim", "⋄ no git");
				}

				// ── Separator character ──────────────────────
				const sep = theme.fg("dim", "│");

				// ── Extension statuses ───────────────────────
				const extStatuses = footerData.getExtensionStatuses();
				let extStr = "";
				if (extStatuses.size > 0) {
					const parts: string[] = [];
					for (const [, text] of extStatuses) {
						if (text) parts.push(text);
					}
					if (parts.length > 0) extStr = parts.join(" " + sep + " ");
				}

				// ── CENTER: Model + reasoning ────────────────
				const modelId = ctx.model?.id ?? "?";
				let centerStr = theme.fg("dim", "🧠 ") + theme.fg("accent", modelId);
				if (thinkingLevel) {
					const tIcon = thinkingIcon(thinkingLevel);
					const tColor = thinkingColor(thinkingLevel);
					const reasoningStr = theme.fg(tColor, `${tIcon} ${thinkingLevel}`);
					centerStr += " " + theme.fg("dim", "·") + " " + reasoningStr;
				}

				// ── TPS computation ───────────────────────────
				const computed = computeTps(tpsSamples);
				if (computed !== null) {
					lastComputedTps.value = computed;
				}

				// ── Build row 1: git │ model+thinking ────────────
				const leftW = visibleWidth(leftStr);
				const centerW = visibleWidth(centerStr);
				const sepUnit = 3;

				let row1: string;
				if (leftW + centerW + sepUnit <= width) {
					const leftSection = leftStr + " " + sep + " ";
					const leftSectionW = visibleWidth(leftSection);
					const centerPad = Math.max(0, width - leftSectionW - centerW);
					row1 = leftSection + " ".repeat(centerPad) + centerStr;
				} else {
					row1 = leftStr;
					if (row1.length < width) {
						const pad = width - visibleWidth(row1);
						row1 = centerW <= width ? centerStr : row1;
					}
				}

				row1 = truncateToWidth(row1, width);

				// ── Build row 2 (ext statuses left, TPS right) ──
				if (extStr || config.showTps) {
					const left2 = extStr || "";
					let right2 = "";
					if (config.showTps) {
						const tpsDisplay = formatTps(lastComputedTps.value);
						right2 = theme.fg("dim", tpsDisplay);
					}
					const lw = visibleWidth(left2);
					const rw = visibleWidth(right2);
					const gap = Math.max(0, width - lw - rw);
					const row2 = right2
						? left2 + " ".repeat(gap) + right2
						: left2 + " ".repeat(Math.max(0, width - lw));
					return [row1, truncateToWidth(row2, width)];
				}

				return [row1];
			},
		};
	});

	// Also keep the status key clear (footer replaces it)
	ctx.ui.setStatus("contextUsage", undefined);
}
