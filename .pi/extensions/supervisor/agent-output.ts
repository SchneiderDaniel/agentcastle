// ─── Agent Output Parser ──────────────────────────────────────────
// Single deterministic parser for all agent outputs.
// Agents output structured JSON; this function parses and validates it.
// No regex fallback, no text marker scanning, no lastIndexOf lookups.

import type {
	AgentOutput,
	FailedParse,
	ParseResult,
	FindingSeverity,
	AuditDimension,
} from "./types.ts";

// ─── ANSI Stripping ──────────────────────────────────────────────

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

// ─── Known Auditing Dimensions ────────────────────────────────────

const KNOWN_DIMENSIONS = new Set<AuditDimension>([
	"architecture-compliance",
	"ticket-fulfillment",
	"tests-passed",
	"test-quality",
	"correctness-safety",
	"code-quality",
	"completeness",
]);

const VALID_SEVERITIES = new Set<FindingSeverity>(["critical", "warning", "suggestion"]);

// ─── JSON Sanitization ────────────────────────────────────────────

/**
 * Escape literal newlines (\\n, \\r) inside JSON string values.
 * Agents often produce JSON where commentBody contains actual newlines
 * instead of \\n escape sequences. This makes JSON.parse fail.
 *
 * This function walks the JSON text character by character, tracking
 * string boundaries, and replaces literal newlines with the \\n escape.
 *
 * Edge cases handled:
 * - Escaped quotes (\\") inside strings
 * - Backslash-escaped characters (\\\\, \\n, etc.)
 * - Nested JSON objects (tracked via brace depth outside strings)
 */
function sanitizeJsonStrings(jsonText: string): string {
	let result = "";
	let inString = false;
	let escaped = false;

	for (const ch of jsonText) {
		if (escaped) {
			// Previous char was backslash — pass current char through literally
			result += ch;
			escaped = false;
			continue;
		}

		if (inString && ch === "\\") {
			// Start escape sequence inside string
			result += ch;
			escaped = true;
			continue;
		}

		if (ch === '"') {
			// Toggle string state (only toggles when not escaped)
			result += ch;
			inString = !inString;
			continue;
		}

		if (inString && (ch === "\n" || ch === "\r")) {
			// Literal newline inside string — replace with JSON escape
			result += ch === "\n" ? "\\n" : "\\r";
			continue;
		}

		result += ch;
	}

	return result;
}

// ─── JSON Extraction ──────────────────────────────────────────────

/**
 * Extract the last JSON object from a string.
 * Handles:
 * - Pure JSON input
 * - JSON embedded in markdown code fences (```json ... ```)
 * - JSON with surrounding text
 * - Multiple JSON objects (picks last)
 *
 * Brace matching is string-boundary aware — { and } inside JSON string
 * values (e.g., tool args like {"pattern":"function.*{"}) are ignored.
 */
function extractLastJson(raw: string): string {
	// Try to find JSON in ```json or ``` code fences first
	const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
	let fenceMatch: RegExpExecArray | null;
	let lastFence: string | null = null;
	while ((fenceMatch = fenceRegex.exec(raw)) !== null) {
		lastFence = fenceMatch[1].trim();
	}

	if (lastFence) {
		return lastFence;
	}

	// No code fence found — look for outermost JSON object in raw text
	// Use string-boundary-aware brace matching to handle {/} inside JSON string values.
	// Without this, tool args like {"pattern":"function.*{"} leave the brace stack
	// unbalanced, causing extractLastJson to miss the agent output JSON entirely.
	let inString = false;
	let escaped = false;
	const braceStack: number[] = [];
	let lastCompleteStart = -1;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		// Previous char was backslash — skip this char (it's escaped)
		if (escaped) {
			escaped = false;
			continue;
		}

		// Backslash inside string starts escape sequence
		if (inString && ch === "\\") {
			escaped = true;
			continue;
		}

		// Quote toggles string state
		if (ch === '"') {
			inString = !inString;
			continue;
		}

		// Only count braces outside string values
		if (!inString) {
			if (ch === "{") {
				braceStack.push(i);
			} else if (ch === "}") {
				if (braceStack.length > 0) {
					const start = braceStack.pop()!;
					if (braceStack.length === 0) {
						// This is a complete top-level JSON object
						lastCompleteStart = start;
					}
				}
			}
		}
	}

	if (lastCompleteStart >= 0) {
		// Find the matching closing brace (also string-boundary aware)
		let depth = 0;
		let strOpen = false;
		let esc = false;
		for (let i = lastCompleteStart; i < raw.length; i++) {
			const c = raw[i];

			if (esc) {
				esc = false;
				continue;
			}

			if (strOpen && c === "\\") {
				esc = true;
				continue;
			}

			if (c === '"') {
				strOpen = !strOpen;
				continue;
			}

			if (!strOpen) {
				if (c === "{") depth++;
				else if (c === "}") {
					depth--;
					if (depth === 0) {
						return raw.slice(lastCompleteStart, i + 1);
					}
				}
			}
		}
	}

	return raw;
}

// ─── Validation Helpers ──────────────────────────────────────────

interface ValidationResult {
	valid: boolean;
	errors: string[];
}

function validateAgentOutput(data: Record<string, unknown>): ValidationResult {
	const errors: string[] = [];

	// action is required and must be a valid enum value
	if (data.action === undefined || data.action === null) {
		errors.push("Missing required field: 'action'");
	} else if (typeof data.action !== "string") {
		errors.push("'action' must be a string");
	} else if (!["COMPLETE", "APPROVED", "REJECTED"].includes(data.action)) {
		errors.push(`'action' must be one of: COMPLETE, APPROVED, REJECTED (got: ${data.action})`);
	}

	// agentName is required and must be a string
	if (data.agentName === undefined || data.agentName === null) {
		errors.push("Missing required field: 'agentName'");
	} else if (typeof data.agentName !== "string") {
		errors.push("'agentName' must be a string");
	}

	// refusal — if present, treat as rejection
	if (data.refusal !== undefined && data.refusal !== null) {
		if (typeof data.refusal === "string" && data.refusal.trim().length > 0) {
			errors.push(`Agent refused: ${data.refusal}`);
		}
	}

	// commentBody (optional, must be string if present)
	if (
		data.commentBody !== undefined &&
		data.commentBody !== null &&
		typeof data.commentBody !== "string"
	) {
		errors.push("'commentBody' must be a string if provided");
	}

	// prTitle (optional, must be string if present)
	if (data.prTitle !== undefined && data.prTitle !== null && typeof data.prTitle !== "string") {
		errors.push("'prTitle' must be a string if provided");
	}

	// prBody (optional, must be string if present)
	if (data.prBody !== undefined && data.prBody !== null && typeof data.prBody !== "string") {
		errors.push("'prBody' must be a string if provided");
	}

	// summary (optional, must be string if present)
	if (data.summary !== undefined && data.summary !== null && typeof data.summary !== "string") {
		errors.push("'summary' must be a string if provided");
	}

	// auditScore validation
	if (data.auditScore !== undefined && data.auditScore !== null) {
		if (typeof data.auditScore !== "object" || Array.isArray(data.auditScore)) {
			errors.push("'auditScore' must be an object with 'passing' and 'total' fields");
		} else {
			const score = data.auditScore as Record<string, unknown>;
			if (typeof score.passing !== "number" || typeof score.total !== "number") {
				errors.push("'auditScore.passing' and 'auditScore.total' must be numbers");
			} else {
				if (score.passing < 0 || score.total < 0) {
					errors.push("'auditScore.passing' and 'auditScore.total' must be non-negative");
				}
				if (score.passing > score.total) {
					errors.push(
						`'auditScore.passing' (${score.passing}) cannot exceed 'auditScore.total' (${score.total})`,
					);
				}
			}
		}
	}

	// findings validation
	if (data.findings !== undefined && data.findings !== null) {
		if (!Array.isArray(data.findings)) {
			errors.push("'findings' must be an array if provided");
		} else {
			for (let i = 0; i < data.findings.length; i++) {
				const f = data.findings[i];
				if (typeof f !== "object" || f === null) {
					errors.push(`findings[${i}] must be an object`);
					continue;
				}
				const finding = f as Record<string, unknown>;

				// severity
				if (
					typeof finding.severity !== "string" ||
					!VALID_SEVERITIES.has(finding.severity as FindingSeverity)
				) {
					errors.push(
						`findings[${i}].severity must be one of: ${Array.from(VALID_SEVERITIES).join(", ")}`,
					);
				}

				// dimension
				if (typeof finding.dimension !== "string") {
					errors.push(`findings[${i}].dimension must be a string`);
				}

				// symptom, consequence, remedy are required strings
				if (typeof finding.symptom !== "string" || finding.symptom.trim() === "") {
					errors.push(`findings[${i}].symptom is required and must be a non-empty string`);
				}
				if (typeof finding.consequence !== "string" || finding.consequence.trim() === "") {
					errors.push(`findings[${i}].consequence is required and must be a non-empty string`);
				}
				if (typeof finding.remedy !== "string" || finding.remedy.trim() === "") {
					errors.push(`findings[${i}].remedy is required and must be a non-empty string`);
				}

				// location (optional)
				if (
					finding.location !== undefined &&
					finding.location !== null &&
					typeof finding.location !== "string"
				) {
					errors.push(`findings[${i}].location must be a string if provided`);
				}
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

// ─── Main Parser ──────────────────────────────────────────────────

/**
 * Parse agent output into structured AgentOutput.
 *
 * Strategy:
 * 1. Strip ANSI escape sequences
 * 2. Extract JSON from text (code fences, surrounding text)
 * 3. JSON.parse the extracted text
 * 4. Validate against schema
 *
 * Returns either a valid AgentOutput or a FailedParse with descriptive error.
 */
export function parseAgentOutput(output: string): ParseResult {
	// Guard against null/undefined/empty
	if (output === null || output === undefined) {
		return { error: "Output is null or undefined", rawOutput: String(output) };
	}

	const trimmed = output.trim();
	if (trimmed.length === 0) {
		return { error: "Output is empty", rawOutput: output };
	}

	// Step 1: Strip ANSI escape sequences
	const clean = stripAnsi(trimmed);

	// Step 2: Extract JSON from text
	const jsonStr = extractLastJson(clean);

	// Step 2.5: Sanitize JSON — escape literal newlines inside string values
	// Agents often produce commentBody with actual newlines instead of \\n escapes
	const sanitized = sanitizeJsonStrings(jsonStr);

	// Step 3: Parse JSON (sanitized to handle literal newlines in strings)
	let parsed: unknown;
	try {
		parsed = JSON.parse(sanitized);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			error: `Failed to parse JSON from agent output: ${msg}`,
			rawOutput: output,
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			error: "Parsed JSON must be an object (not array or primitive)",
			rawOutput: output,
		};
	}

	const data = parsed as Record<string, unknown>;

	// Step 4: Validate
	const validation = validateAgentOutput(data);
	if (!validation.valid) {
		return {
			error: `Agent output schema validation failed: ${validation.errors.join("; ")}`,
			rawOutput: output,
		};
	}

	// Step 5: Build typed AgentOutput
	const result: AgentOutput = {
		action: data.action as AgentOutput["action"],
		agentName: data.agentName as string,
	};

	if (data.summary !== undefined && data.summary !== null) {
		result.summary = data.summary as string;
	}
	if (data.commentBody !== undefined && data.commentBody !== null) {
		result.commentBody = data.commentBody as string;
	}
	if (data.prTitle !== undefined && data.prTitle !== null) {
		result.prTitle = data.prTitle as string;
	}
	if (data.prBody !== undefined && data.prBody !== null) {
		result.prBody = data.prBody as string;
	}
	if (data.auditScore !== undefined && data.auditScore !== null) {
		result.auditScore = data.auditScore as { passing: number; total: number };
	}
	if (data.findings !== undefined && data.findings !== null) {
		result.findings = data.findings as AgentOutput["findings"];
	}

	return result;
}

/**
 * Check if a ParseResult is a successful AgentOutput.
 */
export function isSuccess(result: ParseResult): result is AgentOutput {
	return "action" in result && "agentName" in result;
}

/**
 * Check if a ParseResult is a FailedParse.
 */
export function isFailure(result: ParseResult): result is FailedParse {
	return "error" in result && "rawOutput" in result;
}
