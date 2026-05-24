import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Metadata } from "./types.ts";

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
 * Uses atomic rename pattern to avoid TOCTOU race: creates the symlink at a
 * temp path on the same filesystem, then renames (atomically) to the target.
 * Observers opening the target path never see ENOENT between updates.
 *
 * Under concurrent access, the tmp path may collide with another writer.
 * We retry the symlink once on EEXIST. If the rename fails with ENOENT it
 * means another concurrent writer already renamed the tmp — the target path
 * already holds a valid symlink, so we can safely skip the update.
 */
async function ensureLatestLink(
	linkDir: string,
	targetFile: string,
	linkName: string,
): Promise<void> {
	const latestLink = path.join(linkDir, linkName);
	const linkTarget = path.relative(linkDir, targetFile);
	const tmpLink = latestLink + ".tmp";

	// Clean up any stale tmp symlink from a previous crash.
	try {
		await fs.unlink(tmpLink);
	} catch {
		// Ignore ENOENT — no stale temp to clean.
	}

	// Create symlink at temp path.
	// If EEXIST, another concurrent writer created tmp between our unlink and
	// symlink. Remove their tmp and retry once.
	try {
		await fs.symlink(linkTarget, tmpLink);
	} catch (err: unknown) {
		const nodeErr = err as NodeJS.ErrnoException;
		if (nodeErr.code === "EEXIST") {
			// Another writer created tmp between our unlink and symlink.
			// Remove their tmp and retry. If tmp is already gone by now
			// (concurrent rename + unlink), just retry the symlink.
			try {
				await fs.unlink(tmpLink);
			} catch {
				// Ignore ENOENT — concurrent writer already moved tmp.
			}
			await fs.symlink(linkTarget, tmpLink);
		} else {
			throw err;
		}
	}

	// Atomic rename — replaces existing symlink atomically on same filesystem.
	// If ENOENT, another concurrent writer already renamed the tmp symlink
	// (they won the race). The target path holds a valid symlink from the
	// winner — we can safely skip the update.
	try {
		await fs.rename(tmpLink, latestLink);
	} catch (err: unknown) {
		const nodeErr = err as NodeJS.ErrnoException;
		if (nodeErr.code !== "ENOENT") {
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
