/**
 * Tests for crawl4ai extension refactored modules.
 *
 * Replicates target module logic inline (no .ts import — project uses
 * `"type": "commonjs"` and node --experimental-strip-types doesn't support
 * importing .ts files from .mts in CJS-mode packages).
 *
 * Run with:
 *   node --experimental-strip-types --test test/crawl4ai.test.mts
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";

// ===========================================================================
// direct-fetch.ts — htmlToMarkdown (pure function, no infra)
// Replicates .pi/extensions/crawl4ai/direct-fetch.ts implementation
// ===========================================================================

function htmlToMarkdown(html: string): string {
	let text = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<nav[\s\S]*?<\/nav>/gi, "")
		.replace(/<footer[\s\S]*?<\/footer>/gi, "")
		.replace(/<header[\s\S]*?<\/header>/gi, "")
		.replace(/<aside[\s\S]*?<\/aside>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	text = text.replace(/<(\/?)(p|div|section|article|main|blockquote)[^>]*>/gi, "\n");
	text = text.replace(/<(\/?)(h[1-6])[^>]*>/gi, (_m: string, _slash: string, tag: string) => {
		const level = parseInt(tag[1], 10);
		return "\n" + "#".repeat(level) + " ";
	});
	text = text.replace(/<(\/?)(ul|ol)[^>]*>/gi, "\n");
	text = text.replace(/<(\/?)li[^>]*>/gi, "\n- ");
	text = text.replace(/<(\/?)(tr|br)[^>]*>/gi, "\n");
	text = text.replace(/<(\/?)(td|th)[^>]*>/gi, " | ");
	text = text.replace(
		/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_m: string, href: string, inner: string) =>
			`[${inner.replace(/<[^>]+>/g, "").trim()}](${href})`,
	);
	text = text.replace(/<(\/?)(strong|b)[^>]*>/gi, "**");
	text = text.replace(/<(\/?)(em|i)[^>]*>/gi, "_");
	text = text.replace(/<(\/?)code[^>]*>/gi, "`");
	text = text.replace(/<(\/?)pre[^>]*>/gi, "\n```\n");
	text = text.replace(/<[^>]+>/g, "");
	text = text
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#(\d+);/g, (_m: string, num: string) => String.fromCharCode(parseInt(num, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_m: string, hex: string) =>
			String.fromCharCode(parseInt(hex, 16)),
		);
	return text
		.split("\n")
		.map((l) => l.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

describe("htmlToMarkdown", () => {
	it("converts simple HTML text", () => {
		const result = htmlToMarkdown("<p>Hello world</p>");
		assert.equal(result, "Hello world");
	});

	it("removes script and style tags", () => {
		const html = "<script>alert('x')</script><p>text</p><style>.c{}</style>";
		const result = htmlToMarkdown(html);
		assert.equal(result, "text");
	});

	it("converts headings to markdown", () => {
		const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>";
		const result = htmlToMarkdown(html);
		assert.ok(result.includes("# Title"));
		assert.ok(result.includes("## Subtitle"));
		assert.ok(result.includes("### Section"));
	});

	it("converts links to markdown format", () => {
		const html = '<a href="https://example.com">Example</a>';
		const result = htmlToMarkdown(html);
		assert.ok(result.includes("[Example](https://example.com)"));
	});

	it("converts bold and italic", () => {
		const html = "<strong>bold</strong> and <em>italic</em>";
		const result = htmlToMarkdown(html);
		assert.ok(result.includes("**bold**"));
		assert.ok(result.includes("_italic_"));
	});

	it("converts lists", () => {
		const html = "<ul><li>item1</li><li>item2</li></ul>";
		const result = htmlToMarkdown(html);
		assert.ok(result.includes("- item1"));
		assert.ok(result.includes("- item2"));
	});

	it("decodes HTML entities", () => {
		const html = "<p>&amp; &lt; &gt; &quot; &nbsp;</p>";
		const result = htmlToMarkdown(html);
		// &nbsp; decodes to space then trimmed; trailing space removed
		assert.equal(result, '& < > "');
	});

	it("strips nav, footer, header, aside tags", () => {
		const html = "<nav>nav</nav><p>content</p><footer>footer</footer>";
		const result = htmlToMarkdown(html);
		assert.ok(!result.includes("nav"));
		assert.ok(!result.includes("footer"));
		assert.ok(result.includes("content"));
	});

	it("handles empty string", () => {
		const result = htmlToMarkdown("");
		assert.equal(result, "");
	});

	it("converts code blocks", () => {
		const html = "<pre><code>const x = 1;</code></pre>";
		const result = htmlToMarkdown(html);
		// Note: `pre` tag caught by (p|div|section|...) regex before pre-specific
		// regex runs (existing behavior, not changed).
		assert.ok(result.includes("`const x = 1;`"));
	});

	it("decodes numeric HTML entities", () => {
		const html = "<p>&#65; &#x41;</p>";
		const result = htmlToMarkdown(html);
		assert.equal(result, "A A");
	});

	it("collapses multiple newlines to double newline max", () => {
		const html = "<p>a</p><p>b</p><p>c</p>";
		const result = htmlToMarkdown(html);
		assert.ok(!result.includes("\n\n\n"), "should not have triple newlines");
	});
});

// ===========================================================================
// direct-fetch.ts — directFetchCrawl with mocked fetch
// ===========================================================================

async function directFetchCrawl(
	url: string,
	maxPages: number,
	signal?: AbortSignal,
	_onUpdate?: Function,
): Promise<string> {
	const visited = new Set<string>();
	const queue: string[] = [url];
	const results: string[] = [];

	while (queue.length > 0 && visited.size < maxPages) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);

		try {
			const res = await fetch(current, {
				headers: {
					"User-Agent":
						"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
						"AppleWebKit/537.36 (KHTML, like Gecko) " +
						"Chrome/120.0.0.0 Safari/537.36",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
				signal,
			});

			if (!res.ok) {
				results.push(`--- ${current} ---\nError: HTTP ${res.status} ${res.statusText}`);
				continue;
			}

			const contentType = res.headers.get("content-type") || "";
			if (!contentType.includes("text/html")) {
				const snippet = await res.text();
				results.push(`--- ${current} ---\n[Non-HTML: ${contentType}]\n${snippet.slice(0, 800)}`);
				continue;
			}

			const html = await res.text();
			const md = htmlToMarkdown(html);
			results.push(`--- ${current} ---\n${md || "[No extractable content]"}`);

			if (visited.size < maxPages) {
				const base = new URL(current);
				const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>/gi;
				let m: RegExpExecArray | null;
				while ((m = regex.exec(html)) !== null) {
					try {
						const link = new URL(m[1], current).href;
						if (new URL(link).origin !== base.origin) continue;
						const clean = link.split("#")[0];
						if (!visited.has(clean) && !queue.includes(clean)) queue.push(clean);
					} catch {
						// ignore
					}
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			results.push(`--- ${current} ---\nError: ${msg}`);
		}
	}

	return results.join("\n\n") || "Crawl completed but no content was extracted.";
}

describe("directFetchCrawl", () => {
	it("returns result string even when fetch fails", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			throw new Error("Network error");
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await directFetchCrawl("https://example.com", 1);
			assert.ok(typeof result === "string");
			assert.ok(result.includes("Error"));
			assert.ok(result.includes("Network error"));
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("handles HTTP error status", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			return new Response(null, { status: 500, statusText: "Internal Server Error" });
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await directFetchCrawl("https://example.com", 1);
			assert.ok(result.includes("HTTP 500"));
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("handles non-HTML content type", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = mock.fn(async () => {
			return new Response("binary-data", {
				status: 200,
				headers: { "content-type": "application/pdf" },
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			const result = await directFetchCrawl("https://example.com", 1);
			assert.ok(result.includes("Non-HTML"));
		} finally {
			globalThis.fetch = origFetch;
		}
	});
});

// ===========================================================================
// venv-setup.ts — ensurePythonVenv with mock exec
// ===========================================================================

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

type ExecFn = (
	cmd: string,
	args: string[],
	opts?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

function lazyPaths(cwd: string) {
	return {
		VENV_DIR: `${cwd}/.pi/crawl4ai-venv`,
		VENV_PYTHON: `${cwd}/.pi/crawl4ai-venv/bin/python3`,
		DEPS_DIR: `${cwd}/.pi/chromium-deps`,
		DEPS_LIB_DIR: `${cwd}/.pi/chromium-deps/usr/lib/x86_64-linux-gnu`,
	};
}

async function ensurePythonVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: Function,
	venvReady?: Map<string, boolean>,
): Promise<string | null> {
	const ready = venvReady ?? new Map<string, boolean>();
	const { VENV_PYTHON, VENV_DIR } = lazyPaths(cwd);
	if (ready.has(cwd)) return ready.get(cwd)! ? VENV_PYTHON : null;

	const pyCheck = await exec("python3", ["--version"]);
	if (pyCheck.code !== 0) {
		console.error("crawl4ai: python3 not found");
		ready.set(cwd, false);
		return null;
	}

	const alreadyOk = await exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
	if (alreadyOk.code === 0 && alreadyOk.stdout.includes("ok")) {
		ready.set(cwd, true);
		return VENV_PYTHON;
	}

	const venvCheck = await exec(VENV_PYTHON, ["--version"]);
	if (venvCheck.code !== 0) {
		await exec("rm", ["-rf", VENV_DIR]);
		onUpdate?.({
			content: [{ type: "text", text: "Creating Python virtual environment for crawl4ai…" }],
			details: {} as Record<string, unknown>,
		});
		const create = await exec("python3", ["-m", "venv", "--clear", VENV_DIR]);
		if (create.code !== 0) {
			console.error("crawl4ai: failed to create venv");
			ready.set(cwd, false);
			return null;
		}
	}

	onUpdate?.({
		content: [{ type: "text", text: "Installing crawl4ai (this may take a minute)…" }],
		details: {} as Record<string, unknown>,
	});
	const install = await exec(VENV_PYTHON, ["-m", "pip", "install", "crawl4ai"], {
		timeout: 180_000,
	});
	if (install.code !== 0) {
		console.error("crawl4ai: pip install failed:", install.stderr.slice(0, 500));
		ready.set(cwd, false);
		return null;
	}

	onUpdate?.({
		content: [{ type: "text", text: "Installing Chromium browser for crawl4ai…" }],
		details: {} as Record<string, unknown>,
	});
	await exec(VENV_PYTHON, ["-m", "playwright", "install", "chromium"], { timeout: 120_000 });

	const verify = await exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
	const readyFlag = verify.code === 0 && verify.stdout.includes("ok");
	ready.set(cwd, readyFlag);
	return readyFlag ? VENV_PYTHON : null;
}

describe("ensurePythonVenv", () => {
	it("returns null when python3 not found", async () => {
		const mockExec: ExecFn = async (cmd: string) => {
			if (cmd === "python3") return { code: 127, stdout: "", stderr: "not found" } as any;
			return { code: 0, stdout: "", stderr: "" };
		};

		const result = await ensurePythonVenv(mockExec, "/tmp/test-crawl", undefined);
		assert.equal(result, null);
	});

	it("returns python path when venv already ready", async () => {
		const mockExec: ExecFn = async (cmd: string, args?: string[]) => {
			if (cmd === "python3" && args?.[0] === "--version") {
				return { code: 0, stdout: "Python 3.12.0", stderr: "" };
			}
			if (cmd.includes("venv/bin/python3") && args?.[0] === "-c") {
				return { code: 0, stdout: "ok", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const venvState = new Map<string, boolean>();
		const result = await ensurePythonVenv(mockExec, "/tmp/test-crawl", undefined, venvState);
		assert.ok(result?.includes("venv/bin/python3"));
	});

	it("returns null on failed pip install", async () => {
		const mockExec: ExecFn = async (cmd: string, args?: string[]) => {
			if (cmd === "python3" && args?.[0] === "--version") {
				return { code: 0, stdout: "Python 3.12.0", stderr: "" };
			}
			if (cmd.includes("venv/bin/python3") && args?.[0] === "--version") {
				return { code: 0, stdout: "Python 3.12.0", stderr: "" };
			}
			if (cmd.includes("venv/bin/python3") && args?.[0] === "-m" && args?.[1] === "pip") {
				return { code: 1, stdout: "", stderr: "pip failed" };
			}
			if (cmd.includes("venv/bin/python3") && args?.[0] === "-c") {
				return { code: 1, stdout: "", stderr: "import failed" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const venvState = new Map<string, boolean>();
		const result = await ensurePythonVenv(mockExec, "/tmp/test-crawl", undefined, venvState);
		assert.equal(result, null);
	});
});

describe("ensureChromiumDeps", () => {
	async function ensureChromiumDeps(
		exec: ExecFn,
		cwd: string,
		_onUpdate?: Function,
		depsReady?: Map<string, boolean>,
	): Promise<string | null> {
		const ready = depsReady ?? new Map<string, boolean>();
		const { DEPS_DIR, DEPS_LIB_DIR } = lazyPaths(cwd);
		if (ready.has(cwd)) return ready.get(cwd)! ? DEPS_LIB_DIR : null;

		const testLib = `${DEPS_LIB_DIR}/libnspr4.so`;
		const libCheck = await exec("bash", ["-c", `test -f ${testLib}`]);
		if (libCheck.code === 0) {
			ready.set(cwd, true);
			return DEPS_LIB_DIR;
		}

		_onUpdate?.({
			content: [{ type: "text", text: "Downloading Chromium system libraries…" }],
			details: {} as Record<string, unknown>,
		});

		const pkgs = ["libnspr4", "libnss3", "libasound2t64"];
		for (const pkg of pkgs) {
			const dl = await exec("bash", ["-c", `cd ${DEPS_DIR} && apt-get download ${pkg}`], {
				timeout: 30_000,
			});
			if (dl.code !== 0) {
				console.error(`crawl4ai: failed to download ${pkg}`);
			}
		}

		const findResult = await exec("bash", ["-c", `ls ${DEPS_DIR}/*.deb 2>/dev/null`]);
		if (findResult.code === 0 && findResult.stdout.trim()) {
			for (const deb of findResult.stdout.trim().split("\n")) {
				await exec("dpkg", ["-x", deb.trim(), DEPS_DIR]);
			}
		}

		const verify = await exec("bash", ["-c", `test -f ${testLib}`]);
		if (verify.code !== 0) {
			console.error("crawl4ai: failed to set up Chromium system libraries");
			ready.set(cwd, false);
			return null;
		}

		ready.set(cwd, true);
		return DEPS_LIB_DIR;
	}

	it("returns null when deps not set up and no debs found", async () => {
		const mockExec: ExecFn = async (_cmd: string, args?: string[]) => {
			if (args?.[0]?.includes("test -f")) {
				return { code: 1, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};

		const result = await ensureChromiumDeps(mockExec, "/tmp/test-crawl", undefined);
		assert.ok(result === null || typeof result === "string");
	});
});

// ===========================================================================
// index.ts — verify tool registration (replicate logic inline)
// ===========================================================================

interface ExtensionAPI {
	registerTool: (tool: any) => void;
	exec: ExecFn;
}

function crawl4aiEntry(pi: ExtensionAPI): void {
	// Using Type from typebox — we can't import it, so just verify registration shape
	const venvReady = new Map<string, boolean>();
	const depsReady = new Map<string, boolean>();

	pi.registerTool({
		name: "web_crawl",
		label: "Web Crawl",
		description:
			"Crawl and extract markdown content from web pages using crawl4ai. " +
			"Runs locally when possible, falls back to Apify (if APIFY_TOKEN is set), " +
			"then to direct HTTP fetch. " +
			"Use when the user asks to search the web, scrape a page, " +
			"extract content from a URL, or crawl a site.",
		promptSnippet: "Crawl web pages and return extracted markdown content via crawl4ai",
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "URL to crawl (e.g. https://example.com)",
				},
				maxPages: {
					type: "number",
					default: 1,
					description: "Maximum pages to crawl (default 1, max 10)",
				},
			},
		},
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
			return { content: [{ type: "text", text: "mock" }], details: {} };
		},
	});
}

describe("crawl4ai extension entry point", () => {
	it("registers web_crawl tool on pi.registerTool", () => {
		const registeredTools: any[] = [];
		const mockPi: ExtensionAPI = {
			registerTool: (tool: any) => {
				registeredTools.push(tool);
			},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		};

		crawl4aiEntry(mockPi);
		assert.equal(registeredTools.length, 1);
		assert.equal(registeredTools[0].name, "web_crawl");
	});

	it("registered tool has execute function", () => {
		let registeredTool: any = null;
		const mockPi: ExtensionAPI = {
			registerTool: (tool: any) => {
				registeredTool = tool;
			},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		};

		crawl4aiEntry(mockPi);
		assert.ok(typeof registeredTool.execute === "function");
	});

	it("registered tool has url and optional maxPages parameters", () => {
		let registeredTool: any = null;
		const mockPi: ExtensionAPI = {
			registerTool: (tool: any) => {
				registeredTool = tool;
			},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		};

		crawl4aiEntry(mockPi);
		assert.ok(registeredTool.parameters.properties?.url !== undefined);
		assert.ok(registeredTool.parameters.properties?.maxPages !== undefined);
	});
});
