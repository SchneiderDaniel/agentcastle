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
import { Container, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────

interface SupervisorConfig {
	repo: string;
	projectNumber: number;
	statusField?: string;
	statusMapping: Record<string, string>;
	maxRejections?: number;
	codeowners: string[];
}

interface AgentFrontmatter {
	name: string;
	description?: string;
	tools?: string;
	model?: string;
	extensions?: string;
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

/** Filtered issue data after codeowner trust check */
interface FilteredIssueData {
	/** Issue body (empty string if author not a trusted codeowner) */
	body: string;
	/** Only comments from trusted codeowners */
	comments: Array<{ author: string; body: string }>;
	/** Whether filtering was applied (codeowners list was non-empty) */
	filteringActive: boolean;
}

/** Structured result returned by runAgent for rendering */
interface AgentRunResult {
	output: string;
	success: boolean;
	agentName: string;
	toolCount: number;
	tokenCount: number;
	durationMs: number;
	/** Clean text output from the agent (no tool/emoji noise) */
	textOutput: string;
	/** Brief summary line: what the agent accomplished */
	summaryLine: string;
	/** Raw stderr if any */
	errorOutput: string;
}

// ─── Message renderer details type ───────────────────────────────────

interface SupervisorMessageDetails {
	agentName: string;
	success: boolean;
	statusLabel: string;
	toolCount: number;
	tokenCount: number;
	durationMs: number;
	textOutput: string;
	summaryLine: string;
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
	const codeowners: string[] = Array.isArray(cfg.codeowners) ? cfg.codeowners : [];
	if (codeowners.length === 0) {
		throw new Error("supervisor.codeowners must be a non-empty list of trusted GitHub usernames.");
	}
	return {
		repo: cfg.repo,
		projectNumber: cfg.projectNumber,
		statusField: cfg.statusField || "Status",
		statusMapping: cfg.statusMapping,
		maxRejections: cfg.maxRejections ?? 3,
		codeowners,
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

/** Filter issue body and comments to only trusted codeowners.
 *  This is enforced in code — NOT via LLM prompt — to prevent prompt injection. */
function filterIssueData(rawIssue: any, codeowners: string[]): FilteredIssueData {
	const issueAuthor: string = rawIssue?.author?.login || "";
	const isIssueAuthorTrusted = codeowners.includes(issueAuthor);

	const body = isIssueAuthorTrusted
		? (rawIssue?.body || "(no body)")
		: `[Issue body hidden — author @${issueAuthor} is not a trusted codeowner]`;

	const rawComments: any[] = rawIssue?.comments || [];
	const trustedComments = rawComments
		.filter((c: any) => {
			const commentAuthor: string = c?.author?.login || "";
			return codeowners.includes(commentAuthor);
		})
		.map((c: any) => ({
			author: c?.author?.login || "unknown",
			body: c?.body || "",
		}));

	return { body, comments: trustedComments, filteringActive: true };
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

// ─── Formatting helpers ──────────────────────────────────────────────

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	const sec = Math.round(ms / 1_000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remainSec = sec % 60;
	return `${min}m ${remainSec}s`;
}

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function boldText(theme: any, text: string): string {
	return theme.bold?.(text) ?? text;
}

// ─── Extension resolution ───────────────────────────────────────────

/**
 * Resolve the extensions CLI flags for a given agent frontmatter.
 * - If extensions field is present and non-empty, split, trim, filter out
 *   "supervisor" (case-insensitive), and return `--extensions <list>`.
 * - If nothing remains after filtering, fall back to `--no-extensions`.
 * - If extensions field is missing or empty, return `--no-extensions`.
 *
 * This is a pure function exported for unit testing.
 */
export function resolveExtensions(extensionsRaw: string | undefined): string[] {
	if (!extensionsRaw || !extensionsRaw.trim()) {
		return ["--no-extensions"];
	}

	const extensions = extensionsRaw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0)
		.filter((s) => s.toLowerCase() !== "supervisor");

	if (extensions.length === 0) {
		return ["--no-extensions"];
	}

	return ["--extensions", extensions.join(",")];
}

// ─── runAgent ────────────────────────────────────────────────────────

async function runAgent(
	agent: ParsedAgent,
	task: string,
	ctx: ExtensionCommandContext,
): Promise<AgentRunResult> {
	const tools = agent.config.tools || "read,bash,write,edit";
	const model = agent.config.model || "";
	const extFlags = resolveExtensions(agent.config.extensions);

	const args: string[] = [
		"-p",
		"--mode",
		"json",
		task,
		"--system-prompt",
		agent.systemPrompt,
		"--tools",
		tools,
		...extFlags,
		"--no-skills",
		"--no-context-files",
	];
	if (model) args.push("--model", model);

	const widgetId = `agent-${agent.config.name}`;
	const agentName = agent.config.name;
	ctx.ui.notify(`Running agent: ${agentName}...`, "info");
	ctx.ui.setStatus("supervisor", `Running ${agentName}...`);

	const startedAt = Date.now();

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

		// Structured tracking
		let currentTool: string | undefined;
		let currentToolArgs: string | undefined;
		let tokenCount = 0;
		let toolCount = 0;
		const textOutputLines: string[] = [];
		const fullLog: string[] = [];
		let lastToolName: string | undefined;

		let flushTimer: NodeJS.Timeout | null = null;

		const buildWidgetLines = (): string[] => {
			const lines: string[] = [];
			// Header: agent name + spinner
			const header = `⚙ ${agentName}`;
			lines.push(header);

			// Status line with current tool and stats
			const statsParts: string[] = [];
			if (tokenCount > 0) statsParts.push(`📊 ${formatTokens(tokenCount)} tokens`);
			if (toolCount > 0) statsParts.push(`🔧 ${toolCount} tools`);
			const elapsed = formatDuration(Date.now() - startedAt);
			statsParts.push(`⏱ ${elapsed}`);

			if (currentTool) {
				const toolLabel = currentToolArgs
					? `${currentTool}: ${currentToolArgs.slice(0, 100)}`
					: currentTool;
				lines.push(`  ${toolLabel}  ${statsParts.join(" · ")}`);
			} else if (statsParts.length > 0) {
				lines.push(`  ${statsParts.join(" · ")}`);
			}

			return lines;
		};

		const flushWidget = () => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			ctx.ui.setWidget(widgetId, buildWidgetLines());
		};

		// Batch widget updates to avoid flicker
		const scheduleFlush = () => {
			if (!flushTimer) {
				flushTimer = setTimeout(flushWidget, 80);
			}
		};

		const processJsonLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const ev = JSON.parse(line);
				switch (ev.type) {
					case "session":
						break;

					case "tool_execution_start":
						currentTool = ev.toolName || "tool";
						currentToolArgs = ev.args
							? JSON.stringify(ev.args).slice(0, 200)
							: undefined;
						lastToolName = ev.toolName;
						const logArgs = ev.args
							? JSON.stringify(ev.args).slice(0, 200)
							: "";
						fullLog.push(
							`🔧 ${ev.toolName}${logArgs ? ` ${logArgs}` : ""}`
						);
						scheduleFlush();
						break;

					case "tool_execution_end":
						toolCount++;
						currentTool = undefined;
						currentToolArgs = undefined;
						fullLog.push(`${ev.isError ? "✗" : "✓"} ${ev.toolName}`);
						scheduleFlush();
						break;

					case "message_end": {
						const msg = ev.message;
						if (!msg) break;

						if (msg.role === "assistant") {
							// Capture text content (the agent's actual output)
							if (Array.isArray(msg.content)) {
								for (const block of msg.content) {
									if (block.type === "thinking" && block.thinking) {
										const thinkingText = typeof block.thinking === "string"
											? block.thinking
											: JSON.stringify(block.thinking).slice(0, 500);
										for (const t of thinkingText.split("\n")) {
											if (t.trim()) fullLog.push(`💭 ${t.slice(0, 200)}`);
										}
									}
								}
							}
							const text = extractTextFromContent(msg.content);
							if (text && text.trim()) {
								textOutputLines.push(text.trim());
								for (const t of text.split("\n")) {
									if (t.trim()) fullLog.push(t);
								}
							}
							if (msg.usage) {
								tokenCount =
									msg.usage.totalTokens || msg.usage.input + msg.usage.output;
							}
							scheduleFlush();
						} else if (msg.role === "toolResult") {
							const resultText = extractTextFromContent(msg.content);
							const label = msg.toolName || lastToolName || "tool";
							if (resultText && resultText.trim()) {
								const lines = resultText.split("\n");
								fullLog.push(
									`📋 ${label}: ${lines[0]?.slice(0, 300) || "(no output)"}`
								);
								for (let i = 1; i < Math.min(lines.length, 6); i++) {
									if (lines[i].trim())
										fullLog.push(`   ${lines[i].slice(0, 200)}`);
								}
							} else {
								fullLog.push(`📋 ${label}: (no output)`);
							}
							lastToolName = undefined;
							scheduleFlush();
						}
						break;
					}

					case "agent_end":
					case "turn_end":
					case "message_update":
						break;
				}
			} catch {
				// non-JSON stdout lines
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
			if (jsonBuffer.trim()) processJsonLine(jsonBuffer);
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}

			const durationMs = Date.now() - startedAt;
			const textOutput = fullLog.join("\n").trim();
			const rawOutput = rawStdout + (stderr ? "\n[STDERR]\n" + stderr : "");
			const success = code === 0;

			// Extract a one-line summary from the text output
			const summaryLine = extractSummaryLine(textOutput, success, agentName);

			// Clear the widget — results go to chat via message renderer
			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setStatus("supervisor", "");

			resolve({
				output: rawOutput,
				success,
				agentName,
				toolCount,
				tokenCount,
				durationMs,
				textOutput,
				summaryLine,
				errorOutput: stderr,
			});
		});

		child.on("error", (err) => {
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}
			ctx.ui.setWidget(widgetId, undefined);
			ctx.ui.setStatus("supervisor", "");
			resolve({
				output: `Failed to start pi: ${err.message}`,
				success: false,
				agentName: agent.config.name,
				toolCount: 0,
				tokenCount: 0,
				durationMs: Date.now() - startedAt,
				textOutput: "",
				summaryLine: `Failed to start: ${err.message}`,
				errorOutput: err.message,
			});
		});
	});
}

// ─── Output helpers ──────────────────────────────────────────────────

function extractTextFromContent(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text" && b.text)
		.map((b: any) => b.text)
		.join("\n");
}

/** Pull a one-line summary from the agent's text output */
function extractSummaryLine(
	textOutput: string,
	success: boolean,
	agentName: string,
): string {
	if (!textOutput) return success ? `${agentName} completed` : `${agentName} failed`;

	// Find the LAST completion marker (avoids matching echoed task instructions
	// that contain both AUDIT_APPROVED and AUDIT_REJECTED).
	const markers = [
		"ARCHITECTURE_COMPLETE",
		"RESEARCH_COMPLETE",
		"TEST_PLAN_COMPLETE",
		"IMPLEMENTATION_COMPLETE",
		"AUDIT_APPROVED",
		"AUDIT_REJECTED",
	];
	let lastIdx = -1;
	let lastMarker = "";
	for (const marker of markers) {
		const idx = textOutput.lastIndexOf(marker);
		if (idx > lastIdx) {
			lastIdx = idx;
			lastMarker = marker;
		}
	}
	if (lastMarker) {
		return lastMarker.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
	}

	// Use first non-empty, non-tool line
	const firstLine = textOutput.split("\n").find(
		(l) => l.trim() && !l.startsWith("🔧") && !l.startsWith("📋") && !l.startsWith("💭"),
	);
	if (firstLine) {
		return firstLine.trim().slice(0, 120);
	}
	return success ? `${agentName} completed` : `${agentName} failed`;
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
	filteredData: FilteredIssueData,
): string {
	// Build trusted comments block
	let commentsBlock: string;
	if (filteredData.comments.length > 0) {
		commentsBlock = filteredData.comments
			.map((c, i) => `--- Comment #${i + 1} by @${c.author} ---\n${c.body}`)
			.join("\n\n");
	} else {
		commentsBlock = "(no trusted comments)";
	}

	// Build the pre-filtered issue data block that agents must use
	const issueBlock = [
		`## Issue Data (pre-filtered — use this, do NOT fetch from GitHub)`,
		`**Title:** ${title}`,
		`**Repository:** ${repo}`,
		``,
		`### Body`,
		filteredData.body,
		``,
		`### Trusted Comments`,
		commentsBlock,
	].join("\n");

	switch (agentName) {
		case "architect":
			return `${issueBlock}\n\n## Task\nAnalyze the issue body above and post an architecture comment describing the implementation approach.\n\nUse: gh issue comment ${issueNum} --repo ${repo} --body "...your architecture..."\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output ARCHITECTURE_COMPLETE on its own line.`;

		case "test-designer":
			return `${issueBlock}\n\n## Task\nReview the issue body and trusted comments above (architecture), then post a test plan comment.\n\nUse: gh issue comment ${issueNum} --repo ${repo} --body "...your test plan..."\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output TEST_PLAN_COMPLETE on its own line.`;

		case "developer": {
			const branch = generateBranchName(issueNum, title);
			return `${issueBlock}\n\n## Task\nImplement the code changes in a git worktree.\n\n### Setup\n1. Create worktree: \`git worktree add ../${branch} main\`\n2. For ALL implementation work, use: \`cd ../${branch} && <your commands>\`\n   (Never run write/edit/bash in the project root — always cd into worktree first!)\n3. Implement the feature following the architecture and test plan from the trusted comments above.\n\n### Commit\n\`\`\`\ncd ../${branch}\ngit add -A\ngit commit -m "feat(#${issueNum}): ${title}"\ngit push origin ${branch}\n\`\`\`\n\n**Branch name:** ${branch}\n**Worktree path:** ../${branch}\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output IMPLEMENTATION_COMPLETE on its own line.`;
		}

		case "auditor": {
			const branch = generateBranchName(issueNum, title);
			return `${issueBlock}\n\n## Task\nReview the implementation in the developer's worktree at ../${branch} and decide APPROVE or REJECT.\n\n### Steps\n1. Enter worktree: \`cd ../${branch}\`\n2. Review the code: \`git diff main\` (shows all changes on this branch vs main)\n3. Run tests if any exist\n4. Evaluate against the architecture and test plan from the trusted comments above.\n\n### Decision\n\n**IF APPROVE:**\n\`\`\`\ngh pr create --repo ${repo} --base main --head ${branch} --title "feat(#${issueNum}): ${title}" --body "Closes #${issueNum}"\ngh issue comment ${issueNum} --repo ${repo} --body "## Audit Approved\n\nThe implementation has been reviewed and meets all requirements.\n\n- Architecture compliance: ✓\n- Test coverage: ✓\n- Code quality: ✓\n- Completeness: ✓\n\nPR created. Ready for merge."\n\`\`\`\nOutput AUDIT_APPROVED on its own line.\n\n**IF REJECT:**\n\`\`\`\ngh issue comment ${issueNum} --repo ${repo} --body "## Audit Rejected\n\n[list specific issues]"\n\`\`\`\nOutput AUDIT_REJECTED on its own line.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.`;
		}

		case "researcher":
			return `${issueBlock}\n\n## Task\nResearch the issue topic against public web sources and post a structured findings comment.\n\n### Steps\n1. Scan the provided issue data above. If you see a comment containing \`## Research Findings\`, skip all research and output RESEARCH_COMPLETE on its own line immediately.\n2. Extract the core topic from the issue title, body, and architecture comment.\n3. Crawl 3-5 distinct public web pages using \`web_crawl <url> --maxPages 1\`\n4. Synthesize findings into a single comment using:\n   \`gh issue comment ${issueNum} --repo ${repo} --body "...your findings..."\`\n\n### Comment format\n\`\`\`\n## Research Findings\n\n### Best Practices\n- <finding> — <source link>\n\n### Recent Libraries\n- <library> <version> — <why relevant> — <source link>\n\n### Common Pitfalls\n- <pitfall> — <why it matters> — <source link>\n\`\`\`\n\nEvery bullet must include a source URL. Findings only — no recommendations, no architectural judgments. If all crawls fail, post: \`## Research Findings — No relevant results found for this topic.\`\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\` — the data above is pre-filtered for trust.\n\nWhen done, output RESEARCH_COMPLETE on its own line.`;

		default:
			return `${issueBlock}\n\n## Task\nComplete the task for issue #${issueNum}.\n\n**SECURITY RULE:** Use ONLY the issue data provided above. Do NOT run \`gh issue view\`.`;
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
			return output.includes("ARCHITECTURE_COMPLETE") ? "Research" : null;
		case "researcher":
			return output.includes("RESEARCH_COMPLETE") ? "TestDesign" : null;
		case "test-designer":
			return output.includes("TEST_PLAN_COMPLETE") ? "Implementation" : null;
		case "developer":
			return output.includes("IMPLEMENTATION_COMPLETE") ? "Audit" : null;
		case "auditor": {
			// Use lastIndexOf: the agent's task prompt contains both
			// "AUDIT_APPROVED" and "AUDIT_REJECTED" in the instructions.
			// The final verdict always appears last in the output.
			const idxApproved = output.lastIndexOf("AUDIT_APPROVED");
			const idxRejected = output.lastIndexOf("AUDIT_REJECTED");
			if (idxRejected > idxApproved) return "Implementation";
			if (idxApproved > idxRejected) return "Done";
			return null;
		}
		default:
			return null;
	}
}

// ─── Extension ───────────────────────────────────────────────────────

export default function supervisor(pi: ExtensionAPI) {
	// ── Message renderer: styled supervisor result ──────────────────

	pi.registerMessageRenderer<SupervisorMessageDetails>("supervisor", (message, _options, theme) => {
		const details = message.details as SupervisorMessageDetails | undefined;
		// Fallback for old-format messages that only have content string
		if (!details && typeof message.content === "string") {
			return new Text(message.content, 1, 1);
		}
		if (!details) return new Text("(no details)", 1, 1);

		const w = Math.max(40, getTermWidth() - 4);
		const fit = (s: string) => truncateToWidth(s, w);

		const c = new Container();
		const statusColor = details.success ? "success" : "error";
		const statusIcon = details.success ? "✓" : "✗";
		const statusText = details.success ? "SUCCESS" : "FAILED";

		// Header: status icon + agent name + status
		c.addChild(new Text(
			fit(`${theme.fg(statusColor, statusIcon)} ${theme.fg("toolTitle", boldText(theme, details.agentName))} — ${theme.fg(statusColor, statusText)}`),
			1, 0,
		));

		// Stats line: tools, tokens, duration
		const statsParts: string[] = [];
		if (details.toolCount > 0) statsParts.push(`${details.toolCount} tool${details.toolCount === 1 ? "" : "s"}`);
		if (details.tokenCount > 0) statsParts.push(`${formatTokens(details.tokenCount)} tokens`);
		if (details.durationMs > 0) statsParts.push(formatDuration(details.durationMs));
		if (statsParts.length > 0) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(
				fit(theme.fg("dim", statsParts.join(" · "))),
				1, 0,
			));
		}

		// Summary line
		if (details.summaryLine) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(
				fit(theme.fg("dim", details.summaryLine)),
				1, 0,
			));
		}

		// Text output (full, no truncation, color-coded by event type)
		if (details.textOutput) {
			c.addChild(new Spacer(1));
			const outputLines = details.textOutput.split("\n");
			for (const line of outputLines) {
				let styledLine: string;
				if (line.startsWith("🔧 ")) {
					styledLine = theme.fg("toolTitle", line);
				} else if (line.startsWith("✓ ")) {
					styledLine = theme.fg("success", line);
				} else if (line.startsWith("✗ ")) {
					styledLine = theme.fg("error", line);
				} else if (line.startsWith("💭 ")) {
					styledLine = theme.fg("dim", line);
				} else if (line.startsWith("📋 ")) {
					styledLine = theme.fg("dim", line);
				} else {
					styledLine = line;
				}
				c.addChild(new Text(
					fit(styledLine || " "),
					1, 0,
				));
			}
		}

		return c;
	});

	// ── Slash command ───────────────────────────────────────────────

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
						"number,title,body,author,comments",
					]);
				} catch {
					ctx.ui.notify(
						`Issue #${issueNum} not found in ${config.repo}`,
						"error",
					);
					return;
				}

				const issueTitle: string = issueData?.title || `Issue #${issueNum}`;

				// Code-level security: filter issue body + comments to trusted codeowners only
				const filteredData = filterIssueData(issueData, config.codeowners);

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
							"number,title,body,author,comments",
						]);
					} catch {
						freshData = issueData;
					}

					// Code-level security: filter issue body + comments to trusted codeowners only
					const loopFilteredData = filterIssueData(freshData, config.codeowners);

					// Rejection limit check (uses filtered comments to prevent attacker-triggered limit)
					if (agentName === "auditor") {
						const rejectionCount = countRejections(
							loopFilteredData.comments.map((c) => ({ body: c.body })),
						);
						if (rejectionCount >= (config.maxRejections || 3)) {
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
						loopFilteredData,
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
					}

					// Send structured result to chat (rendered by message renderer)
					const statusLabel = !result.success
						? "FAILED"
						: usedRetry
							? "SUCCESS (after retry)"
							: "SUCCESS";

					pi.sendMessage({
						customType: "supervisor",
						content: `## Agent: ${result.agentName} — ${statusLabel}\n\n${result.textOutput || result.summaryLine}`,
						display: true,
						details: {
							agentName: result.agentName,
							success: result.success,
							statusLabel,
							toolCount: result.toolCount,
							tokenCount: result.tokenCount,
							durationMs: result.durationMs,
							textOutput: result.textOutput,
							summaryLine: result.summaryLine,
						} satisfies SupervisorMessageDetails,
					});

					if (!result.success) {
						break;
					}

					// Determine and apply next status
					const nextStatus = determineNextStatus(
						agentName,
						result.textOutput,
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
