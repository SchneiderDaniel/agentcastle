/**
 * Widget render utilities for context-info
 *
 * Shared helpers for explain-prompts, explain-skills, explain-extensions.
 * Eliminates duplicate wordWrap() and render() logic across command handlers.
 *
 * Presentation adapter layer — depends on @earendil-works/pi-tui for visibleWidth
 * and @earendil-works/pi-coding-agent for Theme type.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

// ─── Types ────────────────────────────────────────────────────────

export interface WidgetItem {
	name: string;
	desc: string;
}

/**
 * Word-wrap text to fit within maxWidth using visible character width.
 * Breaks at last space within the limit, or hard-cuts if no space found.
 */
export function wordWrap(text: string, maxWidth: number): string[] {
	if (visibleWidth(text) <= maxWidth) return [text];
	const result: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (visibleWidth(remaining) <= maxWidth) {
			result.push(remaining);
			break;
		}
		// Find last space within maxWidth
		let cut = maxWidth;
		while (cut > 0 && remaining[cut] !== " " && remaining[cut] !== undefined) {
			cut--;
		}
		if (cut <= 0) cut = maxWidth; // no space found, hard cut
		result.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	return result;
}

/**
 * Format the footer line for explain-* widgets.
 * Returns a string like "  ─ 3 prompts ─ disappears when you type".
 */
export function formatFooter(count: number, label: string): string {
	return `  ─ ${count} ${label} ─ disappears when you type`;
}

/**
 * Create a widget factory for rendering a list of items with name + word-wrapped description.
 *
 * Returns a function compatible with ctx.ui.setWidget(name, callback) signature.
 * Each item renders as:
 *   accent("  " + name)
 *   dim("    " + desc_line_1)
 *   dim("    " + desc_line_2)
 *   ...
 * Followed by empty line and footer.
 *
 * @param items — list of items to render
 * @param count — total count for footer display
 * @param label — label (e.g. "prompts", "skills", "extensions") for footer
 * @returns widget factory (_tui, theme) => { render, invalidate }
 */
export function renderItemList(
	items: WidgetItem[],
	count: number,
	label: string,
): (
	_tui: unknown,
	theme: Theme,
) => { render: (width: number) => string[]; invalidate: () => void } {
	return (_tui: unknown, theme: Theme) => {
		const accent = (s: string) => theme.fg("accent", s);
		const dim = (s: string) => theme.fg("dim", s);

		return {
			render: (width: number) => {
				const lines: string[] = [];
				const descWidth = Math.max(20, width - 6);

				for (const item of items) {
					lines.push(accent("  " + item.name));
					const wrapped = wordWrap(item.desc, descWidth);
					for (const seg of wrapped) {
						lines.push(dim("    " + seg));
					}
				}

				lines.push("");
				lines.push(dim(formatFooter(count, label)));

				return lines.map((line) => {
					if (line === "" || line.trim() === "") return "";
					return line;
				});
			},
			invalidate: () => {},
		};
	};
}
