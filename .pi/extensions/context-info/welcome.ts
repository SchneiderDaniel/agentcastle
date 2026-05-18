/**
 * Startup welcome banner widget for context-info extension
 *
 * Shows castle art and extension/prompt/theme/skill counts on session start.
 * All file I/O is deferred to function execution time.
 */

import { existsSync, readdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countExtensions } from "./extensions.js";

function listNames(dir: string, suffix: string): string[] {
	try {
		if (!existsSync(dir)) return [];
		const results: string[] = [];
		const walk = (d: string) => {
			const entries = readdirSync(d, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = joinPath(d, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "." && entry.name !== "..") {
						walk(fullPath);
					}
				} else if (entry.isFile() && entry.name.endsWith(suffix)) {
					results.push(entry.name.replace(new RegExp(`${suffix.replace(".", "\\.")}$`), ""));
				}
			}
		};
		walk(dir);
		return results.sort();
	} catch {
		return [];
	}
}

function countSkills(): number {
	try {
		const skillsDir = ".pi/skills";
		if (!existsSync(skillsDir)) return 0;
		const entries = readdirSync(skillsDir, { withFileTypes: true });
		let count = 0;
		for (const entry of entries) {
			if (entry.name === ".gitkeep") continue;
			if (entry.isFile() && entry.name.endsWith(".md")) {
				count++;
			} else if (entry.isDirectory() && entry.name !== "." && entry.name !== "..") {
				const skillMdPath = joinPath(skillsDir, entry.name, "SKILL.md");
				if (existsSync(skillMdPath)) count++;
			}
		}
		return count;
	} catch {
		return 0;
	}
}

export function showWelcomeBanner(
	ctx: ExtensionContext,
	startupWidgetActive: { value: boolean },
): void {
	const extCount = countExtensions();
	const promptCount = listNames(".pi/prompts", ".md").length;
	const themeCount = listNames(".pi/themes", ".json").length;
	const skillCount = countSkills();

	ctx.ui.setWidget("agentcastle-welcome", (_tui, theme) => {
		return {
			dispose() {},
			invalidate() {},
			render(_width: number): string[] {
				const dim = (s: string) => theme.fg("dim", s);
				const muted = (s: string) => theme.fg("muted", s);
				const accent = (s: string) => theme.fg("accent", s);

				const baseW = 64;

				// ── Centered title ────────────────────────
				const titleText = "\ud83c\udff0 Agent Castle";
				const titleVis = visibleWidth(titleText);
				const titlePad = Math.max(0, Math.floor((baseW - titleVis) / 2));
				const titleLine =
					" ".repeat(titlePad) + accent(titleText) + " ".repeat(baseW - titlePad - titleVis);

				// ── Castle art (towers + walls) ────────────
				const castle: string[] = [
					"       #_||_#                #_||_#                #_||_#",
					"       \\####/                \\####/                \\####/",
					"       _|  |_                _|  |_                _|  |_",
					"  # # # |  | # # # # # # # # #|  | # # # # # # # #  |  | # # #",
					"  |-----|  |-----|-------|----|  |----|-------|-----|  |-----|",
					"  |     /  \\     |       |    /  \\    |       |     /  \\     |",
					" /     |    |     \\  /\\  /   |    |   \\  /\\  /     |    |     \\",
					"|      |    |      \\/  \\/    |    |    \\/  \\/      |    |      |",
					"|______[____]________________[____]________________[____]______|",
				];

				// Pad all castle lines to baseW
				const castleLines = castle.map((line) => {
					const w = visibleWidth(line);
					return dim(w < baseW ? line + " ".repeat(baseW - w) : line);
				});

				// ── Stats lines ────────────────────────────
				function statLine(label: string, value: string): string {
					const labelStr = muted(label);
					const valueStr = accent(value);
					const rawLabelW = visibleWidth(label);
					const rawValueW = visibleWidth(value);
					const padding = 60 - rawLabelW - rawValueW;
					return dim("| ") + labelStr + valueStr + " ".repeat(Math.max(0, padding)) + dim(" |");
				}

				const statLines: string[] = [
					// Extensions line with /explain-extensions hint
					(() => {
						const labelStr = muted("🧩 Extensions: ");
						const valueStr = accent(String(extCount));
						const hintStr = dim(" (/explain-extensions)");
						const rawLabelW = visibleWidth("🧩 Extensions: ");
						const rawValueW =
							visibleWidth(String(extCount)) + visibleWidth(" (/explain-extensions)");
						const padding = 60 - rawLabelW - rawValueW;
						return (
							dim("| ") +
							labelStr +
							valueStr +
							hintStr +
							" ".repeat(Math.max(0, padding)) +
							dim(" |")
						);
					})(),
					statLine("📝 Prompts:    ", String(promptCount)),
					statLine("🎨 Themes:     ", String(themeCount)),
					statLine("🔧 Skills:     ", String(skillCount)),
				];

				// Bottom wall
				const bottom = dim("|" + "_".repeat(62) + "|");

				return [titleLine, "", ...castleLines, ...statLines, bottom];
			},
		};
	});
	startupWidgetActive.value = true;
}
