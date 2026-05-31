/**
 * Tests for check-extensions extension
 *
 * Phases 1-8: all modules
 *
 * Run with:
 *   node --experimental-strip-types --test test/check-extensions.test.mts
 */

import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

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

	// ═══════════════════════════════════════════════════════════════
	// Bug fix: isInternalEntry must not drop Fixed entries with API names
	// ═══════════════════════════════════════════════════════════════

	it("Fixed entry with internal term AND API keyword includes apiNames (bug fix)", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed provider registration for pi.exec
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "Fixed entry should NOT be dropped");
		assert.ok(fixed[0]!.apiNames.includes("exec"), "Should extract 'exec' from pi.exec");
		assert.ok(fixed[0]!.apiNames.length > 0, "apiNames should not be empty");
	});

	it("Fixed entry with only internal terms (no API names) still excluded", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed provider connection timeout
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 0, "Pure internal Fixed entry should be excluded");
	});

	it("Fixed entry with different internal terms (no API) excluded", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed theme alignment on macOS
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 0, "Theme/macOS internal Fixed entry should be excluded");
	});

	it("Fixed entry with API-only terms (no internal) still included", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed extension registration for custom tools
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "API-only Fixed entry should be included");
		const apiNames = fixed[0]!.apiNames;
		assert.ok(apiNames.includes("extension"), "Should extract 'extension'");
		assert.ok(apiNames.includes("tool"), "Should extract 'tool'");
	});

	it("Fixed entry with multiple broad internal terms + API keyword included", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed bash login reference in pi.exec
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "Fixed entry with internal terms + API should be included");
		assert.ok(fixed[0]!.apiNames.includes("exec"), "Should extract 'exec' from pi.exec");
	});

	it("Fixed entry with worker/resize internal terms + pi.on included", () => {
		const md = `## [1.0.0] - 2026-01-01

### Fixed

- Fixed worker resize handler for pi.on events
`;
		const entries = parseChangelog(md);
		const fixed = entries.filter((e) => e.category === "Fixed");
		assert.strictEqual(fixed.length, 1, "Fixed entry with worker+resize+pi.on should be included");
		assert.ok(fixed[0]!.apiNames.includes("on"), "Should extract 'on' from pi.on");
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
		const extDir = join(tmpDir, "extensions", "caveman");
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

		const result = scanExtensions(join(tmpDir, "extensions"), [
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
		const extDir = join(tmpDir, "extensions", "my-extension");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		const result = scanExtensions(join(tmpDir, "extensions"), ["pi.on"]);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]!.extensionName, "my-extension");
	});

	it("top-level .ts files use the file stem as the extension name", () => {
		mkdirSync(join(tmpDir, "dummy-ext"), { recursive: true });
		writeFileSync(join(tmpDir, "ripgrep-search.ts"), `pi.on("session_start", async () => {});\n`);

		const result = scanExtensions(tmpDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]!.extensionName, "ripgrep-search");
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

	// ═══════════════════════════════════════════════════════════════
	// Root-file extensionName fix
	// ═══════════════════════════════════════════════════════════════

	it("root-level .ts file gets its filename (no .ts) as extensionName", () => {
		// Create a root-level .ts file (no subdirectory)
		writeFileSync(join(tmpDir, "ripgrep-search.ts"), `pi.on("start", async () => {});\n`);

		const result = scanExtensions(tmpDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]!.extensionName, "ripgrep-search");
	});

	it("multiple root-level .ts files each get correct extensionName", () => {
		writeFileSync(join(tmpDir, "ripgrep-search.ts"), `pi.on("start", async () => {});\n`);
		writeFileSync(join(tmpDir, "piignore.ts"), `pi.exec("echo", ["hi"]);\n`);

		const result = scanExtensions(tmpDir, ["pi.on", "pi.exec"]);
		assert.strictEqual(result.findings.length, 2);
		const names = result.findings.map((f) => f.extensionName).sort();
		assert.deepStrictEqual(names, ["piignore", "ripgrep-search"]);
	});

	it("subdirectory extension still gets correct name when root-level .ts also present (regression)", () => {
		const extDir = join(tmpDir, "caveman");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		writeFileSync(join(tmpDir, "ripgrep-search.ts"), `pi.on("start", async () => {});\n`);

		const result = scanExtensions(tmpDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 2);
		const cavemanFindings = result.findings.filter((f) => f.extensionName === "caveman");
		assert.strictEqual(cavemanFindings.length, 1);
		const rootFindings = result.findings.filter((f) => f.extensionName === "ripgrep-search");
		assert.strictEqual(rootFindings.length, 1);
	});

	it("root-level .ts file with multiple dots strips only .ts suffix", () => {
		writeFileSync(join(tmpDir, "my.file.name.ts"), `pi.on("start", async () => {});\n`);

		const result = scanExtensions(tmpDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]!.extensionName, "my.file.name");
	});

	it("no root-level .ts files, only subdirectories — no regression", () => {
		const extDir = join(tmpDir, "caveman");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		const result = scanExtensions(tmpDir, ["pi.on"]);
		assert.strictEqual(result.findings.length, 1);
		assert.strictEqual(result.findings[0]!.extensionName, "caveman");
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

// ═══════════════════════════════════════════════════════════════════════
// Phase 4: ast-scanner.ts — AST-based file scanning
// ═══════════════════════════════════════════════════════════════════════

import {
	scanExtensionsAST,
	type ASTFinding,
	type ASTScanningResult,
} from "../.pi/extensions/check-extensions/ast-scanner.ts";

/**
 * Resolve ast-grep binary path from npm global prefix.
 */
function getAstGrepPath(): string {
	const home = process.env.HOME || "/home/miria";
	const candidates = [
		join(home, ".npm-global", "bin", "ast-grep"),
		"/usr/local/bin/ast-grep",
		"/usr/bin/ast-grep",
	];
	for (const c of candidates) {
		try {
			accessSync(c, constants.X_OK);
			return c;
		} catch {
			/* try next */
		}
	}
	return "ast-grep"; // fallback — hope it's on PATH
}

describe("ast-scanner", () => {
	let tmpDir: string;
	const astGrepPath = getAstGrepPath();

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "ast-scan-test-"));
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

	it("finds runtime-call findings for pi.method calls", async () => {
		const extDir = join(tmpDir, "caveman");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`pi.on("session_start", async (_event: any, ctx: any) => {`,
				`  pi.registerCommand("caveman", { description: "", handler: async () => {} });`,
				`  pi.registerTool({ name: "test", execute: async () => {} });`,
				`  pi.exec("gh", ["issue"], { cwd: ctx.cwd });`,
				`  ctx.ui.notify("hello", "info");`,
				`  pi.sendUserMessage("test");`,
				`});`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(
			extDir,
			["pi.on", "pi.registerCommand", "pi.registerTool", "pi.exec", "pi.sendUserMessage", "ctx.ui"],
			execFn,
			astGrepPath,
		);

		// Should have runtime-call findings
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.ok(runtimeCalls.length >= 5, `Expected >=5 runtime calls, got ${runtimeCalls.length}`);

		const apiNames = runtimeCalls.map((f) => f.apiName);
		assert.ok(apiNames.includes("pi.on"), "Should find pi.on");
		assert.ok(apiNames.includes("pi.registerCommand"), "Should find pi.registerCommand");
		assert.ok(apiNames.includes("pi.registerTool"), "Should find pi.registerTool");
		assert.ok(apiNames.includes("pi.exec"), "Should find pi.exec");
		assert.ok(apiNames.includes("pi.sendUserMessage"), "Should find pi.sendUserMessage");
	});

	it("skips comments and string literals", async () => {
		const extDir = join(tmpDir, "clean-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`// TODO: migrate pi.on("tool_call", oldHandler)`,
				`// pi.registerCommand("old", { handler: oldFn });`,
				`const x = "pi.on inside string";`,
				`const y = "ctx.ui should not match";`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(
			extDir,
			["pi.on", "pi.registerCommand", "ctx.ui"],
			execFn,
			astGrepPath,
		);

		// No runtime-call findings from comments or strings
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.strictEqual(runtimeCalls.length, 0, "Should NOT find runtime calls in comments/strings");
	});

	it("classifies import-type and import-value contexts", async () => {
		const extDir = join(tmpDir, "import-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
				`import { registerCommand } from "@earendil-works/pi-coding-agent";`,
				`pi.on("session_start", async () => {});`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(
			extDir,
			["pi.on", "pi.registerCommand"],
			execFn,
			astGrepPath,
		);

		// Should have import-type finding
		const typeImports = result.findings.filter((f) => f.matchContext === "import-type");
		assert.ok(typeImports.length >= 1, `Expected >=1 import-type, got ${typeImports.length}`);

		// Should have import-value finding
		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.ok(valueImports.length >= 1, `Expected >=1 import-value, got ${valueImports.length}`);

		// Should have runtime-call finding
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.ok(runtimeCalls.length >= 1, `Expected >=1 runtime-call, got ${runtimeCalls.length}`);
	});

	// ═══════════════════════════════════════════════════════════
	// False-positive prevention: substring matching in import findings
	// ═══════════════════════════════════════════════════════════

	it("value import with false-positive substrings produces zero import-value findings", async () => {
		const extDir = join(tmpDir, "false-pos-ext");
		mkdirSync(extDir, { recursive: true });
		// Each name below contains a PI_APIS short name as substring
		// but has no exact match. "connect".includes("on") = true,
		// "ExtensionAPI".includes("on") = true, "ExecResult".includes("exec") = true, etc.
		writeFileSync(
			join(extDir, "index.ts"),
			[
				`import { connect, ExtensionAPI, ExecResult, ExecOptions, isToolCallEventType } from "@earendil-works/pi-coding-agent";`,
			].join("\n"),
		);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			0,
			`Expected 0 import-value findings for false-positive names, got ${valueImports.length}`,
		);
	});

	it("Edge: empty value import produces zero findings, no crash", async () => {
		const extDir = join(tmpDir, "empty-import-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `import {} from "@earendil-works/pi-coding-agent";\n`);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(valueImports.length, 0, "Empty import should produce 0 findings");
	});

	it("Edge: single exact match 'on' produces one pi.on import-value finding", async () => {
		const extDir = join(tmpDir, "exact-match-on");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import { on } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(valueImports.length, 1, "Single exact match 'on' should produce 1 finding");
		assert.strictEqual(valueImports[0]!.apiName, "pi.on");
	});

	it("Edge: multiple exact matches 'on, exec' produce two findings", async () => {
		const extDir = join(tmpDir, "multi-exact-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(
			join(extDir, "index.ts"),
			`import { on, exec } from "@earendil-works/pi-coding-agent";\n`,
		);

		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);

		const valueImports = result.findings.filter((f) => f.matchContext === "import-value");
		assert.strictEqual(
			valueImports.length,
			2,
			`Multiple exact matches should produce 2 findings, got ${valueImports.length}`,
		);
		const apiNames = valueImports.map((f) => f.apiName).sort();
		assert.deepStrictEqual(apiNames, ["pi.exec", "pi.on"]);
	});

	it("extracts call args from pi.on matches", async () => {
		const extDir = join(tmpDir, "args-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(extDir, ["pi.on"], execFn, astGrepPath);

		const piOnFindings = result.findings.filter((f) => f.apiName === "pi.on");
		assert.ok(piOnFindings.length >= 1);
		const finding = piOnFindings[0]!;
		// callArgs should include "session_start" (first arg)
		assert.ok(
			finding.callArgs.includes('"session_start"') ||
				finding.callArgs.some((a) => a.includes("session_start")),
			"Should extract first arg",
		);
	});

	it("Boundary: empty extensions dir returns empty", async () => {
		const execFn = async (): Promise<{
			stdout: string;
			stderr: string;
			code: number;
			killed: boolean;
		}> => {
			return { stdout: "", stderr: "", code: 0, killed: false };
		};

		const result = await scanExtensionsAST(
			join(tmpDir, "no-files"),
			["pi.on"],
			execFn,
			astGrepPath,
		);
		assert.strictEqual(result.findings.length, 0);
	});

	it("Boundary: file with no patterns produces no findings", async () => {
		const extDir = join(tmpDir, "empty-ext");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `const x = 42;\nexport default x;\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(extDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		assert.strictEqual(result.findings.length, 0);
	});

	// ═══════════════════════════════════════════════════════════════
	// Root-file extensionName fix (ast-scanner)
	// ═══════════════════════════════════════════════════════════════

	it("top-level .ts files keep their own file stem in AST findings", async () => {
		mkdirSync(join(tmpDir, "dummy-ext"), { recursive: true });
		writeFileSync(join(tmpDir, "ripgrep-search.ts"), `pi.on("session_start", async () => {});\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(tmpDir, ["pi.on"], execFn, astGrepPath);
		const runtimeCalls = result.findings.filter((f) => f.matchContext === "runtime-call");
		assert.strictEqual(runtimeCalls.length, 1);
		assert.strictEqual(runtimeCalls[0]!.extensionName, "ripgrep-search");
	});

	it("multiple root-level .ts files each get correct extensionName (ast)", async () => {
		writeFileSync(join(tmpDir, "ranked-map.ts"), `pi.on("build", async () => {});\n`);
		writeFileSync(join(tmpDir, "structural-analyzer.ts"), `pi.exec("analyze", []);\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(tmpDir, ["pi.on", "pi.exec"], execFn, astGrepPath);
		assert.strictEqual(result.findings.length, 2);
		const names = result.findings.map((f) => f.extensionName).sort();
		assert.deepStrictEqual(names, ["ranked-map", "structural-analyzer"]);
	});

	it("subdirectory extension still correct alongside root-level .ts (ast regression)", async () => {
		const extDir = join(tmpDir, "caveman");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "index.ts"), `pi.on("session_start", async () => {});\n`);

		writeFileSync(join(tmpDir, "tsc-checkpoint.ts"), `pi.on("check", async () => {});\n`);

		const execFn = async (
			cmd: string,
			args: string[],
		): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> => {
			return new Promise((resolve) => {
				execFile(cmd, args, { timeout: 10_000 }, (err, stdout, stderr) => {
					resolve({
						stdout: stdout || "",
						stderr: stderr || "",
						code: err ? 1 : 0,
						killed: false,
					});
				});
			});
		};

		const result = await scanExtensionsAST(tmpDir, ["pi.on"], execFn, astGrepPath);
		assert.strictEqual(result.findings.length, 2);
		const cavemanFindings = result.findings.filter((f) => f.extensionName === "caveman");
		assert.strictEqual(cavemanFindings.length, 1);
		const rootFindings = result.findings.filter((f) => f.extensionName === "tsc-checkpoint");
		assert.strictEqual(rootFindings.length, 1);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 5: change-resolver.ts — Changelog-to-usage context mapping
// ═══════════════════════════════════════════════════════════════════════

import {
	resolveRelevance,
	type StructuredChange,
} from "../.pi/extensions/check-extensions/change-resolver.ts";

describe("change-resolver", () => {
	it("returns true when changelog event matches finding args", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			apiNames: ["on"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 1,
			lineContent: 'pi.on("tool_call", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ["tool_call"],
			matchContext: "runtime-call" as const,
		};
		const structured: StructuredChange = {
			deprecatedSignature: 'pi.on("tool_call")',
			newSignature: 'pi.on("tool_before_call")',
			affectedEventType: "tool_call",
		};

		const result = resolveRelevance(entry, finding, structured);
		assert.strictEqual(result, true);
	});

	it("returns false when changelog event doesn't match finding args", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			apiNames: ["on"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 5,
			lineContent: 'pi.on("session_start", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ["session_start"],
			matchContext: "runtime-call" as const,
		};
		const structured: StructuredChange = {
			deprecatedSignature: 'pi.on("tool_call")',
			newSignature: 'pi.on("tool_before_call")',
			affectedEventType: "tool_call",
		};

		const result = resolveRelevance(entry, finding, structured);
		assert.strictEqual(result, false);
	});

	it("returns undefined when no structured change info available (falls through)", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Updated some internal API",
			apiNames: ["on"],
			isBreaking: false,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 1,
			lineContent: 'pi.on("session_start", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ["session_start"],
			matchContext: "runtime-call" as const,
		};

		// No structured change provided → falls through (return undefined)
		const result = resolveRelevance(entry, finding, undefined);
		assert.strictEqual(result, undefined);
	});

	it("returns false when finding has no callArgs", () => {
		const entry = {
			version: "1.0.0",
			category: "Changed" as const,
			description: "Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			apiNames: ["on"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.on",
			line: 5,
			lineContent: 'pi.on("tool_call", handler)',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: [],
			matchContext: "runtime-call" as const,
		};
		const structured: StructuredChange = {
			deprecatedSignature: 'pi.on("tool_call")',
			newSignature: 'pi.on("tool_before_call")',
			affectedEventType: "tool_call",
		};

		const result = resolveRelevance(entry, finding, structured);
		assert.strictEqual(result, undefined);
	});

	it("returns true for pi.registerCommand changes when command name matches", () => {
		const entry = {
			version: "2.0.0",
			category: "Deprecated" as const,
			description: "Registering commands without handler option deprecated",
			apiNames: ["registerCommand"],
			isBreaking: true,
		};
		const finding = {
			extensionName: "caveman",
			file: "index.ts",
			apiName: "pi.registerCommand",
			line: 1,
			lineContent: 'pi.registerCommand("my-cmd", { description: "", handler: async () => {} })',
			changelogVersion: "",
			isBreaking: false,
			category: "",
			callArgs: ["my-cmd"],
			matchContext: "runtime-call" as const,
		};

		const result = resolveRelevance(entry, finding, undefined);
		// No structured change with specific deprecatedSignature → falls through
		assert.strictEqual(result, undefined);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 6: migration-generator.ts — Before/after code snippets
// ═══════════════════════════════════════════════════════════════════════

import {
	generateMigrationSnippet,
	type MigrationSnippet,
} from "../.pi/extensions/check-extensions/migration-generator.ts";

describe("migration-generator", () => {
	it("generates snippet for pi.on tool_call → tool_before_call", () => {
		const snippet = generateMigrationSnippet(
			"Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
			"pi.on",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.before.includes("pi.on"), "before should contain pi.on");
			assert.ok(snippet.after.includes("pi.on"), "after should contain pi.on");
			assert.ok(snippet.before.includes("tool_call"), "before should mention tool_call");
			assert.ok(
				snippet.after.includes("tool_before_call"),
				"after should mention tool_before_call",
			);
			assert.ok(snippet.confidence > 0, "confidence should be positive");
		}
	});

	it("generates generic fallback for unknown changelog description", () => {
		const snippet = generateMigrationSnippet(
			"Fixed internal error handling for provider connections",
			"pi.exec",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.before.includes("Update"), "fallback should have generic message");
			assert.strictEqual(snippet.confidence, 0, "fallback confidence should be 0");
		}
	});

	it("returns snippet for pi.registerCommand changes", () => {
		const snippet = generateMigrationSnippet(
			"Registering commands now requires a handler option",
			"pi.registerCommand",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.confidence >= 0, "confidence should be >= 0");
		}
	});

	it("returns null for null/empty description", () => {
		const snippet = generateMigrationSnippet("", "pi.on");
		assert.strictEqual(snippet, null);
	});

	it("generates snippet for tool-related changes", () => {
		const snippet = generateMigrationSnippet(
			"Tool registration API changed: `registerTool({ ... })` now requires `execute` instead of `run`",
			"pi.registerTool",
		);
		assert.ok(snippet, "Expected a MigrationSnippet");
		if (snippet) {
			assert.ok(snippet.before.includes("registerTool"), "before should mention registerTool");
			assert.ok(snippet.confidence >= 0.4, "confidence should be >= 0.4 for known API");
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 7: impact-scorer.ts — Cross-extension impact scoring
// ═══════════════════════════════════════════════════════════════════════

import {
	computeImpactScore,
	type ImpactScore,
} from "../.pi/extensions/check-extensions/impact-scorer.ts";

describe("impact-scorer", () => {
	it("scores no findings as 'none' severity", () => {
		const score = computeImpactScore("caveman", []);
		assert.strictEqual(score.severity, "none");
		assert.strictEqual(score.uniqueApis, 0);
		assert.strictEqual(score.breakingCount, 0);
	});

	it("scores one non-breaking finding as 'low' severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.on",
				line: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: false,
				category: "Added",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("caveman", findings);
		assert.strictEqual(score.severity, "low");
		assert.strictEqual(score.uniqueApis, 1);
	});

	it("scores one breaking finding as 'medium' severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.on",
				line: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Deprecated",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("caveman", findings);
		assert.strictEqual(score.severity, "medium");
		assert.strictEqual(score.breakingCount, 1);
	});

	it("scores multiple breaking findings as 'high' severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.on",
				line: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Deprecated",
				callArgs: [],
				matchContext: "runtime-call",
			},
			{
				extensionName: "caveman",
				file: "index.ts",
				apiName: "pi.registerCommand",
				line: 2,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Removed",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("caveman", findings);
		assert.strictEqual(score.severity, "high");
		assert.strictEqual(score.uniqueApis, 2);
		assert.strictEqual(score.breakingCount, 2);
	});

	it("scores breaking+non-breaking mixed as appropriate severity", () => {
		const findings: ASTFinding[] = [
			{
				extensionName: "mixed",
				file: "a.ts",
				apiName: "pi.on",
				line: 1,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Deprecated",
				callArgs: [],
				matchContext: "runtime-call",
			},
			{
				extensionName: "mixed",
				file: "a.ts",
				apiName: "pi.exec",
				line: 2,
				lineContent: "",
				changelogVersion: "",
				isBreaking: true,
				category: "Removed",
				callArgs: [],
				matchContext: "runtime-call",
			},
			{
				extensionName: "mixed",
				file: "a.ts",
				apiName: "ctx.ui",
				line: 3,
				lineContent: "",
				changelogVersion: "",
				isBreaking: false,
				category: "Added",
				callArgs: [],
				matchContext: "runtime-call",
			},
		];
		const score = computeImpactScore("mixed", findings);
		assert.strictEqual(score.severity, "high");
		assert.strictEqual(score.uniqueApis, 3);
	});

	it("sets extensionName on result", () => {
		const score = computeImpactScore("my-ext", []);
		assert.strictEqual(score.extensionName, "my-ext");
	});

	it("scores 6+ breaking findings as 'critical'", () => {
		const findings: ASTFinding[] = Array.from({ length: 6 }, (_, i) => ({
			extensionName: "big-ext",
			file: "index.ts",
			apiName: `api.${i}`,
			line: i + 1,
			lineContent: "",
			changelogVersion: "",
			isBreaking: true,
			category: "Deprecated",
			callArgs: [],
			matchContext: "runtime-call" as const,
		}));
		const score = computeImpactScore("big-ext", findings);
		assert.strictEqual(score.severity, "critical");
		assert.strictEqual(score.uniqueApis, 6);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 8: manifest-reader.ts — Extension manifest parsing
// ═══════════════════════════════════════════════════════════════════════

import {
	readManifest,
	type ExtensionManifest,
} from "../.pi/extensions/check-extensions/manifest-reader.ts";

describe("manifest-reader", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "manifest-test-"));
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

	it("reads extension.json when present", () => {
		writeFileSync(
			join(tmpDir, "extension.json"),
			JSON.stringify({ piVersion: "0.75.0", testedWithVersion: "0.75.0" }),
		);
		const manifest = readManifest(tmpDir);
		assert.strictEqual(manifest.piVersion, "0.75.0");
		assert.strictEqual(manifest.testedWithVersion, "0.75.0");
	});

	it("reads package.json as fallback when extension.json missing", () => {
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ piVersion: "0.74.0", testedWithVersion: "0.74.0" }),
		);
		const manifest = readManifest(tmpDir);
		assert.strictEqual(manifest.piVersion, "0.74.0");
		assert.strictEqual(manifest.testedWithVersion, "0.74.0");
	});

	it("returns UNKNOWN when no manifest found", () => {
		const manifest = readManifest(tmpDir);
		assert.strictEqual(manifest.piVersion, "UNKNOWN");
		assert.strictEqual(manifest.testedWithVersion, "UNKNOWN");
	});

	it("reads package.json from nested directory", () => {
		// Some extensions have package.json inside a nested folder
		writeFileSync(
			join(tmpDir, "package.json"),
			JSON.stringify({ version: "1.0.0", piVersion: "0.76.0" }),
		);
		const manifest = readManifest(tmpDir);
		assert.strictEqual(manifest.piVersion, "0.76.0");
	});

	it("returns UNKNOWN for empty extension.json", () => {
		writeFileSync(join(tmpDir, "extension.json"), "{}");
		const manifest = readManifest(tmpDir);
		assert.strictEqual(manifest.piVersion, "UNKNOWN");
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 9: changelog-parser.ts — Extended: parseStructuredChange
// ═══════════════════════════════════════════════════════════════════════

import { parseStructuredChange } from "../.pi/extensions/check-extensions/changelog-parser.ts";

describe("parseStructuredChange", () => {
	it("parses pi.on tool_call → tool_before_call migration", () => {
		const result = parseStructuredChange(
			"Deprecated `pi.on(tool_call)` in favor of `pi.on(tool_before_call)`",
		);
		assert.ok(result, "Expected a StructuredChange");
		if (result) {
			assert.strictEqual(result.deprecatedSignature, 'pi.on("tool_call")');
			assert.strictEqual(result.newSignature, 'pi.on("tool_before_call")');
			assert.strictEqual(result.affectedEventType, "tool_call");
		}
	});

	it("parses pi.registerCommand signature change", () => {
		const result = parseStructuredChange(
			"`pi.registerCommand(name, opts)` now requires `opts.handler` to be async",
		);
		assert.ok(result, "Expected a StructuredChange");
		if (result) {
			assert.ok(result.deprecatedSignature?.includes("registerCommand"));
			assert.ok(result.newSignature?.includes("registerCommand"));
		}
	});

	it("returns null for non-API description", () => {
		const result = parseStructuredChange("Fixed internal provider connection error");
		assert.strictEqual(result, null);
	});

	it("parses ctx.ui redesign description", () => {
		const result = parseStructuredChange(
			"`ctx.ui.select()` args changed from `(items, prompt)` to `(config)`",
		);
		assert.ok(result, "Expected a StructuredChange");
		if (result) {
			assert.ok(
				result.deprecatedSignature?.includes("ctx.ui") || result.affectedEventType === "select",
			);
		}
	});

	it("returns null for empty description", () => {
		assert.strictEqual(parseStructuredChange(""), null);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Phase 10: issue-builder.ts — Extended: migration snippets + impact scores
// ═══════════════════════════════════════════════════════════════════════

import {
	buildMigrationSection,
	buildIssueBodyWithSnippets,
	buildImpactSummary,
	type ExecFn,
} from "../.pi/extensions/check-extensions/issue-builder.ts";

describe("issue-builder-extended", () => {
	describe("buildMigrationSection", () => {
		it("returns formatted section with before/after blocks", () => {
			const snippets = [
				{
					apiName: "pi.on",
					before: 'pi.on("tool_call", handler)',
					after: 'pi.on("tool_before_call", handler)',
					confidence: 0.9,
				},
			];
			const section = buildMigrationSection(snippets);
			assert.ok(section.includes("## Migration Guide"));
			assert.ok(section.includes("Before"));
			assert.ok(section.includes("After"));
			assert.ok(section.includes('pi.on("tool_call", handler)'));
			assert.ok(section.includes('pi.on("tool_before_call", handler)'));
		});

		it("returns empty string for empty snippets array", () => {
			assert.strictEqual(buildMigrationSection([]), "");
		});

		it("handles multiple snippets", () => {
			const snippets = [
				{
					apiName: "pi.on",
					before: 'pi.on("tool_call", handler)',
					after: 'pi.on("tool_before_call", handler)',
					confidence: 0.9,
				},
				{
					apiName: "pi.registerTool",
					before: "registerTool({ run: handler })",
					after: "registerTool({ execute: handler })",
					confidence: 0.7,
				},
			];
			const section = buildMigrationSection(snippets);
			assert.ok(section.includes("tool_call"));
			assert.ok(section.includes("execute"));
		});
	});

	describe("buildImpactSummary", () => {
		it("formats impact score in markdown", () => {
			const summary = buildImpactSummary({
				extensionName: "caveman",
				severity: "high",
				uniqueApis: 3,
				breakingCount: 2,
				hasTests: false,
			});
			assert.ok(summary.includes("High"));
			assert.ok(summary.includes("3"));
			assert.ok(summary.includes("2"));
		});

		it("includes hasTests badge when tests exist", () => {
			const summary = buildImpactSummary({
				extensionName: "caveman",
				severity: "low",
				uniqueApis: 1,
				breakingCount: 0,
				hasTests: true,
			});
			assert.ok(summary.includes("**Tests:** ✅"));
		});

		it("includes no-tests badge when tests absent", () => {
			const summary = buildImpactSummary({
				extensionName: "caveman",
				severity: "medium",
				uniqueApis: 2,
				breakingCount: 1,
				hasTests: false,
			});
			assert.ok(summary.includes("**Tests:** ❌"));
		});
	});

	describe("buildIssueBodyWithSnippets", () => {
		it("generates body with migration snippets and impact summary", () => {
			const findings: ASTFinding[] = [
				{
					extensionName: "caveman",
					file: "index.ts",
					apiName: "pi.on",
					line: 1,
					lineContent: 'pi.on("tool_call", handler)',
					changelogVersion: "1.0.0",
					isBreaking: true,
					category: "Deprecated",
					callArgs: ["tool_call"],
					matchContext: "runtime-call",
				},
			];
			const snippets = [
				{
					apiName: "pi.on",
					before: 'pi.on("tool_call", handler)',
					after: 'pi.on("tool_before_call", handler)',
					confidence: 0.9,
				},
			];
			const impactScore = {
				extensionName: "caveman",
				severity: "medium" as const,
				uniqueApis: 1,
				breakingCount: 1,
				hasTests: false as const,
			};

			const body = buildIssueBodyWithSnippets("caveman", findings, "1.0.0", snippets, impactScore);
			assert.ok(body.includes("Migration Guide"));
			assert.ok(body.includes("Impact"));
			assert.ok(body.includes("Medium"));
			assert.ok(body.includes("tool_before_call"));
		});

		it("handles empty snippets gracefully", () => {
			const findings: ASTFinding[] = [];
			const impactScore = {
				extensionName: "caveman",
				severity: "none" as const,
				uniqueApis: 0,
				breakingCount: 0,
				hasTests: false as const,
			};

			const body = buildIssueBodyWithSnippets("caveman", findings, "1.0.0", [], impactScore);
			assert.ok(body.includes("caveman"));
			assert.ok(body.includes("1.0.0"));
		});
	});
});
