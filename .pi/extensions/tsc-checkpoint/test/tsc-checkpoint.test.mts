/**
 * Tests for tsc-checkpoint incremental watch mode
 *
 * Phases 1–4: DiagnosticsWatcher lifecycle, cache, file-path resolution, trends
 * Phase 5: Integration — extension entry point (/check command)
 *
 * Imports from the source module for true integration testing.
 * The real TypeScriptWatchAdapter is NOT used here — tests use MockAdapter
 * to keep tests fast and deterministic.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/tsc-checkpoint/test/tsc-checkpoint.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import { resolve } from "node:path";

import {
	DiagnosticsWatcher,
	resolveDiagnosticFilePath,
	formatDiagnostics,
	formatTrend,
	runTscCheckpoint,
} from "../index.ts";

import type { TscDiagnostic, TscWatchAdapter, TscCheckpointResult } from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Mock Adapter for Testing
// ═══════════════════════════════════════════════════════════════════════

class MockAdapter implements TscWatchAdapter {
	startCalls = 0;
	stopCalls = 0;
	lastStartPath = "";
	private _isRunning = false;
	private _diagnostics: TscDiagnostic[] = [];
	private _listeners: Array<(diagnostics: TscDiagnostic[]) => void> = [];
	private _shouldFailStart = false;

	setShouldFailStart(fail: boolean): void {
		this._shouldFailStart = fail;
	}

	start(tsconfigPath: string): boolean {
		this.startCalls++;
		this.lastStartPath = tsconfigPath;
		if (this._isRunning) return false;
		if (this._shouldFailStart) {
			throw new Error(`tsconfig not found: ${tsconfigPath}`);
		}
		this._isRunning = true;
		return true;
	}

	stop(): void {
		this.stopCalls++;
		this._isRunning = false;
	}

	isRunning(): boolean {
		return this._isRunning;
	}

	getDiagnostics(): TscDiagnostic[] {
		return this._diagnostics;
	}

	onDiagnosticsChange(callback: (diagnostics: TscDiagnostic[]) => void): void {
		this._listeners.push(callback);
	}

	/** Test helper: simulate a diagnostic event from the watch process */
	emitDiagnostics(diagnostics: TscDiagnostic[]): void {
		this._diagnostics = diagnostics;
		for (const listener of this._listeners) {
			listener(diagnostics);
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: DiagnosticsWatcher — Lifecycle
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (lifecycle)", () => {
	it("stores tsconfigPath and sets watchOptions to defaults", () => {
		const w = new DiagnosticsWatcher("/some/path/tsconfig.json");
		assert.strictEqual(w.tsconfigPathValue, "/some/path/tsconfig.json");
		assert.deepStrictEqual(w.watchOptionsValue, {});
	});

	it("stores custom TscWatchOptions", () => {
		const w = new DiagnosticsWatcher("/path/tsconfig.json", {
			pollInterval: 5000,
		});
		assert.strictEqual(w.watchOptionsValue.pollInterval, 5000);
	});

	it("start() with non-existent tsconfig throws", () => {
		const w = new DiagnosticsWatcher("/nonexistent/tsconfig.json");
		assert.throws(() => w.start(), {
			message: /tsconfig not found/,
		});
	});

	it("start() once returns true, isRunning() returns true", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		const result = w.start();
		assert.strictEqual(result, true);
		assert.strictEqual(w.isRunning(), true);
		assert.strictEqual(adapter.startCalls, 1);
	});

	it("start() twice returns false, isRunning() stays true", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();
		const result = w.start();
		assert.strictEqual(result, false);
		assert.strictEqual(w.isRunning(), true);
		assert.strictEqual(adapter.startCalls, 1);
	});

	it("stop() closes watch, isRunning() returns false", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();
		assert.strictEqual(w.isRunning(), true);
		w.stop();
		assert.strictEqual(w.isRunning(), false);
		assert.strictEqual(adapter.stopCalls, 1);
	});

	it("stop() when not running is no-op", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.stop(); // not started
		assert.strictEqual(adapter.stopCalls, 0);
		assert.strictEqual(w.isRunning(), false);
	});

	it("getDiagnostics() before any event returns []", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		assert.deepStrictEqual(w.getDiagnostics(), []);
	});

	it("getDiagnostics() after watcher reports errors returns cached diagnostics", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		const sampleDiags: TscDiagnostic[] = [
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		];
		adapter.emitDiagnostics(sampleDiags);

		const result = w.getDiagnostics();
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.code, "TS2322");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: Incremental Re-check & Diagnostic Cache
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (incremental re-check & cache)", () => {
	let adapter: MockAdapter;
	let watcher: DiagnosticsWatcher;

	beforeEach(() => {
		adapter = new MockAdapter();
		watcher = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		watcher.start();
	});

	it("file-change triggers watcher callback → onDiagnosticsChange fires with new diagnostics", () => {
		let changeFired = false;
		let receivedDiags: TscDiagnostic[] | undefined;

		watcher.onDiagnosticsChange((diags) => {
			changeFired = true;
			receivedDiags = diags;
		});

		const newDiags: TscDiagnostic[] = [
			{
				file: "src/new.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "New error",
				code: "TS2304",
				filePath: "/project/src/new.ts",
			},
		];
		adapter.emitDiagnostics(newDiags);

		assert.strictEqual(changeFired, true);
		assert.strictEqual(receivedDiags!.length, 1);
		assert.strictEqual(receivedDiags![0]!.code, "TS2304");
	});

	it("getDiagnostics() called twice with no file changes returns same array reference (cached)", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		];
		adapter.emitDiagnostics(diags);

		const first = watcher.getDiagnostics();
		const second = watcher.getDiagnostics();

		// Should return the same cached array reference
		assert.strictEqual(first, second);
		assert.strictEqual(first.length, 1);
	});

	it("new file with error added → updated diagnostics", () => {
		const initialDiags: TscDiagnostic[] = [
			{
				file: "src/a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "Error A",
				code: "TS2322",
				filePath: "/project/src/a.ts",
			},
		];
		adapter.emitDiagnostics(initialDiags);
		assert.strictEqual(watcher.getDiagnostics().length, 1);

		const updatedDiags: TscDiagnostic[] = [
			{
				file: "src/a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "Error A",
				code: "TS2322",
				filePath: "/project/src/a.ts",
			},
			{
				file: "src/b.ts",
				line: 5,
				column: 3,
				severity: "Error",
				message: "Error B",
				code: "TS2304",
				filePath: "/project/src/b.ts",
			},
		];
		adapter.emitDiagnostics(updatedDiags);
		assert.strictEqual(watcher.getDiagnostics().length, 2);
		assert.strictEqual(watcher.getDiagnostics()[1]!.code, "TS2304");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: File-Path Resolution
// ═══════════════════════════════════════════════════════════════════════

describe("resolveDiagnosticFilePath", () => {
	it("resolves relative path to absolute against tsconfig dir", () => {
		const result = resolveDiagnosticFilePath("src/app.ts", "/home/user/project");
		assert.strictEqual(result, "/home/user/project/src/app.ts");
	});

	it("already absolute path returned as-is", () => {
		const result = resolveDiagnosticFilePath("/home/user/project/src/app.ts", "/other/dir");
		assert.strictEqual(result, "/home/user/project/src/app.ts");
	});

	it("Windows absolute path returned as-is", () => {
		const result = resolveDiagnosticFilePath("C:\\Users\\me\\src\\app.ts", "/other/dir");
		assert.strictEqual(result, "C:\\Users\\me\\src\\app.ts");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: Trend Tracking
// ═══════════════════════════════════════════════════════════════════════

describe("DiagnosticsWatcher (trend tracking)", () => {
	it("getTrend() returns undefined when fewer than 2 data points", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();
		assert.strictEqual(w.getTrend(), undefined);

		// One diagnostic emission
		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				filePath: "/a.ts",
			},
		]);
		assert.strictEqual(w.getTrend(), undefined); // Still only 1
	});

	it("getTrend() shows regression when error count increases", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		// First check: 1 error
		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
		]);

		// Second check: 3 errors
		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
			{
				file: "b.ts",
				line: 2,
				column: 2,
				severity: "Error",
				message: "err2",
				filePath: "/b.ts",
			},
			{
				file: "c.ts",
				line: 3,
				column: 3,
				severity: "Error",
				message: "err3",
				filePath: "/c.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.current, 3);
		assert.strictEqual(trend!.previous, 1);
		assert.strictEqual(trend!.direction, "regressed");
		assert.strictEqual(trend!.delta, 2);
	});

	it("getTrend() shows improvement when error count decreases", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
			{
				file: "b.ts",
				line: 2,
				column: 2,
				severity: "Error",
				message: "err2",
				filePath: "/b.ts",
			},
		]);

		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err1",
				filePath: "/a.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.current, 1);
		assert.strictEqual(trend!.previous, 2);
		assert.strictEqual(trend!.direction, "improved");
		assert.strictEqual(trend!.delta, 1);
	});

	it("getTrend() shows stable when error count unchanged", () => {
		const adapter = new MockAdapter();
		const w = new DiagnosticsWatcher(resolve(process.cwd(), "tsconfig.json"), undefined, adapter);
		w.start();

		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				filePath: "/a.ts",
			},
		]);

		adapter.emitDiagnostics([
			{
				file: "a.ts",
				line: 1,
				column: 1,
				severity: "Error",
				message: "err",
				filePath: "/a.ts",
			},
		]);

		const trend = w.getTrend();
		assert.ok(trend);
		assert.strictEqual(trend!.direction, "stable");
		assert.strictEqual(trend!.delta, 0);
	});
});

describe("formatTrend", () => {
	it("formats regressed trend", () => {
		const result = formatTrend({
			current: 5,
			previous: 2,
			direction: "regressed",
			delta: 3,
		});
		assert.ok(result.includes("5 errors"));
		assert.ok(result.includes("↑"));
		assert.ok(result.includes("3"));
	});

	it("formats improved trend", () => {
		const result = formatTrend({
			current: 1,
			previous: 4,
			direction: "improved",
			delta: 3,
		});
		assert.ok(result.includes("1 errors"));
		assert.ok(result.includes("↓"));
	});

	it("formats stable trend", () => {
		const result = formatTrend({
			current: 2,
			previous: 2,
			direction: "stable",
			delta: 0,
		});
		assert.ok(result.includes("→"));
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: runTscCheckpoint (deprecated one-shot adapter)
// ═══════════════════════════════════════════════════════════════════════

describe("runTscCheckpoint (deprecated one-shot)", () => {
	it("is exported and callable with single worktreePath argument", async () => {
		const result = await runTscCheckpoint("/nonexistent/path");
		assert.ok(typeof result === "object");
		assert.ok("diagnostics" in result);
		assert.ok("hasErrors" in result);
	});

	it("has .length === 1 (only worktreePath param)", () => {
		assert.strictEqual(runTscCheckpoint.length, 1);
	});

	it("calling with nonexistent path returns empty diagnostics", async () => {
		const result = await runTscCheckpoint("/nonexistent/path");
		assert.deepStrictEqual(result, { diagnostics: [], hasErrors: false });
	});

	it("ExtensionAPI type import still present in source (used by tscCheckpoint entry)", async () => {
		// Verify by checking that the module still exports the entry function
		// which depends on ExtensionAPI
		const mod = await import("../index.ts");
		assert.ok(typeof mod.default === "function", "default export (tscCheckpoint) still present");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: Integration — Extension Entry Point
// ═══════════════════════════════════════════════════════════════════════

interface MockSendUserMessage {
	content: string;
	options?: { deliverAs?: string };
}

/**
 * Simulates the extension entry point behavior for /check command.
 * Uses the actual imported DiagnosticsWatcher with a mock adapter.
 */
function createCheckHandler(adapter?: MockAdapter) {
	const messages: MockSendUserMessage[] = [];
	let watcherInstance: DiagnosticsWatcher | null = null;

	async function handleCheck(worktreePath: string): Promise<{
		messages: MockSendUserMessage[];
		diagnostics: TscDiagnostic[];
	}> {
		const { existsSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const tsconfigPath = resolve(worktreePath, "tsconfig.json");

		if (!existsSync(tsconfigPath)) {
			messages.push({
				content:
					"## TSC Checkpoint\n\nNo `tsconfig.json` found in worktree root. Skipping type-check.",
				options: { deliverAs: "followUp" },
			});
			return { messages, diagnostics: [] };
		}

		// Create watcher lazily
		if (!watcherInstance) {
			const directAdapter = adapter ?? new MockAdapter();
			watcherInstance = new DiagnosticsWatcher(tsconfigPath, undefined, directAdapter);
		}

		if (!watcherInstance.isRunning()) {
			try {
				watcherInstance.start();
				messages.push({
					content: "## TSC Checkpoint\n\nRunning `tsc` in incremental watch mode...",
					options: { deliverAs: "followUp" },
				});
			} catch (err) {
				messages.push({
					content: `## TSC Checkpoint — Error\n\nFailed to start watcher: ${err}`,
					options: { deliverAs: "followUp" },
				});
				return { messages, diagnostics: [] };
			}
		}

		const diagnostics = watcherInstance.getDiagnostics();
		const trend = watcherInstance.getTrend();

		if (diagnostics.length > 0) {
			const formatted = formatDiagnostics(diagnostics);
			let msg = `## TSC Checkpoint — ${diagnostics.length} Type Error(s) Found`;
			if (trend) {
				msg += ` (${trend.direction === "regressed" ? "⚠️ regression" : trend.direction === "improved" ? "✓ improved" : "→ stable"})`;
			}
			msg += `\n\n${formatted}`;
			messages.push({ content: msg, options: { deliverAs: "followUp" } });
		} else {
			let msg = "## TSC Checkpoint — ✓ No type errors detected";
			if (trend && trend.current === 0 && trend.previous > 0) {
				msg += " (✓ all errors resolved)";
			}
			messages.push({ content: msg, options: { deliverAs: "followUp" } });
		}

		return { messages, diagnostics };
	}

	return { handleCheck };
}

describe("Extension entry point (/check command)", () => {
	it("/check without tsconfig.json returns skip message", async () => {
		const { handleCheck } = createCheckHandler();
		const result = await handleCheck("/nonexistent-worktree");

		assert.strictEqual(result.messages.length, 1);
		assert.ok(result.messages[0]!.content.includes("No `tsconfig.json` found"));
	});

	it("/check creates watcher and returns cached diagnostics", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		const result = await handleCheck(process.cwd());

		// Watcher was started
		assert.strictEqual(adapter.startCalls, 1);
		assert.strictEqual(adapter.lastStartPath, resolve(process.cwd(), "tsconfig.json"));

		// No diagnostics yet, so "no errors" message
		assert.ok(result.messages.some((m) => m.content.includes("No type errors detected")));
	});

	it("/check with diagnostics returns formatted errors", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		// First call creates the watcher and subscribes to adapter events
		await handleCheck(process.cwd());

		// Now emit diagnostics — the watcher is already listening
		adapter.emitDiagnostics([
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type 'string' is not assignable",
				code: "TS2322",
				filePath: resolve(process.cwd(), "src/app.ts"),
			},
		]);

		// Second call returns the cached diagnostics
		const result = await handleCheck(process.cwd());

		// Should include error count in message
		const errorMsg = result.messages.find((m) => m.content.includes("Type Error(s) Found"));
		assert.ok(errorMsg, "Should have error message");
		assert.ok(errorMsg!.content.includes("TS2322"));
		assert.ok(errorMsg!.content.includes("Type 'string' is not assignable"));
	});

	it("/check twice uses cached watcher (no second start)", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		await handleCheck(process.cwd());
		assert.strictEqual(adapter.startCalls, 1);

		await handleCheck(process.cwd());
		// Still only 1 start call — second call reuses watcher
		assert.strictEqual(adapter.startCalls, 1);
	});

	it("/check without diagnostics returns clean message", async () => {
		const adapter = new MockAdapter();
		const { handleCheck } = createCheckHandler(adapter);

		const result = await handleCheck(process.cwd());

		const cleanMsg = result.messages.find((m) => m.content.includes("No type errors detected"));
		assert.ok(cleanMsg);
	});

	it("diagnostics with relative paths have absolute filePath", () => {
		const tsconfigDir = process.cwd();
		const filePath = resolveDiagnosticFilePath("src/app.ts", tsconfigDir);
		assert.strictEqual(filePath, resolve(tsconfigDir, "src/app.ts"));
	});

	it("formatDiagnostics produces clickable paths", () => {
		const diags: TscDiagnostic[] = [
			{
				file: "src/app.ts",
				line: 10,
				column: 5,
				severity: "Error",
				message: "Type error",
				code: "TS2322",
				filePath: "/project/src/app.ts",
			},
		];
		const formatted = formatDiagnostics(diags);
		assert.ok(formatted.includes("/project/src/app.ts"));
		assert.ok(formatted.includes("Line 10"));
		assert.ok(formatted.includes("(TS2322)"));
	});

	it("formatDiagnostics with empty array returns empty string", () => {
		assert.strictEqual(formatDiagnostics([]), "");
	});
});
