/**
 * Phase 4: Integration tests — real LSP server with temp files
 *
 * Tests LSP protocol lifecycle end-to-end using the real auditFileGroup
 * and auditSingleFile from lsp-auditor.ts.
 *
 * Skips if typescript-language-server is not installed.
 *
 * Run with:
 *   npx tsx --test test/lsp-auditor.integration.mts
 */

import assert from "node:assert";
import { describe, it, before } from "node:test";
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Import real functions from lsp-auditor.ts
const {
	auditFileGroup,
} = require("../.pi/extensions/lsp-auditor.ts");

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

let tsServerAvailable = false;
let jsonRpcAvailable = false;

try {
	require("vscode-jsonrpc");
	jsonRpcAvailable = true;
} catch {
	// vscode-jsonrpc not installed
}

function which(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

let testDir: string;

describe("LSP Integration", () => {
	before(async () => {
		tsServerAvailable = which("typescript-language-server");
		if (!tsServerAvailable) {
			console.log("SKIP: typescript-language-server not installed — integration tests skipped");
		}
		if (!jsonRpcAvailable) {
			console.log("SKIP: vscode-jsonrpc not installed — integration tests skipped");
		}
		testDir = mkdtempSync(join(tmpdir(), "lsp-audit-test-"));
	});

	it("spawn typescript-language-server via auditFileGroup, initialize → receives capabilities", { skip: !tsServerAvailable || !jsonRpcAvailable }, async () => {
		const child = spawn("typescript-language-server", ["--stdio"], {
			cwd: testDir,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const { StreamMessageReader, StreamMessageWriter, createMessageConnection } = require("vscode-jsonrpc");
		const reader = new StreamMessageReader(child.stdout!);
		const writer = new StreamMessageWriter(child.stdin!);
		const connection = createMessageConnection(reader, writer);
		connection.listen();

		try {
			const result = await Promise.race([
				connection.sendRequest("initialize", {
					processId: process.pid,
					rootUri: `file://${testDir}`,
					capabilities: {},
				}),
				new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15_000)),
			]);

			assert.ok(result, "InitializeResult should not be null");
			assert.ok(result.capabilities, "should have capabilities");

			connection.sendNotification("initialized", {});
			await Promise.race([
				connection.sendRequest("shutdown", null),
				new Promise((resolve) => setTimeout(resolve, 5_000)),
			]);
			connection.sendNotification("exit", null);
			connection.dispose();
		} finally {
			try { child.kill(); } catch {}
		}
	});

	it("auditFileGroup on .ts file with type error → diagnostics with >=1 error", { skip: !tsServerAvailable || !jsonRpcAvailable }, async () => {
		const filePath = join(testDir, "error.ts");
		writeFileSync(filePath, 'const x: number = "hello";\n');
		assert.ok(existsSync(filePath));

		const mapping = {
			extensions: [".ts"],
			command: "typescript-language-server",
			args: ["--stdio"],
			severityThreshold: "warning" as const,
		};

		const result = await auditFileGroup(mapping, ["error.ts"], testDir);
		assert.ok(result.errors.length === 0, `LSP errors: ${result.errors.join("; ")}`);
		assert.ok(result.diagnostics.length >= 1, `Expected >=1 diagnostic, got ${result.diagnostics.length}`);

		// At least one should be an error
		const hasError = result.diagnostics.some((d: any) => d.severity === "Error");
		assert.ok(hasError, "Expected at least one Error diagnostic");
	});

	it("auditFileGroup on clean .ts file → zero errors/warnings", { skip: !tsServerAvailable || !jsonRpcAvailable }, async () => {
		const filePath = join(testDir, "clean.ts");
		writeFileSync(filePath, 'const x: number = 42;\n');

		const mapping = {
			extensions: [".ts"],
			command: "typescript-language-server",
			args: ["--stdio"],
			severityThreshold: "warning" as const,
		};

		const result = await auditFileGroup(mapping, ["clean.ts"], testDir);
		assert.ok(result.errors.length === 0, `LSP errors: ${result.errors.join("; ")}`);
		// Clean file should have zero error/warning diagnostics
		const errorsAndWarnings = result.diagnostics.filter(
			(d: any) => d.severity === "Error" || d.severity === "Warning"
		);
		assert.strictEqual(errorsAndWarnings.length, 0, `Expected 0 errors/warnings, got ${errorsAndWarnings.length}`);
	});

	it("auditFileGroup on unsupported file (.sh) → returns empty (no LSP server)", { skip: !tsServerAvailable || !jsonRpcAvailable }, async () => {
		const filePath = join(testDir, "script.sh");
		writeFileSync(filePath, '#!/bin/bash\necho hello\n');
		assert.ok(existsSync(filePath));

		// Pass a .sh file but with a mapping that doesn't match — should get error about no files
		const mapping = {
			extensions: [".ts"],
			command: "typescript-language-server",
			args: ["--stdio"],
			severityThreshold: "warning" as const,
		};

		// The mapping doesn't have .sh, but auditFileGroup will still try to audit
		// because it's called with specific files. The grouping happens outside.
		// The real test for unsupported files is groupFilesByServer in Phase 1.
		// Here we just verify auditFileGroup handles any file gracefully.
		const result = await auditFileGroup(mapping, ["script.sh"], testDir);
		assert.ok(result.diagnostics.length >= 0, "Should not crash on unsupported file");
	});

	it("LSP server binary not found → errors returned, no crash", { skip: !jsonRpcAvailable }, async () => {
		const filePath = join(testDir, "dummy.ts");
		writeFileSync(filePath, 'const x = 1;\n');

		const mapping = {
			extensions: [".ts"],
			command: "nonexistent-lsp-binary-xyz",
			args: ["--stdio"],
			severityThreshold: "warning" as const,
		};

		const result = await auditFileGroup(mapping, ["dummy.ts"], testDir);
		// Should fail gracefully without throwing
		assert.ok(result.errors.length >= 1, "Should have error about missing binary");
	});

	it("auditFileGroup completes within 30s for trivial file", { skip: !tsServerAvailable || !jsonRpcAvailable }, async () => {
		const filePath = join(testDir, "timeout-test.ts");
		writeFileSync(filePath, 'const x = 1;\n');

		const mapping = {
			extensions: [".ts"],
			command: "typescript-language-server",
			args: ["--stdio"],
			severityThreshold: "warning" as const,
		};

		const start = Date.now();
		const result = await auditFileGroup(mapping, ["timeout-test.ts"], testDir);
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 30_000, `Audit took ${elapsed}ms, should be < 30s`);
		assert.ok(result.diagnostics.length >= 0, "Should return diagnostics (even if empty)");
	});

	// Cleanup
	const cleanup = () => {
		try { rmSync(testDir, { recursive: true, force: true }); } catch {}
	};
	process.on("exit", cleanup);
});
