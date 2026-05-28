/**
 * Tests for Codebase Mapper (universal-ctags integration)
 *
 * Pure function tests for parseCtagsOutput(), groupByFile(), formatTree().
 * Local copies match source at .pi/extensions/codebase-mapper.ts exactly.
 *
 * Run with:
 *   node --experimental-strip-types --test test/codebase-mapper.test.mts
 *
 * Integration test runs real ctags against test/fixtures/ctags-sample/
 * (skipped if ctags not installed).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

// ═══════════════════════════════════════════════════════════════════════
// Types (match source at .pi/extensions/codebase-mapper.ts)
// ═══════════════════════════════════════════════════════════════════════

/** Raw ctags JSONL tag object (only fields we care about). */
interface CtagsTag {
	_type: string;
	name: string;
	kind: string;
	path: string;
	pattern: string;
	line?: number;
}

/** Processed symbol entry in output tree. */
interface SymbolEntry {
	type: string;
	name: string;
	line: number;
}

/** Output shape: file path → symbol entries. */
type CodebaseMap = Record<string, SymbolEntry[]>;

// ═══════════════════════════════════════════════════════════════════════
// Pure functions under test (match source exactly)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse raw ctags JSONL output into CtagsTag[].
 *
 * ctags --output-format=json emits one JSON object per line.
 * Lines with _type: "ptag" are metadata pseudo-tags — skip them.
 * Lines that are empty, malformed, or missing required fields are skipped.
 */
function parseCtagsOutput(raw: string): CtagsTag[] {
	if (!raw || typeof raw !== "string") return [];

	const lines = raw.split("\n");
	const tags: CtagsTag[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // skip malformed lines
		}

		if (typeof parsed !== "object" || parsed === null) continue;

		const tag = parsed as Record<string, unknown>;

		// Skip pseudo-tags (metadata)
		if (tag._type === "ptag") continue;

		// Must have _type: "tag" and required fields
		if (tag._type !== "tag") continue;
		if (typeof tag.name !== "string" || !tag.name) continue;
		if (typeof tag.kind !== "string" || !tag.kind) continue;
		if (typeof tag.path !== "string" || !tag.path) continue;

		tags.push({
			_type: "tag",
			name: tag.name,
			kind: tag.kind,
			path: tag.path,
			pattern: typeof tag.pattern === "string" ? tag.pattern : "",
			line: typeof tag.line === "number" ? tag.line : undefined,
		});
	}

	return tags;
}

/**
 * Group parsed tags by file path.
 * Returns Record<filePath, SymbolEntry[]>.
 */
function groupByFile(tags: CtagsTag[]): CodebaseMap {
	const map: CodebaseMap = {};

	for (const tag of tags) {
		const filePath = tag.path;
		if (!map[filePath]) {
			map[filePath] = [];
		}
		map[filePath]!.push({
			type: tag.kind,
			name: tag.name,
			line: tag.line ?? 0,
		});
	}

	// Sort entries by line number within each file
	for (const filePath of Object.keys(map)) {
		map[filePath]!.sort((a, b) => a.line - b.line);
	}

	return map;
}

/**
 * Primary entry: parse raw ctags stdout → grouped tree.
 */
function buildCodebaseMap(raw: string): CodebaseMap {
	const tags = parseCtagsOutput(raw);
	return groupByFile(tags);
}

// ═══════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════

/** Sample ctags JSONL output simulating a small Python/JS project. */
const SAMPLE_CTAGS_OUTPUT = [
	// Regular tags
	JSON.stringify({
		_type: "tag",
		name: "login_handler",
		kind: "function",
		path: "api/routes.py",
		pattern: "/^def login_handler():$/",
		line: 12,
	}),
	JSON.stringify({
		_type: "tag",
		name: "logout_handler",
		kind: "function",
		path: "api/routes.py",
		pattern: "/^def logout_handler():$/",
		line: 45,
	}),
	JSON.stringify({
		_type: "tag",
		name: "UserModel",
		kind: "class",
		path: "models/user.py",
		pattern: "/^class UserModel:$/",
		line: 1,
	}),
	JSON.stringify({
		_type: "tag",
		name: "get_user",
		kind: "function",
		path: "models/user.py",
		pattern: "/^  def get_user():$/",
		line: 10,
	}),
	JSON.stringify({
		_type: "tag",
		name: "App",
		kind: "class",
		path: "src/app.ts",
		pattern: "/^class App {$/",
		line: 1,
	}),
	JSON.stringify({
		_type: "tag",
		name: "start",
		kind: "method",
		path: "src/app.ts",
		pattern: "/^  start(): void {$/",
		line: 5,
	}),
	// Pseudo-tag (metadata, should be filtered)
	JSON.stringify({
		_type: "ptag",
		name: "JSON_OUTPUT_VERSION",
		kind: "pseudo",
		path: "",
		pattern: "1.0",
		line: 0,
	}),
].join("\n");

/** Empty output. */
const EMPTY_OUTPUT = "";

/** Output with only pseudo-tags. */
const PSEUDO_ONLY_OUTPUT = JSON.stringify({
	_type: "ptag",
	name: "TAG_KIND_DESCRIPTION",
	kind: "pseudo",
	path: "",
	pattern: "",
	line: 0,
});

/** Malformed JSON line. */
const MALFORMED_OUTPUT = `not valid json\n{"_type": "tag", "name": "valid", "kind": "function", "path": "a.js", "line": 1}`;

/** Tag with missing required fields. */
const MISSING_FIELDS_OUTPUT = JSON.stringify({
	_type: "tag",
	name: "orphan",
	// missing kind
	path: "a.js",
	line: 1,
});

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

describe("parseCtagsOutput", () => {
	it("parses valid JSONL output", () => {
		const result = parseCtagsOutput(SAMPLE_CTAGS_OUTPUT);
		assert.strictEqual(result.length, 6);
		assert.strictEqual(result[0]!.name, "login_handler");
		assert.strictEqual(result[0]!.kind, "function");
		assert.strictEqual(result[0]!.path, "api/routes.py");
		assert.strictEqual(result[0]!.line, 12);
	});

	it("filters out pseudo-tags (_type: ptag)", () => {
		const result = parseCtagsOutput(PSEUDO_ONLY_OUTPUT);
		assert.strictEqual(result.length, 0);
	});

	it("filters pseudo-tags from mixed output", () => {
		const result = parseCtagsOutput(SAMPLE_CTAGS_OUTPUT);
		const ptagFound = result.some((t) => t._type === "ptag");
		assert.strictEqual(ptagFound, false);
	});

	it("returns empty array for empty string", () => {
		assert.strictEqual(parseCtagsOutput("").length, 0);
	});

	it("returns empty array for null/undefined", () => {
		assert.strictEqual(parseCtagsOutput(null as unknown as string).length, 0);
		assert.strictEqual(parseCtagsOutput(undefined as unknown as string).length, 0);
	});

	it("skips malformed JSON lines", () => {
		const result = parseCtagsOutput(MALFORMED_OUTPUT);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.name, "valid");
	});

	it("skips tags with missing required fields", () => {
		const result = parseCtagsOutput(MISSING_FIELDS_OUTPUT);
		assert.strictEqual(result.length, 0);
	});

	it("handles tags without line number", () => {
		const raw = JSON.stringify({
			_type: "tag",
			name: "const_var",
			kind: "variable",
			path: "src/config.js",
			pattern: "/^const API_URL = '...';$/",
			// no line field
		});
		const result = parseCtagsOutput(raw);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0]!.line, undefined);
	});
});

describe("groupByFile", () => {
	it("groups tags by file path", () => {
		const tags = parseCtagsOutput(SAMPLE_CTAGS_OUTPUT);
		const grouped = groupByFile(tags);

		const files = Object.keys(grouped).sort();
		assert.deepStrictEqual(files, ["api/routes.py", "models/user.py", "src/app.ts"]);

		assert.strictEqual(grouped["api/routes.py"]!.length, 2);
		assert.strictEqual(grouped["models/user.py"]!.length, 2);
		assert.strictEqual(grouped["src/app.ts"]!.length, 2);
	});

	it("sorts entries by line number within each file", () => {
		const tags = parseCtagsOutput(SAMPLE_CTAGS_OUTPUT);
		const grouped = groupByFile(tags);

		const routes = grouped["api/routes.py"]!;
		assert.strictEqual(routes[0]!.line, 12);
		assert.strictEqual(routes[1]!.line, 45);

		const app = grouped["src/app.ts"]!;
		assert.strictEqual(app[0]!.line, 1);
		assert.strictEqual(app[1]!.line, 5);
	});

	it("returns empty object for empty tags array", () => {
		assert.deepStrictEqual(groupByFile([]), {});
	});

	it("includes symbol type and name in entries", () => {
		const tags = parseCtagsOutput(SAMPLE_CTAGS_OUTPUT);
		const grouped = groupByFile(tags);

		const route = grouped["api/routes.py"]![0]!;
		assert.strictEqual(route.type, "function");
		assert.strictEqual(route.name, "login_handler");
	});
});

describe("buildCodebaseMap", () => {
	it("end-to-end: raw output → grouped map", () => {
		const map = buildCodebaseMap(SAMPLE_CTAGS_OUTPUT);

		assert.ok(map["api/routes.py"]);
		assert.ok(map["models/user.py"]);
		assert.ok(map["src/app.ts"]);

		// No pseudo-tags leaked
		const allSymbols = Object.values(map).flat();
		const pseudoSymbols = allSymbols.filter((s) => s.type === "pseudo");
		assert.strictEqual(pseudoSymbols.length, 0);
	});

	it("empty output → empty map", () => {
		assert.deepStrictEqual(buildCodebaseMap(""), {});
	});

	it("matches expected snapshot structure", () => {
		const map = buildCodebaseMap(SAMPLE_CTAGS_OUTPUT);

		const expected: CodebaseMap = {
			"api/routes.py": [
				{ type: "function", name: "login_handler", line: 12 },
				{ type: "function", name: "logout_handler", line: 45 },
			],
			"models/user.py": [
				{ type: "class", name: "UserModel", line: 1 },
				{ type: "function", name: "get_user", line: 10 },
			],
			"src/app.ts": [
				{ type: "class", name: "App", line: 1 },
				{ type: "method", name: "start", line: 5 },
			],
		};

		assert.deepStrictEqual(map, expected);
	});
});

// ═══════════════════════════════════════════════════════════════════════
// Integration test (requires ctags installed)
// ═══════════════════════════════════════════════════════════════════════

describe("integration: ctags binary", () => {
	const hasCtags = (() => {
		try {
			execSync("ctags --version", { encoding: "utf-8", stdio: "pipe" });
			return true;
		} catch {
			return false;
		}
	})();

	const hasJsonFormat = (() => {
		if (!hasCtags) return false;
		try {
			// Probe: run ctags on a tiny inline temp file, check JSON output
			const tmpFile = resolve("/tmp/__ctags_json_probe.ts");
			writeFileSync(tmpFile, "const x = 1;\n", "utf-8");
			const out = execSync(`ctags --output-format=json "${tmpFile}"`, {
				encoding: "utf-8",
				stdio: "pipe",
				timeout: 5_000,
			});
			const parsed = JSON.parse(out.trim());
			return parsed._type === "tag" || parsed._type === "ptag";
		} catch {
			return false;
		} finally {
			try {
				execSync(`rm -f /tmp/__ctags_json_probe.ts`, { stdio: "ignore" });
			} catch {
				/* ignore */
			}
		}
	})();

	const skipMsg = hasCtags
		? "ctags lacks JSON output format"
		: "ctags not installed — skip integration test";

	it(
		"runs ctags on a sample directory and returns parseable JSONL",
		{ skip: !hasCtags || !hasJsonFormat ? skipMsg : false },
		() => {
			const sampleDir = resolve("test/fixtures/ctags-sample");
			if (!existsSync(sampleDir)) {
				// Create minimal sample dir if missing
				throw new Error(
					"test/fixtures/ctags-sample/ not found. Create it with .py/.ts files containing known symbols.",
				);
			}

			const stdout = execSync(
				"ctags -R --output-format=json --maxdepth=3 --exclude=node_modules --exclude=.git .",
				{
					cwd: sampleDir,
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 10_000,
				},
			);

			assert.ok(stdout.length > 0, "ctags should produce output");
			const map = buildCodebaseMap(stdout);

			// Should find at least some symbols
			const totalSymbols = Object.values(map).flat().length;
			assert.ok(totalSymbols > 0, `Expected at least 1 symbol, got ${totalSymbols}`);

			// Each entry should have required fields
			for (const [file, symbols] of Object.entries(map)) {
				assert.ok(typeof file === "string" && file.length > 0);
				for (const sym of symbols) {
					assert.ok(typeof sym.type === "string");
					assert.ok(typeof sym.name === "string");
					assert.ok(typeof sym.line === "number");
				}
			}
		},
	);
});
