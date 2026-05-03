import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

/**
 * Strip shell prefixes (cd, export, VAR=val) to find the actual command.
 *   cd /path && git log   → git log
 *   export FOO=1 && npm test  → npm test
 *   FOO=bar cmd           → cmd
 */
function getBaseCommand(raw: string): string {
	let cmd = raw.trim();

	// Strip leading variable assignments: VAR=val VAR2=val2 cmd ...
	cmd = cmd.replace(/^(?:\w+=\S+\s+)+/, "");

	// Strip cd <dir> && / cd <dir> ; / cd <dir> ||
	cmd = cmd.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*[;&|]{1,2}\s*/, "");

	// Strip export VAR=val && / export VAR=val ;
	cmd = cmd.replace(/^export\s+(?:\w+=\S+\s+)+[;&|]{1,2}\s*/, "");

	return cmd.trim();
}

/** First whitespace-delimited token (the command name/path). */
function firstToken(cmd: string): string {
	return cmd.split(/\s+/)[0] ?? "";
}

/**
 * Commands that download/install external code or execute untrusted input.
 * These run inside the Daytona sandbox. Everything else runs on host.
 */
const SANDBOX_PATTERNS: Array<{
	token: string;
	match: (cmd: string) => boolean;
}> = [
	// Package managers installing
	{ token: "npm", match: (c) => /\bnpm\s+(install|i|add)\b/.test(c) },
	{
		token: "npx",
		match: (c) => /\bnpx\b/.test(c) && !/\bnpx\s+impeccable\b/.test(c),
	},
	{ token: "yarn", match: (c) => /\byarn\s+(add|install)\b/.test(c) },
	{ token: "pnpm", match: (c) => /\bpnpm\s+(add|install)\b/.test(c) },
	{ token: "pip", match: (c) => /\bpip\d*\s+install\b/.test(c) },
	{ token: "pipx", match: (c) => /\bpipx\s+install\b/.test(c) },
	{ token: "gem", match: (c) => /\bgem\s+install\b/.test(c) },
	{ token: "cargo", match: (c) => /\bcargo\s+install\b/.test(c) },
	{ token: "go", match: (c) => /\bgo\s+(get|install)\b/.test(c) },
	{ token: "brew", match: (c) => /\bbrew\s+install\b/.test(c) },

	// curl / wget piping to shell
	{
		token: "curl",
		match: (c) => /\bcurl\b.+\|\s*(?:bash|sh|dash|zsh)\b/.test(c),
	},
	{
		token: "wget",
		match: (c) => /\bwget\b.+\|\s*(?:bash|sh|dash|zsh)\b/.test(c),
	},

	// Privilege escalation
	{ token: "sudo", match: (c) => /\bsudo\b/.test(c) },

	// Arbitrary shell execution with -c (could run anything)
	{ token: "bash", match: (c) => /\bbash\s+-c\b/.test(c) },
	{ token: "sh", match: (c) => /\bsh\s+-c\b/.test(c) },
];

function shouldSandbox(command: string): boolean {
	const base = getBaseCommand(command);
	const token = firstToken(base);
	return SANDBOX_PATTERNS.some((p) => p.token === token && p.match(base));
}

export default function (pi: ExtensionAPI) {
	// Daytona Sandbox Interceptor — blacklist approach:
	// Only route dangerous commands (package installs, curl|bash, sudo, etc.)
	// to the sandbox. Everything else runs on host.
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command.trim();

		if (!shouldSandbox(command)) {
			// Block absolute paths outside the project directory (safety net)
			const absPaths = command.match(/\s(\/[^ ]+)/g);
			if (absPaths) {
				for (const match of absPaths) {
					const path = match.trim();
					if (!path.startsWith(ctx.cwd)) {
						return {
							block: true,
							reason: `Blocked: absolute path "${path}" is outside the project directory "${ctx.cwd}". Use relative paths instead.`,
						};
					}
				}
			}
			return; // run on host unchanged
		}

		// --- Sandbox path ---
		const probe = async () => {
			const result = await pi.exec(
				"daytona",
				["exec", "pi-sandbox", "--", "true"],
				{ timeout: 10000, signal: ctx.signal },
			);
			return result.code === 0;
		};

		if (!(await probe())) {
			let started = false;
			for (let i = 0; i < 5; i++) {
				const result = await pi.exec("daytona", ["start", "pi-sandbox"], {
					timeout: 30000,
					signal: ctx.signal,
				});
				if (result.code === 0) {
					started = true;
					break;
				}
				await new Promise((r) => setTimeout(r, 2000));
			}

			if (!started) {
				// Ensure a persistent volume exists for the sandbox
				await pi.exec("daytona", ["volume", "create", "pi-sandbox-vol"], {
					timeout: 30000,
					signal: ctx.signal,
				});
				// volume create may fail if it already exists; that's okay

				const createResult = await pi.exec(
					"daytona",
					[
						"create",
						"--name",
						"pi-sandbox",
						"--volume",
						"pi-sandbox-vol:/workspace",
					],
					{ timeout: 60000, signal: ctx.signal },
				);

				if (createResult.code === 0) {
					for (let i = 0; i < 20; i++) {
						await new Promise((r) => setTimeout(r, 1500));
						if (await probe()) break;
					}
				}
			}
		}

		const cmd = command.replace(/'/g, "'\"'\"'");
		event.input.command = `daytona exec pi-sandbox -- '${cmd}'`;
	});

	// Local AST graph search (Requires local service running on port 9749)
	pi.registerTool({
		name: "search_graph",
		label: "Search Graph",
		description: "Search the local AST graph database",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const res = await fetch(
				`http://localhost:9749/search?q=${encodeURIComponent(params.query)}`,
			);
			const data = await res.json();
			return {
				content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
				details: data,
			};
		},
	});
}
