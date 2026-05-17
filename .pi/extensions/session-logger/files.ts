import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Metadata } from "./types.js";

export interface FileOps {
	ensureSymlink(sessionFile: string, sessionsDir: string): Promise<void>;
	writeMetadata(sessionDir: string, metadata: Metadata): Promise<void>;
}

export function createFileOps(): FileOps {
	return {
		async ensureSymlink(sessionFile: string, sessionsDir: string): Promise<void> {
			const latestLink = path.join(sessionsDir, "latest.jsonl");
			try {
				await fs.unlink(latestLink);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					console.error(`[session-logger] Failed to remove symlink: ${(err as Error).message}`);
				}
			}
			try {
				await fs.symlink(sessionFile, latestLink);
			} catch (err: unknown) {
				console.error(`[session-logger] Failed to create symlink: ${(err as Error).message}`);
			}
		},

		async writeMetadata(sessionDir: string, metadata: Metadata): Promise<void> {
			await fs.writeFile(path.join(sessionDir, "metadata.json"), JSON.stringify(metadata, null, 2));
		},
	};
}
