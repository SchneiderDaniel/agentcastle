import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Metadata } from "./types.js";

export interface FileOps {
	ensureSymlink(sessionFile: string, sessionsDir: string): Promise<void>;
	ensureMdSymlink(sessionDir: string, mdFile: string): Promise<void>;
	writeMetadata(sessionDir: string, metadata: Metadata): Promise<void>;
	writeSessionReport(sessionDir: string, markdown: string): Promise<void>;
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

		async ensureMdSymlink(sessionDir: string, mdFile: string): Promise<void> {
			const latestLink = path.join(sessionDir, "latest.md");
			try {
				await fs.unlink(latestLink);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
					console.error(`[session-logger] Failed to remove md symlink: ${(err as Error).message}`);
				}
			}
			try {
				await fs.symlink(mdFile, latestLink);
			} catch (err: unknown) {
				console.error(`[session-logger] Failed to create md symlink: ${(err as Error).message}`);
			}
		},

		async writeMetadata(sessionDir: string, metadata: Metadata): Promise<void> {
			await fs.writeFile(path.join(sessionDir, "metadata.json"), JSON.stringify(metadata, null, 2));
		},

		async writeSessionReport(sessionDir: string, markdown: string): Promise<void> {
			const mdName = path.basename(sessionDir) + ".md";
			const mdPath = path.join(sessionDir, mdName);
			await fs.writeFile(mdPath, markdown, "utf-8");
			// Update latest.md symlink
			await this.ensureMdSymlink(path.dirname(sessionDir), mdPath);
		},
	};
}
