/**
 * Python virtual environment + Chromium system dependencies management.
 *
 * Adapts system/shell operations — pi.exec injected to keep functions
 * testable with mock exec. State Maps (venvReady, depsReady) passed in
 * to let caller own caching lifecycle.
 */

import type { OnUpdateCallback } from "./types.ts";

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ExecFn {
	(
		cmd: string,
		args: string[],
		opts?: { timeout?: number; signal?: AbortSignal },
	): Promise<ExecResult>;
}

function lazyPaths(cwd: string) {
	return {
		VENV_DIR: `${cwd}/.pi/crawl4ai-venv`,
		VENV_PYTHON: `${cwd}/.pi/crawl4ai-venv/bin/python3`,
		DEPS_DIR: `${cwd}/.pi/chromium-deps`,
		DEPS_LIB_DIR: `${cwd}/.pi/chromium-deps/usr/lib/x86_64-linux-gnu`,
	};
}

/**
 * Ensure Python virtual env with crawl4ai installed exists.
 * Returns path to python3 binary or null if setup fails.
 */
export async function ensurePythonVenv(
	exec: ExecFn,
	cwd: string,
	onUpdate?: OnUpdateCallback,
	venvReady?: Map<string, boolean>,
): Promise<string | null> {
	const ready = venvReady ?? new Map<string, boolean>();
	const { VENV_PYTHON, VENV_DIR } = lazyPaths(cwd);
	if (ready.has(cwd)) return ready.get(cwd)! ? VENV_PYTHON : null;

	// Check system python3 exists
	const pyCheck = await exec("python3", ["--version"]);
	if (pyCheck.code !== 0) {
		console.error("crawl4ai: python3 not found");
		ready.set(cwd, false);
		return null;
	}

	// Check if venv already set up with crawl4ai
	const alreadyOk = await exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
	if (alreadyOk.code === 0 && alreadyOk.stdout.includes("ok")) {
		ready.set(cwd, true);
		return VENV_PYTHON;
	}

	// Create venv if it doesn't exist (or is broken)
	const venvCheck = await exec(VENV_PYTHON, ["--version"]);
	if (venvCheck.code !== 0) {
		// Clean up any broken partial venv first
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

	// Install crawl4ai in venv
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

	// Install playwright browsers (best-effort)
	onUpdate?.({
		content: [{ type: "text", text: "Installing Chromium browser for crawl4ai…" }],
		details: {} as Record<string, unknown>,
	});
	await exec(VENV_PYTHON, ["-m", "playwright", "install", "chromium"], { timeout: 120_000 });

	// Verify
	const verify = await exec(VENV_PYTHON, ["-c", "import crawl4ai; print('ok')"]);
	const readyFlag = verify.code === 0 && verify.stdout.includes("ok");
	ready.set(cwd, readyFlag);
	return readyFlag ? VENV_PYTHON : null;
}

/**
 * Ensure Chromium system dependencies are available.
 * Downloads and extracts .deb packages without sudo.
 * Returns path to lib directory or null if setup fails.
 */
export async function ensureChromiumDeps(
	exec: ExecFn,
	cwd: string,
	onUpdate?: OnUpdateCallback,
	depsReady?: Map<string, boolean>,
): Promise<string | null> {
	const ready = depsReady ?? new Map<string, boolean>();
	const { DEPS_DIR, DEPS_LIB_DIR } = lazyPaths(cwd);
	if (ready.has(cwd)) return ready.get(cwd)! ? DEPS_LIB_DIR : null;

	// Check if deps already extracted and working
	const testLib = `${DEPS_LIB_DIR}/libnspr4.so`;
	const libCheck = await exec("bash", ["-c", `test -f ${testLib}`]);
	if (libCheck.code === 0) {
		ready.set(cwd, true);
		return DEPS_LIB_DIR;
	}

	// Download and extract Chromium system dependencies (without sudo)
	onUpdate?.({
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

	// Extract all debs
	const findResult = await exec("bash", ["-c", `ls ${DEPS_DIR}/*.deb 2>/dev/null`]);
	if (findResult.code === 0 && findResult.stdout.trim()) {
		for (const deb of findResult.stdout.trim().split("\n")) {
			await exec("dpkg", ["-x", deb.trim(), DEPS_DIR]);
		}
	}

	// Verify
	const verify = await exec("bash", ["-c", `test -f ${testLib}`]);
	if (verify.code !== 0) {
		console.error("crawl4ai: failed to set up Chromium system libraries");
		ready.set(cwd, false);
		return null;
	}

	ready.set(cwd, true);
	return DEPS_LIB_DIR;
}
