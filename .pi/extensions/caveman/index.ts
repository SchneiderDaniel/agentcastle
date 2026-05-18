/**
 * Caveman — Compresses AI responses into terse, no-fluff style
 *
 * Strips articles, filler, and pleasantries from all agent output.
 * Adjustable intensity via /caveman command.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createConfigStore } from "./config.ts";
import { createAnimationController } from "./animation.ts";
import { registerCavemanCommand } from "./command.ts";
import { LEVELS, DEFAULT_CONFIG } from "./types.ts";
import { CAVEMAN_BASE, INTENSITY } from "./prompts.ts";
import type { Level } from "./types.ts";

export default function caveman(pi: ExtensionAPI): void {
	const configStore = createConfigStore();
	const animController = createAnimationController({
		getShowStatus: () => configStore.getConfig().showStatus,
		getLevel: () => configStore.getLevel(),
	});

	// -- Restore state on session load --

	pi.on("session_start", async (_event, ctx) => {
		await configStore.ensureConfigLoaded();

		// Check for session-level override first (resuming a session)
		let sessionLevel: Level | null = null;

		function isCavemanLevelData(data: unknown): data is { level: Level } {
			return (
				typeof data === "object" &&
				data !== null &&
				"level" in data &&
				typeof (data as Record<string, unknown>).level === "string" &&
				LEVELS.includes((data as Record<string, unknown>).level as Level)
			);
		}
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "caveman-level") {
				if (isCavemanLevelData(entry.data)) {
					sessionLevel = entry.data.level;
				}
			}
		}

		if (sessionLevel !== null) {
			// Resuming — use session state
			configStore.setLevel(sessionLevel);
		} else if (configStore.getConfig().defaultLevel !== "off") {
			// New session — apply default from config
			configStore.setLevel(configStore.getConfig().defaultLevel);
			pi.appendEntry("caveman-level", { level: configStore.getLevel() });
		}

		animController.syncStatus(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		animController.setActive(true);
		animController.syncStatus(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		animController.setActive(false);
		animController.syncStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		animController.stopAnimation();
		animController.setActive(false);
	});

	// -- /caveman command --

	registerCavemanCommand(pi, configStore, animController);

	// -- Inject caveman rules into system prompt --

	pi.on("before_agent_start", async (event) => {
		await configStore.ensureConfigLoaded();
		const level = configStore.getLevel();
		if (level === "off") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${CAVEMAN_BASE}\n\n${INTENSITY[level]}`,
		};
	});
}
