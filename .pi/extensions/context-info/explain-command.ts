/**
 * createExplainCommand — Generic factory for explain-* commands
 *
 * Consolidates 3 near-identical command registrations (/explain-extensions,
 * /explain-prompts, /explain-skills) into a single factory function.
 * Each command becomes a one-liner.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Word wrap helper ─────────────────────────────────────────────

/**
 * Wrap text to fit within maxWidth, breaking at word boundaries.
 * Falls back to hard cutting at maxWidth if no space is found.
 */
function wordWrap(text: string, maxWidth: number): string[] {
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

// ─── Factory ───────────────────────────────────────────────────────

/**
 * Create and register an explain-* command.
 *
 * @param pi - ExtensionAPI for command registration
 * @param commandName - Command name (e.g. "explain-extensions")
 * @param title - Singular title for display (e.g. "extension", "prompt", "skill")
 * @param listFn - Function returning items to display
 */
export function createExplainCommand<
	T extends { name: string; description?: string | null; error?: string },
>(pi: ExtensionAPI, commandName: string, title: string, listFn: () => T[]): void {
	pi.registerCommand(commandName, {
		description: `List all project-local ${title}s with descriptions`,
		handler: async (_args, ctx) => {
			const items = listFn();
			if (items.length === 0) {
				ctx.ui.notify(`No ${title}s found`, "info");
				return;
			}

			ctx.ui.setWidget(commandName, (_tui, theme) => {
				const accent = (s: string) => theme.fg("accent", s);
				const dim = (s: string) => theme.fg("dim", s);

				const renderedLines: { name: string; desc: string }[] = items.map((item) => {
					// If item has an error property, prefix it
					const raw =
						item.error !== undefined
							? `error: ${item.error}`
							: (item.description ?? "(no description)");
					return {
						name: item.name,
						desc: raw.split("\n")[0].trim(),
					};
				});

				return {
					render: (width: number) => {
						const lines: string[] = [];
						const descWidth = Math.max(20, width - 6);

						for (const item of renderedLines) {
							lines.push(accent("  " + item.name));
							const wrapped = wordWrap(item.desc, descWidth);
							for (const seg of wrapped) {
								lines.push(dim("    " + seg));
							}
						}

						lines.push("");
						lines.push(
							dim("  ─ ") +
								dim(String(items.length)) +
								dim(` ${title}s ─ disappears when you type`),
						);

						return lines.map((line) => {
							if (line === "" || line.trim() === "") return "";
							return line;
						});
					},
					invalidate: () => {},
				};
			});
		},
	});
}
