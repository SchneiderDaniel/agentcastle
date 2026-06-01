/**
 * constants — Domain configuration for check-extensions pipeline
 *
 * Extracted from index.ts to isolate configuration from wiring.
 * All constants used by the pipeline phases live here.
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** Resolve path to pi CHANGELOG.md */
export const PI_CHANGELOG_PATH = join(
	homedir(),
	".npm-global",
	"lib",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"CHANGELOG.md",
);

/** The set of API names we look for in changelog entries */
export const API_PATTERNS = [
	"pi.on",
	"pi.registerCommand",
	"pi.registerTool",
	"pi.exec",
	"pi.sendUserMessage",
	"ctx.ui",
	"ctx.sessionManager",
	"ctx.abort",
	"pi.registerFlag",
	"pi.registerShortcut",
	"pi.getFlag",
	"pi.setActiveTools",
	"pi.sendMessage",
	"pi.appendEntry",
	"pi.setSessionName",
];

/** Known API term aliases for mapping changelog entries to scan patterns */
export const CHANGELOG_API_TO_PATTERN: Record<string, string[]> = {
	on: ["pi.on"],
	registerCommand: ["pi.registerCommand"],
	registerTool: ["pi.registerTool"],
	exec: ["pi.exec"],
	sendUserMessage: ["pi.sendUserMessage"],
	"ctx.ui": ["ctx.ui"],
	sessionManager: ["ctx.sessionManager"],
	abort: ["ctx.abort"],
	registerFlag: ["pi.registerFlag"],
	registerShortcut: ["pi.registerShortcut"],
	getFlag: ["pi.getFlag"],
	setActiveTools: ["pi.setActiveTools"],
	sendMessage: ["pi.sendMessage"],
	appendEntry: ["pi.appendEntry"],
	setSessionName: ["pi.setSessionName"],
	tool: ["pi.registerTool", "pi.on"],
	command: ["pi.registerCommand"],
	event: ["pi.on"],
	extension: ["pi.on", "pi.registerCommand"],
	SDK: ["pi.exec", "pi.sendUserMessage"],
	config: ["pi.registerFlag", "pi.getFlag"],
	export: ["pi.sendUserMessage", "pi.sendMessage"],
};
