/**
 * Tests for check-extensions extension
 *
 * Phases 1-3: changelog-parser, extension-scanner, issue-builder
 *
 * Run with:
 *   node --experimental-strip-types --test test/check-extensions.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════
// Phase 1: changelog-parser.ts
// ═══════════════════════════════════════════════════════════════════════

import {
	parseChangelog,
	type ChangeEntry,
} from "../.pi/extensions/check-extensions/changelog-parser.ts";

describe("changelog-parser", () => {
	it("parses valid changelog with all categories", () => {
		const md = `# Changelog

## [1.0.0] - 2026-01-15

### Added

- New extension API for custom tools
- New registerCommand method on pi

### Changed

- Updated tool execution to use new ctx format

### Deprecated

- Old extension registration pattern

### Removed

- Legacy event system support for extensions

### Fixed

- Tool result event handling for custom extensions

### Security

- Updated extension sandbox permissions
`;
		const entries = parseChangelog(md);
		assert.ok(entries.length >= 5, `Expected at least 5 entries, got ${entries.length}`);
		// Check Added entries
		const added = entries.filter((e) => e.category === "Added");
		assert.ok(added.length >= 1);
		// Changed entries
		const changed = entries.filter((e) => e.category === "Changed");
		assert.ok(changed.length >= 1);
		// Deprecated entries
		const deprecated = entries.filter((e) => e.category === "Deprecated");
		assert.ok(deprecated.length >= 1);
		// Removed entries
		const removed = entries.filter((e) => e.category === "Removed");
		assert.ok(removed.length >= 1);
		// Fixed entries
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.ok(fixed.length >= 1);
		// Version extraction
		for (const e of entries) {
			assert.strictEqual(e.version, "1.0.0");
		}
	});

	it("API-visible keywords set apiNames and isBreaking for Deprecated/Removed", () => {
		const md = `## [2.0.0] - 2026-03-01

### Added

- New tool registration via registerTool API

### Deprecated

- Old extension event system, use pi.on instead

### Removed

- Legacy SDK export function removed

### Fixed

- Internal clipboard handling on macOS
`;
		const entries = parseChangelog(md);
		// Added entry with tool/registerTool keywords
		const added = entries.find((e) => e.category === "Added");
		assert.ok(added);
		assert.ok(added.apiNames.length > 0, "Added entry should have apiNames");
		assert.ok(added.apiNames.includes("registerTool"), "Should extract registerTool");

		// Deprecated - breaking
		const deprecated = entries.find((e) => e.category === "Deprecated");
		assert.ok(deprecated);
		assert.strictEqual(deprecated.isBreaking, true);

		// Removed - breaking
		const removed = entries.find((e) => e.category === "Removed");
		assert.ok(removed);
		assert.strictEqual(removed.isBreaking, true);

		// Fixed with internal-only terms - should be excluded
		const fixed = entries.find((e) => e.category === "Fixed");
		assert.strictEqual(fixed, undefined, "Fixed internal entry should be excluded");
	});

	it("Fixed entry with API-visible terms included in output", () => {
		const md = `## [1.1.0] - 2026-02-01

### Fixed

- Fixed tool result event handling for custom extensions
`;
		const entries = parseChangelog(md);
		const fixed = entries.find((e) => e.category === "Fixed");
		assert.ok(fixed, "Fixed entry with API-visible terms should be included");
		assert.ok(fixed.apiNames.length > 0);
	});

	it("Added entry mentioning pi.on or registerTool captures apiNames", () => {
		const md = `## [1.0.0] - 2026-01-01

### Added

- New pi.on event handler for session lifecycle
- Added registerTool for custom tool definitions
`;
		const entries = parseChangelog(md);
		const added = entries.filter((e) => e.category === "Added");
		assert.ok(added.length >= 2);
		const allApiNames = added.flatMap((e) => e.apiNames);
		assert.ok(allApiNames.includes("on"), "Should capture on from pi.on");
		assert.ok(allApiNames.includes("registerTool"), "Should capture registerTool");
	});

	it("Deprecated entry sets isBreaking=true", () => {
		const md = `## [1.0.0] - 2026-01-01

### Deprecated

- Old extension API deprecated
`;
		const entries = parseChangelog(md);
		const dep = entries.find((e) => e.category === "Deprecated");
		assert.ok(dep);
		assert.strictEqual(dep.isBreaking, true);
	});

	it("Boundary: empty changelog returns empty array", () => {
		assert.deepStrictEqual(parseChangelog(""), []);
	});

	it("Boundary: no version headers returns empty array, no crash", () => {
		assert.deepStrictEqual(
			parseChangelog("Just some text with no headers\n\nNo versions here"),
			[],
		);
	});

	it("Boundary: malformed header without date still parses version", () => {
		const md = `## [0.75.5]

### Added

- New extension API
`;
		const entries = parseChangelog(md);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]!.version, "0.75.5");
	});

	it("Boundary: category header with no bullet items produces entry with empty description", () => {
		const md = `## [1.0.0] - 2026-01-01

### Added
`;
		const entries = parseChangelog(md);
		const added = entries.find((e) => e.category === "Added");
		assert.ok(added);
		assert.strictEqual(added.description, "");
	});

	it("Error: undefined input returns empty array", () => {
		assert.deepStrictEqual(parseChangelog(undefined as unknown as string), []);
	});

	it("Error: null input returns empty array", () => {
		assert.deepStrictEqual(parseChangelog(null as unknown as string), []);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 2: extension-scanner.ts
// ═══════════════════════════════════════════════════════════════════════

import {
	scanExtensions,
	type ScanningResult,
	type Finding,
} from "../.pi/extensions/check-extensions/extension-scanner.ts";

describe("extension-scanner", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ext-scan-test-"));
	});

	afterEach(() => {
		if (tmpDir) {
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ok */
			}
		}
	});

	it("scans .ts files for pi. and ctx. patterns", () => {
		const extDir = join(tmpDir, "caveman");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`pi.on("session_start", async (_event, ctx) => {`,
				`  pi.registerCommand("caveman", { description: "", handler: async () => {} });`,
				`  pi.registerTool({ name: "my-tool", execute: async () => {} });`,
				`  pi.exec("gh", ["issue", "list"], { cwd: ctx.cwd });`,
				`  ctx.ui.notify("hello", "info");`,
				`  pi.sendUserMessage("test");`,
				`});`,
			].join("\n"),
		);

		const result = scanExtensions(extDir, [
			"pi.on",
			"pi.registerCommand",
			"pi.registerTool",
			"pi.exec",
			"pi.sendUserMessage",
			"ctx.ui",
		]);
		assert.ok(result.findings.length >= 6, `Expected >=6 findings, got ${result.findings.length}`);
		// Check extension name derivation
		for (const f of result.findings) {
			assert.strictEqual(f.extensionName, "caveman");
		}
		// Check api names
		const apiNames = result.findings.map((f) => f.apiName);
		assert.ok(apiNames.includes("pi.on"), "Should find pi.on");
		assert.ok(apiNames.includes("pi.registerCommand"), "Should find pi.registerCommand");
		assert.ok(apiNames.includes("pi.registerTool"), "Should find pi.registerTool");
		assert.ok(apiNames.includes("pi.exec"), "Should find pi.exec");
		assert.ok(apiNames.includes("pi.sendUserMessage"), "Should find pi.sendUserMessage");
		assert.ok(apiNames.includes("ctx.ui"), "Should find ctx.ui");
	});

	it("extension name derived from parent directory name", () => {
		const extDir = join(tmpDir, "my-extension");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		const result = scanExtensions(extDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]!.extensionName, "my-extension");
	});

	it("Boundary: file with no pi./ctx. patterns produces no findings", () => {
		const extDir = join(tmpDir, "empty-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `const x = 42;\nexport default x;\n`);

		const result = scanExtensions(extDir, ["pi.on", "pi.exec"]);
		assert.strictEqual(result.findings.length, 0);
	});

	it("Boundary: empty extensions directory returns empty array", () => {
		const extDir = join(tmpDir, "no-files");
		mkdirSync(extDir, { recursive: true });

		const result = scanExtensions(extDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 0);
	});

	it("Boundary: scans only .ts files, skips .json", () => {
		const extDir = join(tmpDir, "mixed");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);
		writeFileSync(join(extDir, "config.json"), `{ "pi.on": true }`);

		const result = scanExtensions(extDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 1);
	});

	it("Error: unreadable file skips it, result includes skipCount", async () => {
		const { chmodSync } = await import("node:fs");
		const extDir = join(tmpDir, "unreadable");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);
		writeFileSync(join(extDir, "broken.ts"), `garbage`);

		// Make broken.ts unreadable
		try {
			chmodSync(join(extDir, "broken.ts"), 0o000);
		} catch {
			/* Windows may not support this */
		}

		const result = scanExtensions(extDir, ["pi.on"]);
		assert.ok(result.skipCount !== undefined, "Should report skipCount");
		// index.ts should still be scanned
		const indexFindings = result.findings.filter((f) => f.file.includes("index.ts"));
		assert.ok(indexFindings.length >= 1);

		// Restore permissions
		try {
			chmodSync(join(extDir, "broken.ts"), 0o644);
		} catch {
			/* ok */
		}
	});

	it("Error: directory does not exist returns empty findings gracefully", () => {
		const result = scanExtensions(join(tmpDir, "does-not-exist"), ["pi.on"]);
		assert.strictEqual(result.findings.length, 0);
	});

	it("Edge: same file has multiple API usages returns multiple Findings per file", () => {
		const extDir = join(tmpDir, "multi");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`pi.on("a", async () => {});\npi.on("b", async () => {});\npi.exec("x", []);\n`,
		);

		const result = scanExtensions(extDir, ["pi.on", "pi.exec"]);
		assert.ok(result.findings.length >= 3, `Expected >=3 findings, got ${result.findings.length}`);
	});

	it("Edge: pi.registerCommand extracts apiName as registerCommand not the command name", () => {
		const extDir = join(tmpDir, "cmd-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`pi.registerCommand("my-cmd", { description: "", handler: async () => {} });\n`,
		);

		const result = scanExtensions(extDir, ["pi.registerCommand"]);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]!.apiName, "pi.registerCommand");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 3: issue-builder.ts
// ═══════════════════════════════════════════════════════════════════════

import {
	buildIssueTitle,
	buildIssueBody,
	checkExistingIssues,
	createIssue,
	ensureLabel,
	checkGhAuth,
	type ExecFn,
} from "../.pi/extensions/check-extensions/issue-builder.ts";

describe("issue-builder", () => {
	/**
	 * Create a mock exec function for testing.
	 */
	function mockExec(result: {
		stdout: string;
		stderr: string;
		code: number;
		killed: boolean;
	}): ExecFn {
		return async (_cmd: string, _args: string[], _opts?: unknown) => result;
	}

	describe("buildIssueTitle", () => {
		it("formats title with extension name and count", () => {
			const title = buildIssueTitle("caveman", 3, "1.0.0");
			assert.strictEqual(title, "[ext-audit] caveman: 3 API changes — pi 1.0.0");
		});

		it("works with single finding", () => {
			const title = buildIssueTitle("format-on-save", 1, "2.0.0");
			assert.strictEqual(title, "[ext-audit] format-on-save: 1 API change — pi 2.0.0");
		});
	});

	describe("buildIssueBody", () => {
		it("contains file paths, API names, changelog version ref", () => {
			const findings: Finding[] = [
				{
					extensionName: "caveman",
					file: ".pi/extensions/caveman/index.ts",
					apiName: "pi.on",
					line: 3,
					lineContent: '  pi.on("session_start", async () => {});',
					changelogVersion: "1.0.0",
					isBreaking: false,
					category: "Added",
				},
			];
			const body = buildIssueBody("caveman", findings, "1.0.0");
			assert.ok(body.includes(".pi/extensions/caveman/index.ts"), "Body should contain file path");
			assert.ok(body.includes("pi.on"), "Body should contain API name");
			assert.ok(body.includes("1.0.0"), "Body should contain changelog version");
			assert.ok(body.includes("**Line:** 3"), "Body should contain line number");
		});

		it("contains breaking changes AND simplifications sections when both present", () => {
			const findings: Finding[] = [
				{
					extensionName: "caveman",
					file: "index.ts",
					apiName: "pi.on",
					line: 1,
					lineContent: "",
					changelogVersion: "1.0.0",
					isBreaking: true,
					category: "Deprecated",
				},
				{
					extensionName: "caveman",
					file: "index.ts",
					apiName: "pi.exec",
					line: 2,
					lineContent: "",
					changelogVersion: "1.0.0",
					isBreaking: false,
					category: "Added",
				},
			];
			const body = buildIssueBody("caveman", findings, "1.0.0");
			assert.ok(body.includes("Breaking Changes"), "Should have Breaking Changes section");
			assert.ok(body.includes("Simplifications"), "Should have Simplifications section");
		});

		it("has only one section when only breaking changes exist", () => {
			const findings: Finding[] = [
				{
					extensionName: "caveman",
					file: "index.ts",
					apiName: "pi.on",
					line: 1,
					lineContent: "",
					changelogVersion: "1.0.0",
					isBreaking: true,
					category: "Deprecated",
				},
			];
			const body = buildIssueBody("caveman", findings, "1.0.0");
			assert.ok(body.includes("Breaking Changes"), "Should have Breaking Changes");
			assert.ok(!body.includes("Simplifications"), "Should NOT have Simplifications section");
		});
	});

	describe("ensureLabel", () => {
		it("creates label when gh label list returns no match", async () => {
			let labelCreated = false;
			const exec: ExecFn = async (cmd, args) => {
				if (args[0] === "label" && args[1] === "list") {
					return { stdout: "", stderr: "", code: 0, killed: false };
				}
				if (args[0] === "label" && args[1] === "create") {
					labelCreated = true;
					return { stdout: "", stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			};
			await ensureLabel(exec, "SchneiderDaniel/agentcastle");
			assert.strictEqual(labelCreated, true);
		});

		it("skips label create when label already exists", async () => {
			let labelCreated = false;
			const exec: ExecFn = async (cmd, args) => {
				if (args[0] === "label" && args[1] === "list") {
					return { stdout: "extension-audit\n", stderr: "", code: 0, killed: false };
				}
				if (args[0] === "label" && args[1] === "create") {
					labelCreated = true;
					return { stdout: "", stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 1, killed: false };
			};
			await ensureLabel(exec, "SchneiderDaniel/agentcastle");
			assert.strictEqual(labelCreated, false);
		});
	});

	describe("checkExistingIssues", () => {
		it("returns true when open issue with matching title exists", async () => {
			const exec: ExecFn = async (_cmd, args) => {
				if (args.includes("--json")) {
					return {
						stdout: JSON.stringify([
							{ title: "[ext-audit] caveman: 3 API changes — pi 1.0.0", number: 42, state: "OPEN" },
						]),
						stderr: "",
						code: 0,
						killed: false,
					};
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			};
			const exists = await checkExistingIssues(
				exec,
				"SchneiderDaniel/agentcastle",
				"[ext-audit] caveman: 3 API changes — pi 1.0.0",
			);
			assert.strictEqual(exists, true);
		});

		it("returns false when only closed issues match", async () => {
			const exec: ExecFn = async (_cmd, args) => {
				if (args.includes("--json")) {
					return {
						stdout: JSON.stringify([
							{
								title: "[ext-audit] caveman: 3 API changes — pi 1.0.0",
								number: 42,
								state: "CLOSED",
							},
						]),
						stderr: "",
						code: 0,
						killed: false,
					};
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			};
			const exists = await checkExistingIssues(
				exec,
				"SchneiderDaniel/agentcastle",
				"[ext-audit] caveman: 3 API changes — pi 1.0.0",
			);
			assert.strictEqual(exists, false);
		});

		it("returns false when no matching issues exist", async () => {
			const exec: ExecFn = async () => {
				return { stdout: "[]", stderr: "", code: 0, killed: false };
			};
			const exists = await checkExistingIssues(
				exec,
				"SchneiderDaniel/agentcastle",
				"[ext-audit] caveman: 3 API changes — pi 1.0.0",
			);
			assert.strictEqual(exists, false);
		});
	});

	describe("createIssue", () => {
		it("calls gh issue create with correct args", async () => {
			let capturedArgs: string[] = [];
			const exec: ExecFn = async (_cmd, args) => {
				capturedArgs = args;
				return {
					stdout: "https://github.com/SchneiderDaniel/agentcastle/issues/42",
					stderr: "",
					code: 0,
					killed: false,
				};
			};
			const url = await createIssue(
				exec,
				"SchneiderDaniel/agentcastle",
				"[ext-audit] caveman: 3 API changes — pi 1.0.0",
				"Body text",
			);
			assert.strictEqual(url, "https://github.com/SchneiderDaniel/agentcastle/issues/42");
			assert.ok(capturedArgs.includes("--title"));
			assert.ok(capturedArgs.includes("--label"));
			assert.ok(capturedArgs.includes("extension-audit"));
			assert.ok(capturedArgs.includes("--repo"));
			assert.ok(capturedArgs.includes("SchneiderDaniel/agentcastle"));
		});

		it("throws when gh issue create fails", async () => {
			const exec: ExecFn = async () => {
				return { stdout: "", stderr: "error creating issue", code: 1, killed: false };
			};
			await assert.rejects(
				() => createIssue(exec, "SchneiderDaniel/agentcastle", "title", "body"),
				/error creating issue/,
			);
		});
	});

	describe("checkGhAuth", () => {
		it("returns true when gh auth succeeds", async () => {
			const exec: ExecFn = async () => {
				return { stdout: "", stderr: "", code: 0, killed: false };
			};
			const authed = await checkGhAuth(exec);
			assert.strictEqual(authed, true);
		});

		it("returns false when gh auth fails", async () => {
			const exec: ExecFn = async () => {
				return { stdout: "", stderr: "not authenticated", code: 1, killed: false };
			};
			const authed = await checkGhAuth(exec);
			assert.strictEqual(authed, false);
		});
	});
});
