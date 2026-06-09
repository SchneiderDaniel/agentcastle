/**
 * Tests: structural-search — cache, auto-detect, streaming, binary detection, error propagation
 *
 * Adapter-style tests that test through the execute function with mocked pi.exec.
 * Replaces old pure-function unit tests that tested implementation details.
 *
 * Run with:
 *   node --experimental-strip-types --test .pi/extensions/structural-analyzer/test/structural-analyzer.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach } from "node:test";
import structuralAnalyzer, {
	interpretSgExecResult,
	parseSgOutput,
	validatePattern,
	truncateSnippet,
	makeCacheKey,
	detectLanguage,
	fileExists,
	parseLanguageGlobsFromYaml,
	clearResultCache,
	type ExecResultResponse,
} from "../index.ts";

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

function createMatchJson(file: string, lines: string, text: string): string {
	return JSON.stringify({ file, lines, text });
}

const TWO_MATCHES = [
	createMatchJson(
		"api/auth.py",
		"22-28",
		"try:\n    verify_token(token)\nexcept AuthError:\n    print('auth failed')",
	),
	createMatchJson("src/app.ts", "10-10", "console.log('App started')"),
].join("\n");

const MANY_MATCHES = Array.from({ length: 150 }, (_, i) =>
	createMatchJson(`file${i}.ts`, `${i}-${i + 1}`, `match number ${i}`),
).join("\n");

function emptyMockPi(overrides?: Record<string, any>) {
	return {
		registerTool: () => {},
		on: () => {},
		exec: async (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version") {
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			}
			if (cmd === "test" && args[0] === "-f") {
				return { stdout: "", stderr: "", code: 1, killed: false };
			}
			if (cmd === "cat") {
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
		...overrides,
	};
}

// ═══════════════════════════════════════════════════════════════════════
// Pure function tests (kept — critical for correctness)
// ═══════════════════════════════════════════════════════════════════════

describe("validatePattern", () => {
	it("rejects single word 'TODO' (collision rule)", () => {
		const result = validatePattern("TODO");
		assert.ok(result !== null, "Expected error for single-word pattern");
		assert.ok(result!.includes("ripgrep"), "Error should mention ripgrep");
	});

	it("rejects single identifier 'verify_token'", () => {
		const result = validatePattern("verify_token");
		assert.ok(result !== null);
		assert.ok(result!.includes("ripgrep"));
	});

	it("rejects empty string", () => {
		const result = validatePattern("");
		assert.ok(result !== null);
	});

	it("rejects whitespace-only string", () => {
		const result = validatePattern("   ");
		assert.ok(result !== null);
	});

	it("accepts pattern with $ meta variable: console.log($A)", () => {
		const result = validatePattern("console.log($A)");
		assert.strictEqual(result, null);
	});

	it("accepts try/catch pattern with $$$BODY and $A", () => {
		const result = validatePattern("try { $$$BODY } catch (e) { console.log($A) }");
		assert.strictEqual(result, null);
	});

	it("accepts function pattern with parentheses and $", () => {
		const result = validatePattern("function($A, $B)");
		assert.strictEqual(result, null);
	});

	it("accepts class pattern with $", () => {
		const result = validatePattern("class $NAME");
		assert.strictEqual(result, null);
	});
});

describe("truncateSnippet", () => {
	it("returns short text unchanged", () => {
		const text = "short text";
		assert.strictEqual(truncateSnippet(text), text);
	});

	it("truncates 121-char string to 119 chars + '…'", () => {
		const text = "a".repeat(121);
		const result = truncateSnippet(text);
		assert.strictEqual(result.length, 120);
		assert.strictEqual(result, "a".repeat(119) + "…");
	});

	it("returns empty string for empty input", () => {
		assert.strictEqual(truncateSnippet(""), "");
	});
});

describe("parseSgOutput", () => {
	it("parses valid JSONL lines", () => {
		const result = parseSgOutput(TWO_MATCHES);
		assert.strictEqual(result.matches, 2);
		assert.strictEqual(result.results.length, 2);
		assert.strictEqual(result.results[0]!.file, "api/auth.py");
	});

	it("returns empty for empty string", () => {
		const result = parseSgOutput("");
		assert.strictEqual(result.matches, 0);
	});

	it("skips malformed JSON line", () => {
		const input = ["not json", createMatchJson("a.ts", "1", "ok")].join("\n");
		const result = parseSgOutput(input);
		assert.strictEqual(result.matches, 1);
	});

	it("handles null input defensively", () => {
		const result = parseSgOutput(null as unknown as string);
		assert.strictEqual(result.matches, 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════
// Cache eviction tests (FIFO bounded)
// ═══════════════════════════════════════════════════════════════════════

describe("cache eviction (FIFO bounded)", () => {
	let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;
	let execCalls: Array<{ command: string; args: string[]; options?: any }>;
	let onCalls: Array<{ event: string; handler: Function }>;

	beforeEach(() => {
		clearResultCache();
		execCalls = [];
		capturedExecute = undefined;
		onCalls = [];
	});

	function generatePatterns(n: number): string[] {
		return Array.from({ length: n }, (_, i) => `p${i}($A)`);
	}

	function makeScanExec(stdout: string, code = 0) {
		return async (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version") {
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			}
			if (cmd === "test" && args[0] === "-f") {
				return { stdout: "", stderr: "", code: 1, killed: false };
			}
			if (cmd === "cat") {
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			return { stdout, stderr: "", code, killed: false };
		};
	}

	function makePi(execFn?: (cmd: string, args: string[]) => any) {
		const defaultExec = async (cmd: string, args: string[], opts?: any) => {
			execCalls.push({ command: cmd, args, options: opts });
			return execFn ? execFn(cmd, args) : { stdout: "", stderr: "", code: 1, killed: false };
		};
		return {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: defaultExec,
			on: (event: string, handler: Function) => {
				onCalls.push({ event, handler });
			},
		};
	}

	it("201st unique pattern — cache stays at 200; oldest evicted, newest survives", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const patterns = generatePatterns(201);

		// Fill cache with 201 unique patterns
		for (const pattern of patterns) {
			await capturedExecute!("id", { pattern, language: "ts" }, undefined, undefined, {
				cwd: "/tmp",
			});
		}

		// All 201 should have been scan executions (first pass, no cache)
		const scanCalls = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls.length, 201);

		execCalls.length = 0;

		// 200th pattern (index 199) should still be a hit
		await capturedExecute!("id", { pattern: patterns[199], language: "ts" }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.strictEqual(
			execCalls.filter((c) => c.args[0] === "scan").length,
			0,
			"200th pattern should be a cache hit",
		);

		execCalls.length = 0;

		// 1st pattern (index 0) should be a miss (evicted)
		await capturedExecute!("id", { pattern: patterns[0], language: "ts" }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.strictEqual(
			execCalls.filter((c) => c.args[0] === "scan").length,
			1,
			"1st pattern should be evicted → cache miss → re-exec",
		);
	});

	it("199 unique patterns — all hit on second pass (no eviction)", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const patterns = generatePatterns(199);

		// Fill cache with 199 patterns
		for (const pattern of patterns) {
			await capturedExecute!("id", { pattern, language: "ts" }, undefined, undefined, {
				cwd: "/tmp",
			});
		}

		execCalls.length = 0;

		// All 199 should be hits
		for (const pattern of patterns) {
			await capturedExecute!("id", { pattern, language: "ts" }, undefined, undefined, {
				cwd: "/tmp",
			});
		}

		assert.strictEqual(
			execCalls.filter((c) => c.args[0] === "scan").length,
			0,
			"no scans — all 199 should be cached hits",
		);
	});

	it("clearResultCache() empties full cache", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const patterns = generatePatterns(5);

		// Fill cache
		for (const pattern of patterns) {
			await capturedExecute!("id", { pattern, language: "ts" }, undefined, undefined, {
				cwd: "/tmp",
			});
		}

		clearResultCache();

		execCalls.length = 0;

		// Re-run one pattern — should miss (cache cleared)
		await capturedExecute!("id", { pattern: patterns[0], language: "ts" }, undefined, undefined, {
			cwd: "/tmp",
		});
		assert.strictEqual(
			execCalls.filter((c) => c.args[0] === "scan").length,
			1,
			"should be cache miss after clearResultCache()",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Session lifecycle tests
// ═══════════════════════════════════════════════════════════════════════

describe("session lifecycle", () => {
	let onCalls: Array<{ event: string; handler: Function }>;
	let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;
	let execCalls: Array<{ command: string; args: string[] }>;

	beforeEach(() => {
		clearResultCache();
		onCalls = [];
		capturedExecute = undefined;
		execCalls = [];
	});

	function makeScanExec(stdout: string) {
		return async (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version") {
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			}
			if (cmd === "test" && args[0] === "-f") {
				return { stdout: "", stderr: "", code: 1, killed: false };
			}
			if (cmd === "cat") {
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			return { stdout, stderr: "", code: 0, killed: false };
		};
	}

	function makePi(execFn: (cmd: string, args: string[]) => any) {
		return {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: async (cmd: string, args: string[], _opts?: any) => {
				execCalls.push({ command: cmd, args });
				return execFn(cmd, args);
			},
			on: (event: string, handler: Function) => {
				onCalls.push({ event, handler });
			},
		};
	}

	it("session_shutdown handler is registered", () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const shutdownHandlers = onCalls.filter((c) => c.event === "session_shutdown");
		assert.strictEqual(
			shutdownHandlers.length,
			1,
			"should register exactly one session_shutdown handler",
		);
	});

	it("cache is cleared after session shutdown", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		// Execute a search — populates cache
		await capturedExecute!(
			"id",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(execCalls.filter((c) => c.args[0] === "scan").length, 1);

		execCalls.length = 0;

		// Same search again — cache hit
		await capturedExecute!(
			"id",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(
			execCalls.filter((c) => c.args[0] === "scan").length,
			0,
			"second call should be cache hit",
		);

		// Trigger session shutdown
		const shutdownHandler = onCalls.find((c) => c.event === "session_shutdown")!.handler;
		await shutdownHandler();

		execCalls.length = 0;

		// Same search again — should miss (cache was cleared)
		await capturedExecute!(
			"id",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(
			execCalls.filter((c) => c.args[0] === "scan").length,
			1,
			"should be cache miss after session shutdown",
		);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Cache key tests

describe("makeCacheKey", () => {
	it("produces deterministic key from pattern, language, cwd", () => {
		const key = makeCacheKey("console.log($A)", "ts", "/home/project");
		assert.ok(typeof key === "string");
		assert.ok(key.includes("console.log($A)"));
		assert.ok(key.includes("ts"));
		assert.ok(key.includes("/home/project"));
	});

	it("different patterns produce different keys", () => {
		const key1 = makeCacheKey("console.log($A)", "ts", "/p");
		const key2 = makeCacheKey("class $NAME", "ts", "/p");
		assert.notStrictEqual(key1, key2);
	});

	it("different languages produce different keys", () => {
		const key1 = makeCacheKey("console.log($A)", "ts", "/p");
		const key2 = makeCacheKey("console.log($A)", "py", "/p");
		assert.notStrictEqual(key1, key2);
	});

	it("different cwds produce different keys", () => {
		const key1 = makeCacheKey("console.log($A)", "ts", "/p1");
		const key2 = makeCacheKey("console.log($A)", "ts", "/p2");
		assert.notStrictEqual(key1, key2);
	});

	it("same inputs produce same key (deterministic)", () => {
		const key1 = makeCacheKey("console.log($A)", "ts", "/p");
		const key2 = makeCacheKey("console.log($A)", "ts", "/p");
		assert.strictEqual(key1, key2);
	});

	it("handles special characters in pattern", () => {
		const key = makeCacheKey("try { $$$BODY } catch (e) { $A }", "js", "/p");
		assert.ok(typeof key === "string");
		assert.ok(key.length > 0);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Language auto-detect tests
// ═══════════════════════════════════════════════════════════════════════

describe("fileExists", () => {
	it("returns true when test -f succeeds", async () => {
		const mockExec = async (_cmd: string, _args: string[]) => ({ code: 0 });
		const result = await fileExists(mockExec as any, "tsconfig.json", "/p");
		assert.strictEqual(result, true);
	});

	it("returns false when test -f fails", async () => {
		const mockExec = async (_cmd: string, _args: string[]) => ({ code: 1 });
		const result = await fileExists(mockExec as any, "nonexistent.json", "/p");
		assert.strictEqual(result, false);
	});
});

describe("detectLanguage", () => {
	it("detects typescript from tsconfig.json", async () => {
		const mockExec = async (cmd: string, args: string[]) => {
			if (cmd === "test" && args[1] === "tsconfig.json") return { code: 0 };
			if (cmd === "test") return { code: 1 };
			return { code: 0, stdout: "" };
		};
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, "typescript");
	});

	it("detects python from pyproject.toml", async () => {
		const mockExec = async (cmd: string, args: string[]) => {
			if (cmd === "test" && args[1] === "pyproject.toml") return { code: 0 };
			if (cmd === "test") return { code: 1 };
			return { code: 0, stdout: "" };
		};
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, "python");
	});

	it("detects go from go.mod", async () => {
		const mockExec = async (cmd: string, args: string[]) => {
			if (cmd === "test" && args[1] === "go.mod") return { code: 0 };
			if (cmd === "test") return { code: 1 };
			return { code: 0, stdout: "" };
		};
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, "go");
	});

	it("detects rust from Cargo.toml", async () => {
		const mockExec = async (cmd: string, args: string[]) => {
			if (cmd === "test" && args[1] === "Cargo.toml") return { code: 0 };
			if (cmd === "test") return { code: 1 };
			return { code: 0, stdout: "" };
		};
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, "rust");
	});

	it("returns null when no config files found", async () => {
		const mockExec = async (_cmd: string, _args: string[]) => ({ code: 1, stdout: "" });
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, null);
	});

	it("respects priority: tsconfig.json before pyproject.toml", async () => {
		const mockExec = async (cmd: string, args: string[]) => {
			if (cmd === "test" && args[1] === "tsconfig.json") return { code: 0 };
			if (cmd === "test" && args[1] === "pyproject.toml") return { code: 0 };
			if (cmd === "test") return { code: 1 };
			return { code: 0, stdout: "" };
		};
		// tsconfig.json checked first → returns typescript
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, "typescript");
	});

	it("parses languageGlobs from sgconfig.yml", async () => {
		const sgconfigYaml = `ruleDirs:
  - rules
languageGlobs:
  ts: "**/*.ts"
  js: "**/*.js"
suppressError: false`;

		const mockExec = async (cmd: string, args: string[]) => {
			if (cmd === "test" && args[1] === "sgconfig.yml") return { code: 0 };
			if (cmd === "test") return { code: 1 };
			if (cmd === "cat" && args[0] === "sgconfig.yml") return { code: 0, stdout: sgconfigYaml };
			return { code: 0, stdout: "" };
		};
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, "ts");
	});

	it("sgconfig.yml without languageGlobs falls through to next config", async () => {
		const sgconfigYaml = `ruleDirs:
  - rules
suppressError: false`;

		const mockExec = async (cmd: string, args: string[]) => {
			if (cmd === "test" && args[1] === "sgconfig.yml") return { code: 0 };
			if (cmd === "test" && args[1] === "tsconfig.json") return { code: 0 };
			if (cmd === "test") return { code: 1 };
			if (cmd === "cat" && args[0] === "sgconfig.yml") return { code: 0, stdout: sgconfigYaml };
			return { code: 0, stdout: "" };
		};
		// sgconfig.yml found but has no languageGlobs → falls through to tsconfig.json
		const result = await detectLanguage(mockExec as any, "/p");
		assert.strictEqual(result, "typescript");
	});
});

describe("parseLanguageGlobsFromYaml", () => {
	it("extracts first language key from languageGlobs section", () => {
		const yaml = `ruleDirs:
  - rules
languageGlobs:
  ts: "**/*.ts"
  js: "**/*.js"`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), "ts");
	});

	it("returns null when no languageGlobs section", () => {
		const yaml = `ruleDirs:\n  - rules`;
		assert.strictEqual(parseLanguageGlobsFromYaml(yaml), null);
	});

	it("returns null for empty yaml", () => {
		assert.strictEqual(parseLanguageGlobsFromYaml(""), null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Cache integration tests (via execute)
// ═══════════════════════════════════════════════════════════════════════

describe("cache integration (adapter)", () => {
	let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;
	let execCalls: Array<{ command: string; args: string[]; options?: any }>;

	beforeEach(() => {
		clearResultCache();
		execCalls = [];
		capturedExecute = undefined;
	});

	function makePi(execFn?: (cmd: string, args: string[]) => any) {
		const defaultExec = async (cmd: string, args: string[], opts?: any) => {
			execCalls.push({ command: cmd, args, options: opts });
			return execFn ? execFn(cmd, args) : { stdout: "", stderr: "", code: 1, killed: false };
		};
		return {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: defaultExec,
			on: () => {},
		};
	}

	function makeScanExec(stdout: string, code = 0) {
		return async (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version") {
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			}
			if (cmd === "test" && args[0] === "-f") {
				return { stdout: "", stderr: "", code: 1, killed: false };
			}
			if (cmd === "cat") {
				return { stdout: "", stderr: "", code: 0, killed: false };
			}
			// scan command
			return { stdout, stderr: "", code, killed: false };
		};
	}

	it("same pattern+language+cwd returns cached result on second call", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		// First call
		const r1 = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const scanCalls = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls.length, 1, "first call should exec scan");

		execCalls.length = 0;

		// Second call — same params
		const r2 = await capturedExecute!(
			"id2",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const scanCalls2 = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls2.length, 0, "second call should NOT exec scan (cached)");

		// Results should be identical
		assert.deepStrictEqual(r2, r1);
	});

	it("different pattern → cache miss", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		execCalls.length = 0;

		await capturedExecute!(
			"id2",
			{ pattern: "class $NAME", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const scanCalls = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls.length, 1, "different pattern should cause cache miss");
	});

	it("different language → cache miss", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		execCalls.length = 0;

		await capturedExecute!(
			"id2",
			{ pattern: "console.log($A)", language: "py" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const scanCalls = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls.length, 1, "different language should cause cache miss");
	});

	it("different cwd → cache miss", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp/a" },
		);
		execCalls.length = 0;

		await capturedExecute!(
			"id2",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp/b" },
		);

		const scanCalls = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls.length, 1, "different cwd should cause cache miss");
	});

	it("pattern with special characters produces stable cache key", async () => {
		const execFn = makeScanExec(TWO_MATCHES);
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		await capturedExecute!(
			"id1",
			{ pattern: "try { $$$BODY } catch (e) { $A }", language: "js" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		execCalls.length = 0;

		await capturedExecute!(
			"id2",
			{ pattern: "try { $$$BODY } catch (e) { $A }", language: "js" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const scanCalls = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls.length, 0, "special characters pattern should cache correctly");
	});

	it("error responses are NOT cached", async () => {
		const errorExec = async (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version") {
				return { stdout: "ast-grep 0.42.2", stderr: "", code: 0, killed: false };
			}
			if (cmd === "test") {
				return { stdout: "", stderr: "", code: 1, killed: false };
			}
			return { stdout: "", stderr: "unknown language: xyz", code: 1, killed: false };
		};
		const pi = makePi(errorExec);
		structuralAnalyzer(pi as any);

		const r1 = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "xyz" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(r1.isError, true, "first call should be error");

		execCalls.length = 0;

		const r2 = await capturedExecute!(
			"id2",
			{ pattern: "console.log($A)", language: "xyz" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		// Error should NOT be cached - second call should exec again
		const scanCalls = execCalls.filter((c) => c.args[0] === "scan");
		assert.strictEqual(scanCalls.length, 1, "error response should NOT be cached - must re-exec");
		assert.strictEqual(r2.isError, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Language auto-detect integration tests (via execute, language param omitted)
// ═══════════════════════════════════════════════════════════════════════

describe("language auto-detect (adapter)", () => {
	let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;
	let execCalls: Array<{ command: string; args: string[] }>;

	beforeEach(() => {
		clearResultCache();
		execCalls = [];
		capturedExecute = undefined;
	});

	function makePi(customExec?: (cmd: string, args: string[]) => any) {
		const defaultExec = async (cmd: string, args: string[], _opts?: any) => {
			execCalls.push({ command: cmd, args });
			if (customExec) return customExec(cmd, args);
			return { stdout: "", stderr: "", code: 1, killed: false };
		};
		return {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: defaultExec,
			on: () => {},
		};
	}

	it("tsconfig.json found → auto-detect typescript", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test" && args[1] === "sgconfig.yml") return { code: 1, stdout: "" };
			if (cmd === "test" && args[1] === "tsconfig.json") return { code: 0, stdout: "" };
			if (cmd === "test") return { code: 1, stdout: "" };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		// Omit language param
		await capturedExecute!("id1", { pattern: "console.log($A)" }, undefined, undefined, {
			cwd: "/tmp",
		});

		const scanCall = execCalls.find((c) => c.args[0] === "scan");
		assert.ok(scanCall, "should have a scan call");
		// Check --lang appears in args
		const langIndex = scanCall!.args.indexOf("--lang");
		assert.notStrictEqual(langIndex, -1, "should have --lang argument");
		assert.strictEqual(scanCall!.args[langIndex + 1], "typescript", "should use typescript");
	});

	it("no config files → fallback to caller-supplied language", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { code: 1, stdout: "" };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "rust" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const scanCall = execCalls.find((c) => c.args[0] === "scan");
		assert.ok(scanCall);
		const langIndex = scanCall!.args.indexOf("--lang");
		assert.strictEqual(scanCall!.args[langIndex + 1], "rust", "should use caller-supplied rust");
	});

	it("no config files + no language param → default to ts", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { code: 1, stdout: "" };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		await capturedExecute!("id1", { pattern: "console.log($A)" }, undefined, undefined, {
			cwd: "/tmp",
		});

		const scanCall = execCalls.find((c) => c.args[0] === "scan");
		assert.ok(scanCall);
		const langIndex = scanCall!.args.indexOf("--lang");
		assert.strictEqual(scanCall!.args[langIndex + 1], "ts", "should default to ts");
	});

	it("sgconfig.yml found → uses languageGlobs", async () => {
		const sgconfigContent = `languageGlobs:\n  rs: "**/*.rs"`;
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test" && args[1] === "sgconfig.yml") return { code: 0, stdout: "" };
			if (cmd === "test") return { code: 1, stdout: "" };
			if (cmd === "cat") return { code: 0, stdout: sgconfigContent };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		await capturedExecute!("id1", { pattern: "console.log($A)" }, undefined, undefined, {
			cwd: "/tmp",
		});

		const scanCall = execCalls.find((c) => c.args[0] === "scan");
		assert.ok(scanCall);
		const langIndex = scanCall!.args.indexOf("--lang");
		assert.strictEqual(scanCall!.args[langIndex + 1], "rs", "should use rs from sgconfig.yml");
	});

	it("multiple config files → priority: sgconfig.yml > tsconfig.json > pyproject.toml", async () => {
		const sgconfigContent = 'languageGlobs:\n  go: "**/*.go"';
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			// Both sgconfig.yml and tsconfig.json exist
			if (cmd === "test" && args[1] === "sgconfig.yml") return { code: 0, stdout: "" };
			if (cmd === "test" && args[1] === "tsconfig.json") return { code: 0, stdout: "" }; // would match if sgconfig not handled
			if (cmd === "test") return { code: 1, stdout: "" };
			if (cmd === "cat") return { code: 0, stdout: sgconfigContent };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		await capturedExecute!("id1", { pattern: "console.log($A)" }, undefined, undefined, {
			cwd: "/tmp",
		});

		const scanCall = execCalls.find((c) => c.args[0] === "scan");
		assert.ok(scanCall);
		const langIndex = scanCall!.args.indexOf("--lang");
		// sgconfig.yml has go → should use go
		assert.strictEqual(scanCall!.args[langIndex + 1], "go", "sgconfig.yml should take priority");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Streaming tests (large result sets)
// ═══════════════════════════════════════════════════════════════════════

describe("streaming (adapter)", () => {
	let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;

	beforeEach(() => {
		clearResultCache();
	});

	function makePi(execFn: (cmd: string, args: string[]) => any) {
		const execCalls: Array<{ command: string; args: string[] }> = [];
		return {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: async (cmd: string, args: string[], _opts?: any) => {
				execCalls.push({ command: cmd, args });
				return execFn(cmd, args);
			},
			on: () => {},
			_execCalls: execCalls,
		};
	}

	it("5000+ lines → truncated response with total count", async () => {
		const manyLines = Array.from({ length: 5000 }, (_, i) =>
			JSON.stringify({ file: `f${i}.ts`, lines: `${i}`, text: `match ${i}` }),
		).join("\n");

		const execFn = (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: manyLines, stderr: "", code: 0, killed: false };
		};
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		assert.strictEqual(result.isError, undefined, "should not be error");
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 5000, "total match count should be 5000");
		assert.strictEqual(details.truncated, true, "should have truncated flag");
		assert.strictEqual(details.totalMatches, 5000, "totalMatches should be 5000");

		const results = details.results as any[];
		assert.ok(results.length <= 100, `should truncate to ≤100, got ${results.length}`);

		const contentText = result.content[0].text as string;
		assert.ok(contentText.includes("5000"), "content should mention total count 5000");
		assert.ok(contentText.includes("100"), "content should mention first 100");
	});

	it("small result set (< threshold) returns full results", async () => {
		const fewLines = Array.from({ length: 5 }, (_, i) =>
			JSON.stringify({ file: `f${i}.ts`, lines: `${i}`, text: `match ${i}` }),
		).join("\n");

		const execFn = (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: fewLines, stderr: "", code: 0, killed: false };
		};
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 5, "total match count should be 5");
		assert.strictEqual(details.truncated, undefined, "should NOT have truncated flag");
		const results = details.results as any[];
		assert.strictEqual(results.length, 5, "all 5 results should be present");
	});

	it("exactly 100 results → not truncated (threshold is > 100)", async () => {
		const hundredLines = Array.from({ length: 100 }, (_, i) =>
			JSON.stringify({ file: `f${i}.ts`, lines: `${i}`, text: `match ${i}` }),
		).join("\n");

		const execFn = (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: hundredLines, stderr: "", code: 0, killed: false };
		};
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 100, "total match count should be 100");
		// 100 > 100 is false, so NOT truncated
		assert.strictEqual(details.truncated, undefined, "100 is not > 100, so no truncation");
		const results = details.results as any[];
		assert.strictEqual(results.length, 100, "all 100 results should be present");
	});

	it("exactly 101 results → truncated", async () => {
		const lines101 = Array.from({ length: 101 }, (_, i) =>
			JSON.stringify({ file: `f${i}.ts`, lines: `${i}`, text: `match ${i}` }),
		).join("\n");

		const execFn = (cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: lines101, stderr: "", code: 0, killed: false };
		};
		const pi = makePi(execFn);
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 101);
		assert.strictEqual(details.truncated, true);
		const results = details.results as any[];
		assert.strictEqual(results.length, 100, "should truncate to 100");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Binary detection tests (via execute)
// ═══════════════════════════════════════════════════════════════════════

describe("binary detection (adapter)", () => {
	let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;
	let execCalls: Array<{ command: string; args: string[] }>;

	beforeEach(() => {
		clearResultCache();
	});

	function makePi(execFn: (cmd: string, args: string[]) => any) {
		execCalls = [];
		return {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: async (cmd: string, args: string[], _opts?: any) => {
				execCalls.push({ command: cmd, args });
				return execFn(cmd, args);
			},
			on: () => {},
		};
	}

	it("ast-grep found on first call → cached for subsequent calls", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		// First call — triggers binary detection
		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		const versionCalls = execCalls.filter((c) => c.args[0] === "--version");
		assert.strictEqual(versionCalls.length, 1, "version check on first call");

		execCalls.length = 0;

		// Second call — no version check
		await capturedExecute!(
			"id2",
			{ pattern: "class $NAME", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		const versionCalls2 = execCalls.filter((c) => c.args[0] === "--version");
		assert.strictEqual(versionCalls2.length, 0, "no version check on second call (cached)");
	});

	it("ast-grep not found → falls back to sg", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "", stderr: "not found", code: 127, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		// First exec call is ast-grep --version, second should be sg scan
		const sgScan = execCalls.find((c) => c.command === "sg" && c.args[0] === "scan");
		assert.ok(sgScan, "should fallback to sg for scan");

		execCalls.length = 0;

		// Second execute — should use sg directly (cached)
		await capturedExecute!(
			"id2",
			{ pattern: "class $NAME", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);

		const versionCalls = execCalls.filter((c) => c.args[0] === "--version");
		assert.strictEqual(versionCalls.length, 0, "no version check on second call");

		const sgScan2 = execCalls.find((c) => c.command === "sg" && c.args[0] === "scan");
		assert.ok(sgScan2, "second scan should also use sg");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Error propagation tests (via execute)
// ═══════════════════════════════════════════════════════════════════════

describe("error propagation (adapter)", () => {
	let capturedExecute: ((...args: any[]) => Promise<any>) | undefined;

	beforeEach(() => {
		clearResultCache();
	});

	function makePi(execFn: (cmd: string, args: string[]) => any) {
		return {
			registerTool: (tool: any) => {
				capturedExecute = tool.execute;
			},
			exec: async (cmd: string, args: string[], _opts?: any) => execFn(cmd, args),
			on: () => {},
		};
	}

	it("exit code 1 with stderr → isError", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: "", stderr: "unknown language: xyz", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "xyz" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(result.isError, true);
		assert.ok((result.content[0].text as string).includes("unknown language: xyz"));
	});

	it("exit code 126 → isError", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: "", stderr: "Permission denied", code: 126, killed: false };
		});
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(result.isError, true);
		assert.ok((result.content[0].text as string).includes("126"));
	});

	it("exit code 2 → isError", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: "", stderr: "internal error", code: 2, killed: false };
		});
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(result.isError, true);
	});

	it("no-match (exit code 1, empty stderr) → success with 0 matches", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: "", stderr: "", code: 1, killed: false };
		});
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "nonexistent($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(result.isError, undefined);
		assert.ok((result.content[0].text as string).includes("No matches found"));
	});

	it("exit code 0 with stdout → parsed results returned", async () => {
		const pi = makePi((cmd: string, args: string[]) => {
			if (cmd === "ast-grep" && args[0] === "--version")
				return { stdout: "ok", stderr: "", code: 0, killed: false };
			if (cmd === "test") return { stdout: "", stderr: "", code: 1, killed: false };
			return { stdout: TWO_MATCHES, stderr: "", code: 0, killed: false };
		});
		structuralAnalyzer(pi as any);

		const result = await capturedExecute!(
			"id1",
			{ pattern: "console.log($A)", language: "ts" },
			undefined,
			undefined,
			{ cwd: "/tmp" },
		);
		assert.strictEqual(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 2);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// interpretSgExecResult pure function tests
// ═══════════════════════════════════════════════════════════════════════

describe("interpretSgExecResult", () => {
	it("code 0 with valid JSONL stdout → returns parsed matches", () => {
		const stdout = [
			JSON.stringify({ file: "a.ts", lines: "1-5", text: "console.log(x)" }),
			JSON.stringify({ file: "b.ts", lines: "10-12", text: "console.log(y)" }),
		].join("\n");

		const result = interpretSgExecResult(0, stdout, "", "console.log($A)", "ts");
		assert.strictEqual(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 2);
	});

	it("code 0 with empty stdout → success, matches: 0", () => {
		const result = interpretSgExecResult(0, "", "", "console.log($A)", "ts");
		assert.strictEqual(result.isError, undefined);
		const details = result.details as Record<string, unknown>;
		assert.strictEqual(details.matches, 0);
	});

	it("code 1, empty stdout, empty stderr → no matches found", () => {
		const result = interpretSgExecResult(1, "", "", "nonexistent($A)", "ts");
		assert.strictEqual(result.isError, undefined);
		assert.ok(result.content[0].text.includes("No matches found"));
	});

	it("code 1, empty stdout, non-empty stderr → isError", () => {
		const result = interpretSgExecResult(1, "", "unknown language: xyz", "console.log($A)", "ts");
		assert.strictEqual(result.isError, true);
	});

	it("code 126 → isError", () => {
		const result = interpretSgExecResult(126, "", "Permission denied", "console.log($A)", "ts");
		assert.strictEqual(result.isError, true);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Integration test (requires ast-grep binary installed)
// ═══════════════════════════════════════════════════════════════════════

describe("integration: ast-grep binary", () => {
	const hasAstGrep = (() => {
		try {
			const { execSync } = require("node:child_process");
			execSync("ast-grep --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();

	const skipMsg =
		"ast-grep binary not installed — skip integration test (install with: npm i -g @ast-grep/cli)";

	it(
		"runs sg scan with console.log pattern on fixture dir",
		{ skip: !hasAstGrep ? skipMsg : false, timeout: 15_000 },
		() => {
			const { resolve } = require("node:path");
			const { execSync } = require("node:child_process");
			const { existsSync } = require("node:fs");
			const sampleDir = resolve(
				".pi/extensions/structural-analyzer/test/fixtures/structural-sample",
			);
			if (!existsSync(sampleDir)) {
				throw new Error("fixtures not found");
			}

			const stdout = execSync(
				`ast-grep scan --pattern 'console.log($A)' --json=stream --lang ts --cwd '${sampleDir}'`,
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseSgOutput(stdout);
			assert.ok(result.matches > 0, `Expected at least 1 match, got ${result.matches}`);
		},
	);

	it(
		"runs sg scan with try/catch pattern on Python fixtures",
		{ skip: !hasAstGrep ? skipMsg : false, timeout: 15_000 },
		() => {
			const { resolve } = require("node:path");
			const { execSync } = require("node:child_process");
			const { existsSync } = require("node:fs");
			const sampleDir = resolve(
				".pi/extensions/structural-analyzer/test/fixtures/structural-sample",
			);
			if (!existsSync(sampleDir)) {
				throw new Error("fixtures not found");
			}

			const stdout = execSync(
				`ast-grep scan --pattern 'try { $$$BODY } catch (e) { console.log($A) }' --json=stream --lang py --cwd '${sampleDir}'`,
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			const result = parseSgOutput(stdout);
			assert.ok(result.matches > 0, `Expected at least 1 match, got ${result.matches}`);
		},
	);
});
