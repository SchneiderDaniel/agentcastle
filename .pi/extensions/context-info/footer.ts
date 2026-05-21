/**
 * Custom footer installer for context-info extension
 *
 * Rich Neovim/lain-inspired status bar with git info, model, thinking level,
 * session timer, token usage, and TPS.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStatusBarConfig, TpsSample } from "./types.js";
import {
	formatSessionTimer,
	formatTokens,
	fgHex,
	pickThresholdHex,
	thinkingIcon,
	thinkingColor,
	formatTps,
	computeTps,
} from "./formatting.js";

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

	const showTimer = config.showTimer;

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsubBranch,
			invalidate() {},
			render(width: number): string[] {
				// ── Compute token usage ───────────────────────
				const usage = ctx.getContextUsage();
				const tokens = usage?.tokens ?? null;
				const cw = usage?.contextWindow ?? lastContextWindow.value;
				if (cw && cw > 0) lastContextWindow.value = cw;

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

				// ── Extension statuses ───────────────────────
				const extStatuses = footerData.getExtensionStatuses();
				let extStr = "";
				if (extStatuses.size > 0) {
					const parts: string[] = [];
					for (const [, text] of extStatuses) {
						if (text) parts.push(text);
					}
					if (parts.length > 0) extStr = parts.join(" ");
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

				// ── Tool call counter ─────────────────────────
				const toolStr =
					theme.fg("dim", "🔧") + " " + theme.fg("muted", String(toolCallCount.value));
				centerStr += " " + theme.fg("dim", "·") + " " + toolStr;

				// ── RIGHT: Session timer + token usage + percentage ──
				let rightStr = "";

				// Compute timer string
				let timerStr = "";
				if (showTimer) {
					const elapsed = Date.now() - processStartTime;
					const rawTimer = formatSessionTimer(elapsed);
					timerStr = theme.fg("dim", rawTimer);
				}

				// Compute token display string
				let tokenDisplay = "";
				if (tokens !== null && tokens !== undefined) {
					const currentFmt = formatTokens(tokens);
					const maxFmt = lastContextWindow.value ? formatTokens(lastContextWindow.value) : "?";
					const pct =
						lastContextWindow.value && lastContextWindow.value > 0
							? Math.round((tokens / lastContextWindow.value) * 100)
							: null;

					const usageHex = pickThresholdHex(tokens, config.thresholds);

					const tokenText = `${currentFmt}/${maxFmt}`;
					tokenDisplay = theme.fg("dim", "◉ ") + fgHex(usageHex, tokenText);

					if (pct !== null) {
						const pctColor = pct >= 90 ? "error" : pct >= 70 ? "warning" : "dim";
						tokenDisplay += " " + theme.fg(pctColor, `[${pct}%]`);
					}
				} else if (lastContextWindow.value) {
					tokenDisplay = theme.fg("dim", `◉ .../${formatTokens(lastContextWindow.value)}`);
				} else {
					tokenDisplay = theme.fg("dim", "◉ .../?");
				}

				// Combine timer and token display
				if (timerStr && tokenDisplay) {
					rightStr = `${timerStr} \u00b7 ${tokenDisplay}`;
				} else if (timerStr) {
					rightStr = timerStr;
				} else {
					rightStr = tokenDisplay;
				}

				// ── TPS computation ───────────────────────────
				const computed = computeTps(tpsSamples);
				if (computed !== null) {
					lastComputedTps.value = computed;
				}

				// ── Separator character ──────────────────────
				const sep = theme.fg("dim", "│");

				// ── Left side only (git info) ─────────────
				const fullLeft = leftStr;

				// ── Build row 1 ──────────────────────────────
				const leftW = visibleWidth(fullLeft);
				const centerW = visibleWidth(centerStr);
				const rightW = visibleWidth(rightStr);

				const sepUnit = 3;

				let row1: string;
				if (leftW + centerW + rightW + 2 * sepUnit <= width) {
					const leftSection = fullLeft + " " + sep + " ";
					const centerSection = centerStr + " " + sep + " ";
					const beforeRight = leftSection + centerSection;
					const beforeRightW = visibleWidth(beforeRight);
					const padForRight = Math.max(0, width - beforeRightW - rightW);
					row1 = beforeRight + " ".repeat(padForRight) + rightStr;
				} else if (leftW + rightW + sepUnit <= width) {
					const leftSection = fullLeft + " " + sep + " ";
					const leftSectionW = visibleWidth(leftSection);
					const padBeforeRight = Math.max(0, width - leftSectionW - rightW);
					row1 = leftSection + " ".repeat(padBeforeRight) + rightStr;
				} else {
					row1 = " ".repeat(Math.max(0, width - rightW)) + rightStr;
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
