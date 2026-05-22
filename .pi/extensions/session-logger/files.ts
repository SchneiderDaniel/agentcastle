import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Metadata } from "./types.js";

export interface FileOps {
	ensureSymlink(sessionFile: string, sessionsDir: string): Promise<void>;
	ensureMdSymlink(sessionDir: string, mdFile: string): Promise<void>;
	ensureLatestMetadataSymlink(sessionDir: string, metaFile: string): Promise<void>;
	writeMetadata(sessionDir: string, sessionId: string, metadata: Metadata): Promise<void>;
	writeSessionReport(sessionDir: string, sessionId: string, markdown: string): Promise<void>;
}

/** Create a symlink at `linkDir/linkName` pointing to `targetFile`. */
async function ensureLatestLink(
	linkDir: string,
	targetFile: string,
	linkName: string,
): Promise<void> {
	const latestLink = path.join(linkDir, linkName);
	const linkTarget = path.relative(linkDir, targetFile);
	try {
		await fs.unlink(latestLink);
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[session-logger] Failed to remove ${linkName}: ${(err as Error).message}`);
		}
	}
	try {
		await fs.symlink(linkTarget, latestLink);
	} catch (err: unknown) {
		console.error(`[session-logger] Failed to create ${linkName}: ${(err as Error).message}`);
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

		async writeMetadata(sessionDir: string, sessionId: string, metadata: Metadata): Promise<void> {
			await fs.writeFile(
				path.join(sessionDir, `${sessionId}.metadata.json`),
				JSON.stringify(metadata, null, 2),
			);
		},

		async writeSessionReport(
			sessionDir: string,
			sessionId: string,
			markdown: string,
		): Promise<void> {
			const mdPath = path.join(sessionDir, `${sessionId}.md`);
			await fs.writeFile(mdPath, markdown, "utf-8");
		},
	};
}
