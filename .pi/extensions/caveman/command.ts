/**
 * /caveman command handler and settings dialog
 *
 * UI at the edge — depends on all other modules + pi-tui widgets.
 * Extracted from main function, no singleton capture.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "./config.ts";
import type { Level } from "./types.ts";
import { LEVELS, STOP_ALIASES, CAVEMAN_COMMAND_OPTIONS } from "./types.ts";

import { openConfigDialog } from "./config-ui.ts";

/**
 * Register the /caveman command and wire its handler.
 */
export function registerCavemanCommand(
	pi: ExtensionAPI,
	configStore: ConfigStore,
	syncStatus: (ctx: Pick<ExtensionContext, "ui">) => void,
): void {
	pi.registerCommand("caveman", {
		description:
			"Toggle caveman mode, set level, use off/stop/quit to disable, or 'config' to open settings",
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trim().toLowerCase();
			const items = CAVEMAN_COMMAND_OPTIONS.filter((item) => item.value.startsWith(normalized));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			// Open config dialog
			if (arg === "config") {
				await openConfigDialog(ctx, configStore, syncStatus);
				return;
			}

			if (!arg) {
				// Toggle: off → full, anything else → off
				const current = configStore.getLevel();
				configStore.setLevel(current === "off" ? "full" : "off");
			} else if (STOP_ALIASES.has(arg)) {
				configStore.setLevel("off");
			} else if (LEVELS.includes(arg as Level)) {
				configStore.setLevel(arg as Level);
			} else {
				ctx.ui.notify(
					`Unknown: "${arg}". Use: ${LEVELS.join(", ")}, stop, quit, or config`,
					"error",
				);
				return;
			}

			const level = configStore.getLevel();
			pi.appendEntry("caveman-level", { level });
			syncStatus(ctx);

			ctx.ui.notify(level === "off" ? "Caveman off" : `Caveman: ${level.toUpperCase()}`, "info");
		},
	});
}
