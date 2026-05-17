/**
 * /caveman command handler and settings dialog
 *
 * UI at the edge — depends on all other modules + pi-tui widgets.
 * Extracted from main function, no singleton capture.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { ConfigStore } from "./config.ts";
import type { AnimationController } from "./animation.ts";
import type { Level } from "./types.ts";
import { LEVELS, STOP_ALIASES, CAVEMAN_COMMAND_OPTIONS, DEFAULT_CONFIG } from "./types.ts";
import { ANIMATIONS } from "./prompts.ts";
import type { CavemanConfig } from "./types.ts";

/**
 * Register the /caveman command and wire its handler.
 */
export function registerCavemanCommand(
	pi: ExtensionAPI,
	configStore: ConfigStore,
	animController: AnimationController,
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
				await openConfig(ctx, configStore, animController);
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
			animController.syncStatus(ctx);

			ctx.ui.notify(
				level === "off" ? "Caveman off" : `Caveman: ${ANIMATIONS[level].label}`,
				"info",
			);
		},
	});
}

// -- /caveman config: interactive SettingsList --

async function openConfig(
	ctx: ExtensionContext,
	configStore: ConfigStore,
	animController: AnimationController,
): Promise<void> {
	await configStore.ensureConfigLoaded();

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const config = configStore.getConfig();

		const items: SettingItem[] = [
			{
				id: "defaultLevel",
				label: "Default level for new sessions",
				currentValue: config.defaultLevel,
				values: [...LEVELS],
			},
			{
				id: "showStatus",
				label: "Show animated status bar",
				currentValue: config.showStatus ? "on" : "off",
				values: ["on", "off"],
			},
		];

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(" Caveman Config")), 0, 0));
		container.addChild(new Text(theme.fg("dim", " Saved to ~/.pi/agent/caveman.json"), 0, 0));
		container.addChild(
			new Text(theme.fg("dim", " Default level applies to future sessions."), 0, 0),
		);
		container.addChild(new Text("", 0, 0));

		const applySettingChange = (id: string, newValue: string) => {
			const currentConfig = configStore.getConfig();
			const updated: CavemanConfig = { ...currentConfig };
			if (id === "defaultLevel" && LEVELS.includes(newValue as Level)) {
				updated.defaultLevel = newValue as Level;
			} else if (id === "showStatus") {
				updated.showStatus = newValue === "on";
			}
			configStore.saveConfig(updated);
			animController.syncStatus(ctx);
		};

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 10),
			getSettingsListTheme(),
			applySettingChange,
			() => done(undefined),
		);

		container.addChild(settingsList);
		container.addChild(
			new Text(theme.fg("dim", " ←→/hl/tab change • ↑↓/jk move • esc close"), 0, 0),
		);

		const cycleSelectedValue = (direction: -1 | 1) => {
			const selectedIndex = (settingsList as unknown as { selectedIndex: number }).selectedIndex;
			const item = items[selectedIndex];
			if (!item?.values?.length) return;

			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + direction + item.values.length) % item.values.length;
			const newValue = item.values[nextIndex]!;
			item.currentValue = newValue;
			settingsList.updateValue(item.id, newValue);
			applySettingChange(item.id, newValue);
		};

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "j") data = "\u001b[B";
				else if (data === "k") data = "\u001b[A";
				else if (data === "h") {
					cycleSelectedValue(-1);
					_tui.requestRender();
					return;
				} else if (data === "l" || data === "\u001b[C" || data === "\t") {
					cycleSelectedValue(1);
					_tui.requestRender();
					return;
				} else if (data === "\u001b[D") {
					cycleSelectedValue(-1);
					_tui.requestRender();
					return;
				}

				settingsList.handleInput?.(data);
				_tui.requestRender();
			},
		};
	});
}
