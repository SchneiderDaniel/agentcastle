/**
 * FooterState — Encapsulated state container for context-info footer
 *
 * Consolidates all mutable state that was previously spread across
 * closure variables, ref objects, and mutable arrays in index.ts.
 *
 * Events delegate to this class, which provides a single source of truth
 * for footer rendering, timer management, TPS sampling, and tool call tracking.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextStatusBarConfig, TpsSample } from "./types.js";

/** Callback signature for installing the footer */
export type InstallFooterFn = (ctx: ExtensionContext, state: FooterState) => void;

export class FooterState {
	// ── State properties ──────────────────────────────────────────
	config: ContextStatusBarConfig | null = null;
	lastContextWindow: number | undefined = undefined;
	emitted = false;
	thinkingLevel = "";
	worktreeName: string | null = null;
	timerInterval: ReturnType<typeof setInterval> | null = null;
	tpsSamples: TpsSample[] = [];
	lastComputedTps: number | null = null;
	lastSampledOutput: number | undefined = undefined;
	toolCallCount = 0;
	startupWidgetActive = false;
	cacheRead: number | undefined = undefined;
	cacheWrite: number | undefined = undefined;

	ctx: ExtensionContext;
	installFooterCb: InstallFooterFn;

	constructor(ctx: ExtensionContext, installFooterCb: InstallFooterFn = () => {}) {
		this.ctx = ctx;
		this.installFooterCb = installFooterCb;
	}

	/** Invoke the footer install callback with current context and state */
	callInstallFooter(): void {
		this.installFooterCb(this.ctx, this);
	}

	// ── Timer management ─────────────────────────────────────────

	startTimer(): void {
		this.stopTimer();
		this.timerInterval = setInterval(() => {
			if (this.config) {
				this.callInstallFooter();
			}
		}, 1000);
	}

	stopTimer(): void {
		if (this.timerInterval !== null) {
			clearInterval(this.timerInterval);
			this.timerInterval = null;
		}
	}

	// ── TPS sampling ──────────────────────────────────────────────

	sampleTps(output: number | undefined): void {
		if (typeof output !== "number" || output < 0) return;
		// Detect reset between responses (new response starts from 0)
		if (typeof this.lastSampledOutput === "number" && output < this.lastSampledOutput) {
			this.tpsSamples.length = 0;
		}
		this.lastSampledOutput = output;
		const now = Date.now();
		this.tpsSamples.push({ time: now, cumulativeTokens: output });
		// Prune samples older than 30s
		const cutoff = now - 30_000;
		while (this.tpsSamples.length > 0 && this.tpsSamples[0]!.time < cutoff) {
			this.tpsSamples.shift();
		}
	}

	// ── Tool call tracking ────────────────────────────────────────

	addToolCall(): void {
		this.toolCallCount++;
		this.callInstallFooter();
	}

	// ── State reset (for session boundaries) ──────────────────────

	resetProperties(): void {
		this.config = null;
		this.lastContextWindow = undefined;
		this.emitted = false;
		this.thinkingLevel = "";
		this.worktreeName = null;
		this.tpsSamples.length = 0;
		this.lastComputedTps = null;
		this.lastSampledOutput = undefined;
		this.toolCallCount = 0;
		this.startupWidgetActive = false;
		this.cacheRead = undefined;
		this.cacheWrite = undefined;
	}
}
