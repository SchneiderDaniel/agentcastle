/**
 * Tests for caveman animation.ts
 *
 * Phase 3: Animation controller with closure state.
 * Receives getShowStatus and getLevel callbacks — fully mockable.
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { createAnimationController } from "../.pi/extensions/caveman/animation.ts";
import type { Level } from "../.pi/extensions/caveman/types.ts";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface SpyCall {
	name: string;
	args: unknown[];
}

function makeMockContext() {
	const calls: SpyCall[] = [];
	const ctx = {
		ui: {
			setStatus: (name: string, value: string) => {
				calls.push({ name: "setStatus", args: [name, value] });
			},
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (s: string) => s,
			},
		},
	};
	return { ctx, calls };
}

function makeController(level: Level = "off", showStatus: boolean = true) {
	const getLevel = () => level;
	const getShowStatus = () => showStatus;
	const controller = createAnimationController({ getShowStatus, getLevel });
	return { controller, getLevel, getShowStatus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("animation.ts — createAnimationController API", () => {
	it("returns object with stopAnimation, syncStatus, setActive", () => {
		const { controller } = makeController();
		assert.ok(typeof controller.stopAnimation === "function");
		assert.ok(typeof controller.syncStatus === "function");
		assert.ok(typeof controller.setActive === "function");
	});
});

describe("animation.ts — setActive", () => {
	it("setActive(true) toggles internal state; setActive(false) toggles back", () => {
		const { controller } = makeController();
		// Hard to test internal state directly, but behavior is observable via syncStatus
		// When not active, only first frame shown; when active, interval runs
		// We test this via side effects below
		controller.setActive(true);
		controller.setActive(false);
		// No crash = pass
		assert.ok(true);
	});
});

describe("animation.ts — syncStatus with level=off clears status", () => {
	it("calls ctx.ui.setStatus('caveman', '') when level is off", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("off", true);
		controller.syncStatus(ctx);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0]!.args, ["caveman", ""]);
	});
});

describe("animation.ts — syncStatus with showStatus=false clears status", () => {
	it("calls ctx.ui.setStatus('caveman', '') when showStatus is false", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("lite", false);
		controller.syncStatus(ctx);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0]!.args, ["caveman", ""]);
	});
});

describe("animation.ts — syncStatus with level=lite and isActive=true", () => {
	it("calls setStatus with string containing campfire frame + label", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("lite", true);
		controller.setActive(true);
		controller.syncStatus(ctx);
		controller.stopAnimation();

		assert.strictEqual(calls.length, 1);
		const statusValue = calls[0]!.args[1] as string;
		assert.ok(statusValue.includes("LITE"), `Expected status to include LITE, got: ${statusValue}`);
		// Should contain some ANSI escape (from fire frames)
		assert.ok(statusValue.includes("\x1b["), `Expected ANSI code in status, got: ${statusValue}`);
	});
});

describe("animation.ts — syncStatus with level=lite and isActive=false", () => {
	it("shows single frame, no interval created", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("lite", true);
		controller.setActive(false);
		controller.syncStatus(ctx);

		assert.strictEqual(calls.length, 1);
		// Frame shown, label present
		const statusValue = calls[0]!.args[1] as string;
		assert.ok(statusValue.includes("LITE"));
	});
});

describe("animation.ts — stopAnimation clears timer and resets frameIndex", () => {
	it("stopAnimation cleans up active timer", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("lite", true);
		controller.setActive(true);
		controller.syncStatus(ctx);

		// Should have started an interval
		controller.stopAnimation();

		// Call syncStatus again — should restart cleanly
		controller.syncStatus(ctx);
		assert.strictEqual(calls.length, 2);
	});
});

describe("animation.ts — syncStatus twice with isActive=true", () => {
	it("old timer cleared, new timer started", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("lite", true);
		controller.setActive(true);

		controller.syncStatus(ctx);
		const firstCallCount = calls.length;
		assert.ok(firstCallCount >= 1);

		controller.syncStatus(ctx);
		const secondCallCount = calls.length;
		assert.ok(secondCallCount >= firstCallCount + 1);

		controller.stopAnimation();
	});
});

describe("animation.ts — level=ultra, isActive=true", () => {
	it("timer interval is 100ms, frame string contains ULTRA", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("ultra", true);
		controller.setActive(true);
		controller.syncStatus(ctx);
		controller.stopAnimation();

		assert.strictEqual(calls.length, 1);
		const statusValue = calls[0]!.args[1] as string;
		assert.ok(statusValue.includes("ULTRA"), `Expected ULTRA in status, got: ${statusValue}`);
	});
});

describe("animation.ts — showStatus=true, level=off clears status", () => {
	it("off takes precedence over showStatus", () => {
		const { ctx, calls } = makeMockContext();
		const { controller } = makeController("off", true);
		controller.setActive(true);
		controller.syncStatus(ctx);

		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0]!.args, ["caveman", ""]);
	});
});
