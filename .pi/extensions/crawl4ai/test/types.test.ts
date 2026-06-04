/**
 * Tests for types.ts — shared ExecResult/ExecFn extraction
 *
 * Validates that ExecResult and ExecFn are defined once in types.ts
 * and imported by all consumers (no local interface copies).
 *
 * Layer: (D) Domain — source scanning, no I/O beyond filesystem reads.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");

/** Match import from ./types or ./types.ts */
function hasImportFromTypes(source: string, symbols: string[]): boolean {
	// Pattern 1: import type { ..., ExecResult, ..., ExecFn, ... } from "./types(.ts)"
	const typePattern = new RegExp(
		`import\\s+type\\s*\\{[^}]*\\b${symbols[0]}\\b[^}]*\\b${symbols[1]}\\b[^}]*\\}\\s*from\\s+["']\\.\\/types(?:\\.ts)?["']`,
	);
	if (typePattern.test(source)) return true;

	// Pattern 2: import { ..., type ExecResult, ..., type ExecFn, ... } from "./types(.ts)"
	const mixedPattern = new RegExp(
		`import\\s+\\{[^}]*\\btype\\s+${symbols[0]}\\b[^}]*\\btype\\s+${symbols[1]}\\b[^}]*\\}\\s*from\\s+["']\\.\\/types(?:\\.ts)?["']`,
	);
	if (mixedPattern.test(source)) return true;

	// Pattern 3: import type { ExecResult, ExecFn } from "../types(.ts)" (for test files)
	const testPattern = new RegExp(
		`import\\s+type\\s*\\{[^}]*\\b${symbols[0]}\\b[^}]*\\b${symbols[1]}\\b[^}]*\\}\\s*from\\s+["']\\.\\.\\/types(?:\\.ts)?["']`,
	);
	return testPattern.test(source);
}

/** Assert no interface definition (with body) for the given name */
function assertNoLocalInterface(source: string, name: string, fileLabel: string): void {
	assert.ok(
		!new RegExp(`interface\\s+${name}\\s*\\{`).test(source),
		`${fileLabel} should NOT have a local interface ${name}`,
	);
}

/** Assert no full type definition (type X = ... with function signature) for the given name.
 *  Thin type aliases (type Foo = Bar) are allowed — only full definitions are flagged. */
function assertNoLocalFullType(source: string, name: string, fileLabel: string): void {
	// Full type definition: type Foo = (args) => RetType;  (function signature type)
	const signaturePattern = new RegExp(`type\\s+${name}\\s*=\\s*\\(`);
	assert.ok(
		!signaturePattern.test(source),
		`${fileLabel} should NOT have a local full type definition for ${name}`,
	);
}

// ── Phase 1: types.ts exports shared interfaces ──

describe("types.ts exports — shared ExecResult/ExecFn", () => {
	const typesSource = readFileSync(resolve(extDir, "types.ts"), "utf-8");

	it("(D) types.ts exports ExecResult with code, stdout, stderr fields", () => {
		assert.ok(
			/export\s+interface\s+ExecResult/.test(typesSource),
			"types.ts should export interface ExecResult",
		);
		assert.ok(/^\s*code:\s*number;/m.test(typesSource), "ExecResult should have code: number");
		assert.ok(/^\s*stdout:\s*string;/m.test(typesSource), "ExecResult should have stdout: string");
		assert.ok(/^\s*stderr:\s*string;/m.test(typesSource), "ExecResult should have stderr: string");
	});

	it("(D) types.ts exports ExecFn with correct signature", () => {
		assert.ok(
			/export\s+interface\s+ExecFn/.test(typesSource),
			"types.ts should export interface ExecFn",
		);
		assert.ok(
			typesSource.includes("Promise<ExecResult>"),
			"ExecFn should return Promise<ExecResult>",
		);
	});

	it("(D) CrawlParams and OnUpdateCallback remain exported", () => {
		assert.ok(
			/export\s+interface\s+CrawlParams/.test(typesSource),
			"CrawlParams should remain exported",
		);
		assert.ok(
			/export\s+interface\s+OnUpdateCallback/.test(typesSource),
			"OnUpdateCallback should remain exported",
		);
	});
});

// ── Helper: read a source file ──

function readSource(filename: string): string {
	return readFileSync(resolve(extDir, filename), "utf-8");
}

// ── Phase 2: production files remove local copies, import shared ──

describe("executor.ts — no local ExecResult/ExecFn, imports from types.ts", () => {
	const source = readSource("executor.ts");

	it("(D) executor.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "executor.ts");
	});

	it("(D) executor.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "executor.ts");
	});

	it("(D) executor.ts imports ExecResult and ExecFn from ./types.ts", () => {
		assert.ok(
			hasImportFromTypes(source, ["ExecResult", "ExecFn"]),
			'executor.ts should import ExecResult and ExecFn from "./types"',
		);
	});
});

describe("backends.ts — no local ExecResult/ExecFn, imports from types.ts", () => {
	const source = readSource("backends.ts");

	it("(D) backends.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "backends.ts");
	});

	it("(D) backends.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "backends.ts");
	});

	it("(D) backends.ts imports ExecResult and ExecFn from ./types.ts", () => {
		assert.ok(
			hasImportFromTypes(source, ["ExecResult", "ExecFn"]),
			'backends.ts should import ExecResult and ExecFn from "./types"',
		);
	});
});

describe("venv-setup.ts — no local ExecResult/ExecFn, imports from types.ts", () => {
	const source = readSource("venv-setup.ts");

	it("(D) venv-setup.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "venv-setup.ts");
	});

	it("(D) venv-setup.ts no local interface ExecFn", () => {
		assertNoLocalInterface(source, "ExecFn", "venv-setup.ts");
	});

	it("(D) venv-setup.ts imports ExecResult and ExecFn from ./types.ts", () => {
		assert.ok(
			hasImportFromTypes(source, ["ExecResult", "ExecFn"]),
			'venv-setup.ts should import ExecResult and ExecFn from "./types"',
		);
	});
});

// ── Phase 3: test files remove local copies, import shared ──

describe("test/executor.test.ts — no local ExecResult/ExecHandler, imports from types.ts", () => {
	const source = readSource("test/executor.test.ts");

	it("(D) test/executor.test.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/executor.test.ts");
	});

	it("(D) test/executor.test.ts no local full ExecHandler type definition", () => {
		assertNoLocalFullType(source, "ExecHandler", "test/executor.test.ts");
	});

	it("(D) test/executor.test.ts imports ExecResult and ExecFn from ../types.ts", () => {
		// For test files, use ../types pattern
		const pattern =
			/import\s+type\s*\{[^}]*\bExecResult\b[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/types(?:\.ts)?["']/;
		assert.ok(
			pattern.test(source),
			'test/executor.test.ts should import ExecResult and ExecFn from "../types"',
		);
	});
});

describe("test/backends.test.ts — no local ExecResult/ExecHandler, imports from types.ts", () => {
	const source = readSource("test/backends.test.ts");

	it("(D) test/backends.test.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/backends.test.ts");
	});

	it("(D) test/backends.test.ts no local full ExecHandler type definition", () => {
		assertNoLocalFullType(source, "ExecHandler", "test/backends.test.ts");
	});

	it("(D) test/backends.test.ts imports ExecResult and ExecFn from ../types.ts", () => {
		const pattern =
			/import\s+type\s*\{[^}]*\bExecResult\b[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/types(?:\.ts)?["']/;
		assert.ok(
			pattern.test(source),
			'test/backends.test.ts should import ExecResult and ExecFn from "../types"',
		);
	});
});

describe("test/venv-setup.test.ts — no local ExecResult/ExecHandler, imports from types.ts", () => {
	const source = readSource("test/venv-setup.test.ts");

	it("(D) test/venv-setup.test.ts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/venv-setup.test.ts");
	});

	it("(D) test/venv-setup.test.ts no local full ExecHandler type definition", () => {
		assertNoLocalFullType(source, "ExecHandler", "test/venv-setup.test.ts");
	});

	it("(D) test/venv-setup.test.ts imports ExecResult and ExecFn from ../types.ts", () => {
		const pattern =
			/import\s+type\s*\{[^}]*\bExecResult\b[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/types(?:\.ts)?["']/;
		assert.ok(
			pattern.test(source),
			'test/venv-setup.test.ts should import ExecResult and ExecFn from "../types"',
		);
	});
});

describe("test/crawl4ai.test.mts — no local ExecResult/ExecFn, imports from types.ts", () => {
	const source = readSource("test/crawl4ai.test.mts");

	it("(D) test/crawl4ai.test.mts no local interface ExecResult", () => {
		assertNoLocalInterface(source, "ExecResult", "test/crawl4ai.test.mts");
	});

	it("(D) test/crawl4ai.test.mts no local full ExecFn type definition", () => {
		assertNoLocalFullType(source, "ExecFn", "test/crawl4ai.test.mts");
	});

	it("(D) test/crawl4ai.test.mts imports ExecResult and ExecFn from ../types.ts", () => {
		const pattern =
			/import\s+type\s*\{[^}]*\bExecResult\b[^}]*\bExecFn\b[^}]*\}\s*from\s+["']\.\.\/types(?:\.ts)?["']/;
		assert.ok(
			pattern.test(source),
			'test/crawl4ai.test.mts should import ExecResult and ExecFn from "../types"',
		);
	});
});
