/**
 * supervisor — Kanban-driven agent orchestration for GitHub issues
 *
 * Registers `/supervisor <issue-number>` slash command.
 * Reads issue status from a GitHub project board and dispatches the
 * appropriate sub-agent (Architect, TestDesigner, Developer, Auditor).
 * Runs the full pipeline in a loop until Done or blocked.
 * Agents are defined as .pi/agents/*.md files with YAML frontmatter.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────

interface SupervisorConfig {
	repo: string;
	projectNumber: number;
	statusField?: string;
	statusMapping: Record<string, string>;
	maxRejections?: number;
}

interface AgentFrontmatter {
	name: string;
	description?: string;
	tools?: string;
	model?: string;
	[key: string]: unknown;
}

interface ParsedAgent {
	config: AgentFrontmatter;
	systemPrompt: string;
}

interface ProjectField {
	id: string;
	name: string;
	type: string;
	options?: Array<{ id: string; name: string }>;
}

interface ProjectItem {
	id: string;
	status?: string;
	content?: { url?: string; number?: number };
	fieldValues?: { fieldId: string; value: string; optionId?: string }[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

function loadConfig(): SupervisorConfig {
	const settingsPath = ".pi/settings.json";
	if (!existsSync(settingsPath)) {
		throw new Error("No .pi/settings.json found. Add a 'supervisor' key.");
	}
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
	const cfg = settings.supervisor;
	if (!cfg) throw new Error("No 'supervisor' key in .pi/settings.json.");
	if (!cfg.repo) throw new Error("supervisor.repo is required.");
	if (!cfg.projectNumber)
		throw new Error("supervisor.projectNumber is required.");
	if (!cfg.statusMapping || Object.keys(cfg.statusMapping).length === 0) {
		throw new Error("supervisor.statusMapping is required.");
	}
	return {
		repo: cfg.repo,
		projectNumber: cfg.projectNumber,
		statusField: cfg.statusField || "Status",
		statusMapping: cfg.statusMapping,
		maxRejections: cfg.maxRejections ?? 3,
	};
}

function parseAgentFile(filePath: string): ParsedAgent {
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

function gh(args: string[]): string {
	try {
		return execSync(`gh ${args.join(" ")}`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: 30_000,
		}).trim();
	} catch (err: any) {
		const stderr = err.stderr?.toString() || err.message;
		throw new Error(`gh ${args[0]} failed: ${stderr}`);
	}
}

function ghJson(args: string[]): any {
	const output = gh(args);
	if (!output) return null;
	return JSON.parse(output);
}

function getProjectFields(
	projectNumber: number,
	owner: string,
): ProjectField[] {
	const result = ghJson([
		"project",
		"field-list",
		String(projectNumber),
		"--owner",
		owner,
		"--format",
		"json",
	]);
	return result?.fields || result || [];
}

function getProjectItems(projectNumber: number, owner: string): ProjectItem[] {
	const result = ghJson([
		"project",
		"item-list",
		String(projectNumber),
		"--owner",
		owner,
		"-L",
		"100",
		"--format",
		"json",
	]);
	return result?.items || result || [];
}

function findIssueItem(
	items: ProjectItem[],
	issueNumber: number,
): ProjectItem | null {
	for (const item of items) {
		if (item.content?.number === issueNumber) return item;
		const url = item.content?.url || "";
		if (
			url.includes(`/issues/${issueNumber}`) ||
			url.includes(`/pull/${issueNumber}`)
		)
			return item;
	}
	return null;
}

function getItemStatusName(item: ProjectItem): string {
	return item.status || "Unknown";
}

function findStatusOption(
	fields: ProjectField[],
	statusFieldId: string,
	statusName: string,
): string | null {
	const field = fields.find((f) => f.id === statusFieldId);
	if (!field?.options) return null;
	const option = field.options.find(
		(o) => o.name.toLowerCase() === statusName.toLowerCase(),
	);
	return option?.id || null;
}

function setItemStatus(
	itemId: string,
	projectId: string,
	fieldId: string,
	optionId: string,
): void {
	gh([
		"project",
		"item-edit",
		"--id",
		itemId,
		"--project-id",
		projectId,
		"--field-id",
		fieldId,
		"--single-select-option-id",
		optionId,
	]);
}

function getProjectId(projectNumber: number, owner: string): string {
	const result = ghJson([
		"project",
		"view",
		String(projectNumber),
		"--owner",
		owner,
		"--format",
		"json",
	]);
	return result?.id || "";
}

async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
): Promise<{ output: string; success: boolean; summary: string }> {
	const tools = agent.config.tools || "read,bash,write,edit";
	const model = agent.config.model || "";

	const args: string[] = [
		"-p",
		"--mode",
		"json",
		task,
		"--system-prompt",
		agent.systemPrompt,
		"--tools",
		tools,
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
	];
	if (model) args.push("--model", model);

	const widgetId = `agent-${agent.config.name}`;
	ctx.ui.notify(`Running agent: ${agent.config.name}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agent.config.name}...`);

	return new Promise((resolve) => {
		const child = spawn("/usr/bin/pi", args, {
			cwd: process.cwd(),
			env: { ...process.env, PI_NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 600_000,
		});

		let rawStdout = "";
		let stderr = "";
		let jsonBuffer = "";
		let widgetLines: string[] = [];
		const MAX_WIDGET_LINES = 80;
		// Build readable summary for final output
		const summaryParts: string[] = [];

		const pushWidget = (line: string) => {
			if (
				line === "" &&
				widgetLines.length > 0 &&
				widgetLines[widgetLines.length - 1] === ""
			)
				return;
			widgetLines.push(line);
			if (widgetLines.length > MAX_WIDGET_LINES) {
				widgetLines = widgetLines.slice(-MAX_WIDGET_LINES);
			}
			ctx.ui.setWidget(widgetId, widgetLines);
		};

		const processJsonLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const ev = JSON.parse(line);
				switch (ev.type) {
					case "session":
						break; // skip header
					case "message_start":
						if (ev.message?.role === "assistant") {
							pushWidget("");
							summaryParts.push("");
						}
						break;
					case "message_update": {
						const delta = ev.assistantMessageEvent;
						if (!delta) break;
						if (delta.type === "text_delta" && delta.delta) {
							if (widgetLines.length === 0) pushWidget("");
							widgetLines[widgetLines.length - 1] += delta.delta;
							if (
								summaryParts.length === 0 ||
								summaryParts[summaryParts.length - 1]?.startsWith("🔧")
							) {
								summaryParts.push(delta.delta);
							} else {
								summaryParts[summaryParts.length - 1] += delta.delta;
							}
							ctx.ui.setWidget(widgetId, widgetLines);
						} else if (delta.type === "thinking_delta" && delta.delta) {
							pushWidget(`💭 ${delta.delta.trim()}`);
						} else if (delta.type === "tool_call_start") {
							const line = `🔧 ${delta.name}(${JSON.stringify(delta.args || {}).slice(0, 120)})`;
							pushWidget(line);
							summaryParts.push(line);
						}
						break;
					}
					case "tool_execution_start": {
						const line = `⏳ ${ev.toolName}...`;
						pushWidget(line);
						break;
					}
					case "tool_execution_end": {
						const icon = ev.isError ? "❌" : "✅";
						const line = `${icon} ${ev.toolName} done`;
						pushWidget(line);
						break;
					}
					case "turn_end":
					case "agent_end":
						break; // ignored for widget
					case "message_end":
						if (ev.message?.role === "assistant") {
							pushWidget("");
						}
						break;
				}
			} catch {
				// non-JSON interspersed output (rare)
			}
		};

		child.stdout.on("data", (data: Buffer) => {
			const chunk = data.toString();
			rawStdout += chunk;
			jsonBuffer += chunk;
			const lines = jsonBuffer.split("\n");
			jsonBuffer = lines.pop() || "";
			for (const line of lines) processJsonLine(line);
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			// flush remaining buffer
			if (jsonBuffer.trim()) processJsonLine(jsonBuffer);
			ctx.ui.setWidget(widgetId, []);
			ctx.ui.setStatus("supervisor", "");
			// Build readable summary from collected parts
			const readable = summaryParts.join("\n").trim();
			// rawStdout for marker detection, readable for display
			const output = rawStdout + (stderr ? "\n[STDERR]\n" + stderr : "");
			resolve({ output, success: code === 0, summary: readable || output });
		});

		child.on("error", (err) => {
			ctx.ui.setWidget(widgetId, []);
			ctx.ui.setStatus("supervisor", "");
			resolve({
				output: `Failed to start pi: ${err.message}`,
				success: false,
				summary: `Failed to start pi: ${err.message}`,
			});
		});
	});
}

function countRejections(comments: any[]): number {
	let count = 0;
	for (let i = comments.length - 1; i >= 0; i--) {
		const body = comments[i]?.body || "";
		if (body.includes("Audit Rejected") || body.includes("AUDIT_REJECTED")) {
			count++;
		} else if (
			body.includes("Audit Approved") ||
			body.includes("ARCHITECTURE") ||
			body.includes("Test Plan")
		) {
			break;
		}
	}
	return count;
}

function buildAgentTask(
	agentName: string,
	issueNum: number,
	repo: string,
	title: string,
	_issueData: any,
): string {
	const base = `You are working on GitHub issue #${issueNum}: "${title}" in repository ${repo}.`;

	switch (agentName) {
		case "architect":
			return `${base}\n\nYour task: Read the issue body and post an architecture comment describing the implementation approach.\nUse: gh issue view ${issueNum} --repo ${repo} --json body,title\nThen: gh issue comment ${issueNum} --repo ${repo} --body "...your architecture..."\nWhen done, output ARCHITECTURE_COMPLETE on its own line.`;

		case "test-designer":
			return `${base}\n\nYour task: Read the issue (body + all comments including architecture) and post a test plan comment.\nUse: gh issue view ${issueNum} --repo ${repo} --json body,title,comments\nThen: gh issue comment ${issueNum} --repo ${repo} --body "...your test plan..."\nWhen done, output TEST_PLAN_COMPLETE on its own line.`;

		case "developer": {
			const branch = generateBranchName(issueNum, title);
			return `${base}\n\nYour task: Implement the code changes in a git worktree.\n\nIMPORTANT: Each bash command runs in the project root. You MUST chain cd with every command that operates on the worktree!\n\n1. Read issue + comments: gh issue view ${issueNum} --repo ${repo} --json body,title,comments\n2. Create worktree: git worktree add ../${branch} main\n3. For all implementation work, use: cd ../${branch} && <your commands>\n   (Never run write/edit/bash in the project root - always cd into worktree first!)\n4. Implement the feature following the architecture and test plan from comments\n5. cd ../${branch} && git add -A && git commit -m "feat(#${issueNum}): ${title}" && git push origin ${branch}\n\nYour branch name MUST be: ${branch}\nWorktree path: ../${branch}\nWhen done, output IMPLEMENTATION_COMPLETE on its own line.`;
		}

		case "auditor": {
			const branch = generateBranchName(issueNum, title);
			return `${base}\n\nYour task: Review the implementation in the developer's worktree at ../${branch} and decide APPROVE or REJECT.\n\n1. Read issue + comments: gh issue view ${issueNum} --repo ${repo} --json body,title,comments\n2. Enter worktree: cd ../${branch}\n3. Review the code: git diff main (shows all changes on this branch vs main)\n4. Run tests if any exist\n5. Decide:\n\nIF APPROVE:\n  gh pr create --repo ${repo} --base main --head ${branch} --title "feat(#${issueNum}): ${title}" --body "Closes #${issueNum}"\n  cd back to original repo\n  Output AUDIT_APPROVED on its own line.\n\nIF REJECT:\n  cd back to original repo\n  gh issue comment ${issueNum} --repo ${repo} --body "## Audit Rejected\n\n[list specific issues]"\n  Output AUDIT_REJECTED on its own line.`;
		}

		default:
			return base;
	}
}

function generateBranchName(issueNum: number, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-")
		.slice(0, 50);
	return `git-issue#${issueNum}-${slug}`;
}

function determineNextStatus(
	agentName: string,
	output: string,
	_currentStatus: string,
	_config: SupervisorConfig,
): string | null {
	switch (agentName) {
		case "architect":
			return output.includes("ARCHITECTURE_COMPLETE") ? "TestDesign" : null;
		case "test-designer":
			return output.includes("TEST_PLAN_COMPLETE") ? "Implementation" : null;
		case "developer":
			return output.includes("IMPLEMENTATION_COMPLETE") ? "Audit" : null;
		case "auditor":
			if (output.includes("AUDIT_APPROVED")) return "Done";
			if (output.includes("AUDIT_REJECTED")) return "Implementation";
			return null;
		default:
			return null;
	}
}

// ─── Extension ───────────────────────────────────────────────────────

export default function supervisor(pi: ExtensionAPI) {
	pi.registerCommand("supervisor", {
		description: "Process a GitHub issue through the full Kanban pipeline",
		handler: async (args, ctx) => {
			const issueNum = parseInt(args?.trim() || "", 10);
			if (!issueNum || issueNum < 1) {
				ctx.ui.notify("Usage: /supervisor <issue-number>", "error");
				return;
			}

			try {
				const config = loadConfig();
				const owner = config.repo.split("/")[0]!;

				// Initial fetch
				ctx.ui.notify(`Fetching issue #${issueNum}...`, "info");
				let issueData: any;
				try {
					issueData = ghJson([
						"issue",
						"view",
						String(issueNum),
						"--repo",
						config.repo,
						"--json",
						"number,title,body,comments",
					]);
				} catch {
					ctx.ui.notify(
						`Issue #${issueNum} not found in ${config.repo}`,
						"error",
					);
					return;
				}

				const issueTitle: string = issueData?.title || `Issue #${issueNum}`;

				// Get board info
				ctx.ui.setStatus("supervisor", "Reading project board...");
				let fields: ProjectField[];
				let items: ProjectItem[];
				let projectId: string;

				try {
					fields = getProjectFields(config.projectNumber, owner);
					items = getProjectItems(config.projectNumber, owner);
					projectId = getProjectId(config.projectNumber, owner);
				} catch (err: any) {
					const msg = err.message || String(err);
					if (
						msg.includes("missing required scopes") ||
						msg.includes("project")
					) {
						ctx.ui.notify(
							"GitHub token missing 'project' scope. Run: gh auth refresh -s project",
							"error",
						);
					} else {
						ctx.ui.notify(`Failed to read project board: ${msg}`, "error");
					}
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				const statusField = fields.find(
					(f) => f.name.toLowerCase() === config.statusField?.toLowerCase(),
				);
				if (!statusField) {
					ctx.ui.notify(
						`Status field '${config.statusField}' not found. Fields: ${fields.map((f) => f.name).join(", ")}`,
						"error",
					);
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				const loopItem = findIssueItem(items, issueNum);
				if (!loopItem) {
					ctx.ui.notify(
						`Issue #${issueNum} not on project board #${config.projectNumber}.`,
						"error",
					);
					ctx.ui.setStatus("supervisor", "");
					return;
				}

				// ── Pipeline loop ────────────────────────────────────
				let loopStatus = getItemStatusName(loopItem);
				const MAX_LOOPS = 20;

				for (let i = 0; i < MAX_LOOPS; i++) {
					ctx.ui.notify(
						`Issue #${issueNum}: "${issueTitle}" — Status: ${loopStatus}`,
						"info",
					);

					// BACKLOG → advance to Architecture
					if (loopStatus.toLowerCase() === "backlog") {
						const optId = findStatusOption(
							fields,
							statusField.id,
							"Architecture",
						);
						if (!optId) {
							ctx.ui.notify(
								"Cannot find 'Architecture' status option",
								"error",
							);
							break;
						}
						setItemStatus(loopItem.id, projectId, statusField.id, optId);
						ctx.ui.notify(
							`Issue #${issueNum} moved: Backlog → Architecture`,
							"info",
						);
						loopStatus = "Architecture";
						continue;
					}

					// DONE → complete
					if (loopStatus.toLowerCase() === "done") {
						ctx.ui.notify(
							`Issue #${issueNum} is Done. Pipeline complete.`,
							"info",
						);
						break;
					}

					// Map status to agent
					const agentName = config.statusMapping[loopStatus];
					if (!agentName) {
						const mapped = Object.keys(config.statusMapping).join(", ");
						ctx.ui.notify(
							`No agent for status '${loopStatus}'. Mapped: ${mapped}`,
							"error",
						);
						break;
					}

					// Re-read issue for fresh comments
					let freshData: any;
					try {
						freshData = ghJson([
							"issue",
							"view",
							String(issueNum),
							"--repo",
							config.repo,
							"--json",
							"number,title,body,comments",
						]);
					} catch {
						freshData = issueData;
					}

					// Rejection limit check
					if (agentName === "auditor") {
						const comments = freshData?.comments || [];
						if (countRejections(comments) >= (config.maxRejections || 3)) {
							ctx.ui.notify(
								`Issue #${issueNum} rejected ${config.maxRejections} times. Human intervention required.`,
								"error",
							);
							break;
						}
					}

					// Load agent
					const agentPath = `.pi/agents/${agentName}.md`;
					if (!existsSync(agentPath)) {
						ctx.ui.notify(`Agent file not found: ${agentPath}`, "error");
						break;
					}

					let agent: ParsedAgent;
					try {
						agent = parseAgentFile(agentPath);
					} catch (err: any) {
						ctx.ui.notify(`Failed to parse agent: ${err.message}`, "error");
						break;
					}

					// Build task and run
					const task = buildAgentTask(
						agentName,
						issueNum,
						config.repo,
						issueTitle,
						freshData,
					);
					ctx.ui.notify(`Dispatching ${agent.config.name}...`, "info");

					let result = await runAgent(agent, task, ctx);
					let usedRetry = false;

					if (!result.success) {
						ctx.ui.notify(
							`Agent ${agent.config.name} failed. Retrying once...`,
							"warning",
						);
						result = await runAgent(agent, task, ctx);
						usedRetry = true;
						if (!result.success) {
							ctx.ui.notify(
								`Agent ${agent.config.name} failed after retry.`,
								"error",
							);
							pi.sendMessage({
								customType: "supervisor",
								content: `## Agent: ${agent.config.name} — FAILED\n\n\`\`\`\n${result.summary || result.output}\n\`\`\``,
								display: true,
							});
							break;
						}
					}

					// Show output summary in chat on success (or retry success)
					const statusLabel = usedRetry ? "SUCCESS (after retry)" : "SUCCESS";
					const trimLen = 3000;
					const trimmedOutput =
						(result.summary || result.output).length > trimLen
							? (result.summary || result.output).slice(0, trimLen) +
								"\n...\n[output trimmed]"
							: result.summary || result.output;
					pi.sendMessage({
						customType: "supervisor",
						content: `## Agent: ${agent.config.name} — ${statusLabel}\n\n\`\`\`\n${trimmedOutput}\n\`\`\``,
						display: true,
					});

					// Determine and apply next status
					const nextStatus = determineNextStatus(
						agentName,
						result.output,
						loopStatus,
						config,
					);
					if (!nextStatus) {
						ctx.ui.notify(
							`Agent ${agent.config.name} output unclear. Pipeline stopped.`,
							"warning",
						);
						break;
					}

					const nextOptId = findStatusOption(
						fields,
						statusField.id,
						nextStatus,
					);
					if (!nextOptId) {
						ctx.ui.notify(
							`Cannot find '${nextStatus}' option on board.`,
							"warning",
						);
						break;
					}

					try {
						setItemStatus(loopItem.id, projectId, statusField.id, nextOptId);
						ctx.ui.notify(
							`Issue #${issueNum} moved: ${loopStatus} → ${nextStatus}`,
							"info",
						);
					} catch (err: any) {
						ctx.ui.notify(`Failed to update status: ${err.message}`, "error");
						break;
					}

					loopStatus = nextStatus;
				}

				ctx.ui.setStatus("supervisor", "");
			} catch (err: any) {
				ctx.ui.notify(`Supervisor error: ${err.message}`, "error");
				ctx.ui.setStatus("supervisor", "");
			}
		},
	});
}
