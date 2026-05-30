import assert from "node:assert";
import { describe, it } from "node:test";

import {
	beginSessionLoggerSession,
	createSessionLoggerGate,
	getSessionLoggerState,
	toggleSessionLoggerGate,
} from "../.pi/extensions/session-logger/index.ts";

describe("session-logger gate", () => {
	it("applies /session-logger off to the next session without disabling the current one", () => {
		const gate = createSessionLoggerGate(true);

		assert.strictEqual(beginSessionLoggerSession(gate), true);
		assert.strictEqual(gate.sessionEnabled, true);

		assert.strictEqual(toggleSessionLoggerGate(gate, "off"), false);
		assert.strictEqual(gate.enabledForNextSession, false);
		assert.strictEqual(gate.sessionEnabled, true);

		assert.strictEqual(beginSessionLoggerSession(gate), false);
		assert.strictEqual(gate.sessionEnabled, false);
	});

	it("re-enables logging only when a later session starts", () => {
		const gate = createSessionLoggerGate(false);

		assert.strictEqual(beginSessionLoggerSession(gate), false);
		assert.strictEqual(toggleSessionLoggerGate(gate, "on"), true);
		assert.strictEqual(gate.sessionEnabled, false);

		assert.strictEqual(beginSessionLoggerSession(gate), true);
		assert.strictEqual(gate.sessionEnabled, true);
	});
});

describe("getSessionLoggerState", () => {
	it("gate sessionEnabled=true → returns true", () => {
		const gate = createSessionLoggerGate(true);
		beginSessionLoggerSession(gate);
		assert.strictEqual(getSessionLoggerState(gate), true);
	});

	it("gate sessionEnabled=false → returns false", () => {
		const gate = createSessionLoggerGate(false);
		beginSessionLoggerSession(gate);
		assert.strictEqual(getSessionLoggerState(gate), false);
	});

	it("gate is null → returns null", () => {
		assert.strictEqual(getSessionLoggerState(null), null);
	});

	it("gate is undefined → returns null", () => {
		assert.strictEqual(getSessionLoggerState(undefined), null);
	});

	it("toggle off then beginSessionLoggerSession — reflects sessionEnabled, not enabledForNextSession", () => {
		const gate = createSessionLoggerGate(true);
		beginSessionLoggerSession(gate); // sessionEnabled = true
		toggleSessionLoggerGate(gate, "off"); // enabledForNextSession = false, sessionEnabled still true

		// Before next session starts, getter reflects current sessionEnabled = true
		assert.strictEqual(getSessionLoggerState(gate), true);
		assert.strictEqual(gate.sessionEnabled, true);
		assert.strictEqual(gate.enabledForNextSession, false);

		// Next session starts
		beginSessionLoggerSession(gate); // sessionEnabled = enabledForNextSession = false
		assert.strictEqual(getSessionLoggerState(gate), false);
		assert.strictEqual(gate.sessionEnabled, false);
	});

	it("gate with uninitialized values (no beginSessionLoggerSession) — sessionEnabled matches initial", () => {
		const gate = createSessionLoggerGate(true);
		// No beginSessionLoggerSession called — sessionEnabled is already initialized
		assert.strictEqual(getSessionLoggerState(gate), true);
	});
});
