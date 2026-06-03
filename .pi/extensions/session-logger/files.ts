import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Metadata } from "./types.js";

// ---------------------------------------------------------------------------
// waitForFile — poll for a file to appear on disk
// ---------------------------------------------------------------------------

export interface WaitForFileOptions {
	/** Maximum time to wait in ms (default 5000) */
	timeout?: number;
	/** Poll interval in ms (default 50) */
	interval?: number;
	/** Optional AbortSignal for cancellation */
	signal?: AbortSignal;
}

/**
 * Poll for a file to exist on disk. Resolves immediately if the file already
 * exists. Rejects if the parent directory doesn't exist, the path is empty,
 * or the file doesn't appear within the timeout.
 *
 * Error messages for timeouts / missing parents / empty path all match the
 * regex `/waitForFile.*not found/i` so callers can catch them uniformly.
 */
export async function waitForFile(filePath: string, options?: WaitForFileOptions): Promise<void> {
	const timeout = options?.timeout ?? 5000;
	const interval = options?.interval ?? 50;

	if (!filePath) {
		throw new Error(`waitForFile: target not found after retries: ${filePath}`);
	}

	// Validate that the parent directory exists — gives a clear error instead
	// of a raw ENOENT from fs.symlink later.
	const dir = path.dirname(filePath);
	try {
		await fs.stat(dir);
	} catch {
		throw new Error(`waitForFile: target not found after retries: ${filePath}`);
	}

	const start = Date.now();
	const signal = options?.signal;

	while (Date.now() - start < timeout) {
		try {
			await fs.stat(filePath);
			return; // file exists
		} catch {
			// file doesn't exist yet — continue polling
		}

		// Wait for the interval, respecting abort signal
		await new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("Aborted", "AbortError"));
				return;
			}
			const timer = setTimeout(resolve, interval);
			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new DOMException("Aborted", "AbortError"));
					},
					{ once: true },
				);
			}
		});
	}

	// Timeout — file never appeared
	throw new Error(`waitForFile: target not found after retries: ${filePath}`);
}

// ---------------------------------------------------------------------------
// FileOps interface
// ---------------------------------------------------------------------------

export interface FileOps {
	ensureSymlink(sessionFile: string, sessionsDir: string): Promise<void>;
	ensureMdSymlink(sessionDir: string, mdFile: string): Promise<void>;
	ensureLatestMetadataSymlink(sessionDir: string, metaFile: string): Promise<void>;
	/** Write metadata using sessionPrefix as filename prefix (same as JSONL basename). */
	writeMetadata(sessionDir: string, sessionPrefix: string, metadata: Metadata): Promise<void>;
	/** Write markdown report using sessionPrefix as filename prefix. */
	writeSessionReport(sessionDir: string, sessionPrefix: string, markdown: string): Promise<void>;
}

/**
 * Create a symlink at `linkDir/linkName` pointing to `targetFile`.
 *
 * Uses a unique temp name (with random suffix) to avoid EEXIST races
 * between concurrent writers. Cleans up stale temp files before creating
 * the symlink, then atomically renames tmp → target.
 *
 * If rename fails with ENOENT another concurrent writer won the race —
 * the target link already points to a valid symlink, so we skip.
 */
async function ensureLatestLink(
	linkDir: string,
	targetFile: string,
	linkName: string,
): Promise<void> {
	// Wait for the target file to exist before creating a symlink — prevents
	// dangling symlinks when the file hasn't been written yet (race between
	// session_start handler and the subprocess writing the JSONL).
	await waitForFile(targetFile);

	const latestLink = path.join(linkDir, linkName);
	const linkTarget = path.relative(linkDir, targetFile);
	const rand = crypto.randomBytes(4).toString("hex");
	const tmpLink = `${latestLink}.tmp.${rand}`;

	// Create symlink at unique temp path — no collision possible.
	await fs.symlink(linkTarget, tmpLink);

	// Atomic rename — replaces existing symlink atomically on same filesystem.
	// If ENOENT, another concurrent writer already renamed (they won the race).
	try {
		await fs.rename(tmpLink, latestLink);
	} catch (err: unknown) {
		const nodeErr = err as NodeJS.ErrnoException;
		if (nodeErr.code === "ENOENT") {
			// Another writer won the race — clean up our tmp and move on.
			try {
				await fs.unlink(tmpLink);
			} catch {
				// Ignore cleanup failures.
			}
		} else {
			throw err;
		}
	}
}

export function createFileOps(): FileOps {
	return {
		async ensureSymlink(sessionFile: string, sessionsDir: string): Promise<void> {
			await ensureLatestLink(sessionsDir, sessionFile, "latest.jsonl");
		},

		async ensureMdSymlink(sessionDir: string, mdFile: string): Promise<void> {
			await ensureLatestLink(sessionDir, mdFile, "latest.md");
		},

		async ensureLatestMetadataSymlink(sessionDir: string, metaFile: string): Promise<void> {
			await ensureLatestLink(sessionDir, metaFile, "latest.metadata.json");
		},

		async writeMetadata(
			sessionDir: string,
			sessionPrefix: string,
			metadata: Metadata,
		): Promise<void> {
			await fs.writeFile(
				path.join(sessionDir, `${sessionPrefix}.metadata.json`),
				JSON.stringify(metadata, null, 2),
			);
		},

		async writeSessionReport(
			sessionDir: string,
			sessionPrefix: string,
			markdown: string,
		): Promise<void> {
			const mdPath = path.join(sessionDir, `${sessionPrefix}.md`);
			await fs.writeFile(mdPath, markdown, "utf-8");
		},
	};
}
