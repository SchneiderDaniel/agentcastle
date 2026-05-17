/**
 * Caveman animation controller
 *
 * Closure-based state for timer, frame index, and active flag.
 * Receives getShowStatus and getLevel callbacks — decoupled from config store shape.
 * No direct pi API dependency — only uses ctx.ui.setStatus.
 */

import type { Level } from "./types.ts";
import { ANIMATIONS } from "./prompts.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Animation controller factory
// ---------------------------------------------------------------------------

export interface AnimationController {
	stopAnimation(): void;
	syncStatus(ctx: Pick<ExtensionContext, "ui">): void;
	setActive(active: boolean): void;
}

/**
 * Create an animation controller with closure-encapsulated state.
 *
 * @param getShowStatus — callback returning whether to show status animation
 * @param getLevel — callback returning current level
 */
export function createAnimationController(options: {
	getShowStatus: () => boolean;
	getLevel: () => Level;
}): AnimationController {
	const { getShowStatus, getLevel } = options;

	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let isActive = false;

	function stopAnimation() {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
	}

	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		stopAnimation();
		const theme = ctx.ui.theme;
		const level = getLevel();
		const showStatus = getShowStatus();

		if (level === "off" || !showStatus) {
			ctx.ui.setStatus("caveman", "");
			return;
		}

		const anim = ANIMATIONS[level];
		const setFrame = (frame: string) => {
			ctx.ui.setStatus(
				"caveman",
				frame + " " + theme.fg("muted", "caveman: ") + theme.fg("text", anim.label),
			);
		};

		if (!isActive) {
			setFrame(anim.frames[0]!);
			return;
		}

		const renderFrame = () => {
			setFrame(anim.frames[frameIndex % anim.frames.length]!);
			frameIndex++;
		};

		try {
			renderFrame();
			timer = setInterval(renderFrame, anim.interval);
			// unref so interval does not keep event loop alive
			timer.unref();
		} finally {
			// If setInterval throws, old timer already cleared — no leak
		}
	}

	function setActive(active: boolean) {
		isActive = active;
	}

	return {
		stopAnimation,
		syncStatus,
		setActive,
	};
}
