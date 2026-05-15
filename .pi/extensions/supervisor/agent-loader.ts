// ─── Agent Loader ──────────────────────────────────────────────────
// Parse .pi/agents/*.md files (YAML frontmatter + system prompt body).

import type { ParsedAgent, AgentFrontmatter } from "./types";
import { readFileSync } from "node:fs";

export function parseAgentFile(filePath: string): ParsedAgent {
	const content = readFileSync(filePath, "utf-8");
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		throw new Error(`Agent file ${filePath} missing YAML frontmatter`);
	}
	const config: AgentFrontmatter = { name: "" };
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
		if (kv) {
			let val = kv[2]!.trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			config[kv[1]!] = val;
		}
	}
	if (!config.name) throw new Error(`Agent file ${filePath} missing 'name'`);
	return { config, systemPrompt: match[2]!.trim() };
}
