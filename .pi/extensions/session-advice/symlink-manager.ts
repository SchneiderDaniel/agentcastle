/**
 * symlink-manager.ts — Atomic symlink management for .advice.md files
 *
 * Manages the latest.advice.md symlink that points to the most recent
 * session's advice file. Uses tmp + rename pattern for atomicity.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export class SymlinkManager {
	/**
	 * Atomically update latest.advice.md symlink.
	 * Uses tmp + rename pattern to avoid TOCTOU races.
	 * Retries symlink once on EEXIST (concurrent writer).
	 */
	updateLatestAdviceSymlink(symlinkDir: string, targetFile: string): void {
		const latestPath = path.join(symlinkDir, "latest.advice.md");
		const linkTarget = path.relative(symlinkDir, targetFile);
		const tmpPath = latestPath + ".tmp";

		// Clean stale tmp
		try {
			fs.unlinkSync(tmpPath);
		} catch {
			/* ok */
		}

		// Create symlink at temp path (retry once on EEXIST)
		try {
			fs.symlinkSync(linkTarget, tmpPath);
		} catch {
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				/* ok */
			}
			try {
				fs.symlinkSync(linkTarget, tmpPath);
			} catch {
				return; // give up
			}
		}

		// Atomic rename
		try {
			fs.renameSync(tmpPath, latestPath);
		} catch {
			/* concurrent writer won the race — our symlink is fine */
		}
	}
}
