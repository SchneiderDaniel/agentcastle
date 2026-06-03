// ─── Agent Output Parser ──────────────────────────────────────────
// Single deterministic parser for all agent outputs.
// Agents output structured JSON; this function parses and validates it.
// No regex fallback, no text marker scanning, no lastIndexOf lookups.

import type { AgentOutput, FailedParse, ParseResult, FindingSeverity } from "../config/types.ts";
import { getDebugLogger } from "../config/debug.ts";

// ─── ANSI Stripping ──────────────────────────────────────────────

const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

// ─── Thinking Prefix Stripping ──────────────────────────────────────

/**
 * Strip "💭 " prefix from lines in text.
 *
 * When agents use `thinking: high`, the JSON output may be emitted inside
 * thinking blocks instead of text blocks. The event handlers push thinking
 * content to fullLog with the "💭 " prefix on each line. This prefix makes
 * the text invalid JSON, causing parseAgentOutput to fail.
 *
 * Stripping "💭 " from the start of each line recovers the original JSON
 * so it can be extracted and parsed correctly.
 */
const THINKING_PREFIX_RE = /^💭\s*/gm;

function stripThinkingPrefix(text: string): string {
	return text.replace(THINKING_PREFIX_RE, "");
}

const VALID_SEVERITIES = new Set<FindingSeverity>(["critical", "warning", "suggestion"]);

// ─── Smart Quote Detection ──────────────────────────────────────

/**
 * Check if a double-quote at position `i` in `text` is a structural close
 * (end of JSON string value) or an unescaped content quote (e.g. markdown
 * "text" inside commentBody).
 *
 * Heuristic: look ahead past whitespace for the next non-whitespace char.
 * If it's `,`, `}`, `]`, or `:`, this `"` closes a JSON string value.
 * Otherwise, it's an unescaped content quote inside a string.
 */
function isStructuralQuote(text: string, i: number): boolean {
	let j = i + 1;
	while (
		j < text.length &&
		(text[j] === " " || text[j] === "\t" || text[j] === "\n" || text[j] === "\r")
	) {
		j++;
	}
	const next = j < text.length ? text[j] : "";
	return next === "," || next === "}" || next === "]" || next === ":";
}

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

	for (let i = 0; i < jsonText.length; i++) {
		const ch = jsonText[i];
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
			if (inString && isStructuralQuote(jsonText, i)) {
				// Structural close — end of string value
				result += ch;
				inString = false;
			} else if (inString) {
				// Unescaped content quote (e.g. markdown "text" in commentBody)
				result += '\\"';
			} else {
				// Opening quote — start of string value or key
				result += ch;
				inString = true;
			}
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
	// Step 1: Find all markdown code fence regions (```json or ```).
	// Unlike the old regex approach, we scan character-by-character
	// to find matching fence pairs. This correctly handles triple
	// backticks inside JSON string values (e.g. markdown code blocks
	// in commentBody) — they are inside a string and don't close the
	// outer fence. We track string boundaries to skip ``` inside strings.
	const fenceContents: string[] = [];
	let pos = 0;
	while (pos < raw.length) {
		// Find opening ``` (optionally followed by "json")
		const fenceStart = raw.indexOf("```", pos);
		if (fenceStart === -1) break;

		// Skip past optional language tag and newline
		let afterOpen = fenceStart + 3;
		if (raw.startsWith("json", afterOpen)) {
			afterOpen += 4;
		}
		// Skip whitespace/newline after opening fence
		while (
			afterOpen < raw.length &&
			(raw[afterOpen] === " " ||
				raw[afterOpen] === "\t" ||
				raw[afterOpen] === "\n" ||
				raw[afterOpen] === "\r")
		) {
			afterOpen++;
		}

		// Scan for closing ``` — string-boundary aware
		// We look for ``` that is NOT inside a JSON string value.
		let inString = false;
		let escaped = false;
		let fenceEnd = -1;
		for (let i = afterOpen; i < raw.length; i++) {
			const ch = raw[i];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (inString && ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') {
				if (inString && isStructuralQuote(raw, i)) {
					// Structural close — end of string value
					inString = false;
				} else if (!inString) {
					// Opening quote — start of string value or key
					inString = true;
				}
				// else: content quote — stay in string, don't toggle
				continue;
			}
			if (!inString && ch === "`" && raw.startsWith("```", i)) {
				fenceEnd = i;
				break;
			}
		}

		if (fenceEnd !== -1) {
			fenceContents.push(raw.slice(afterOpen, fenceEnd).trim());
			pos = fenceEnd + 3;
		} else {
			// Unclosed fence — skip past the opening
			pos = afterOpen;
		}
	}

	// If we found fence content, use the LAST one (JSON is final output)
	if (fenceContents.length > 0) {
		return fenceContents[fenceContents.length - 1];
	}

	// Step 2: No code fences — fall back to string-boundary-aware brace
	// matching for bare JSON objects (or JSON inside unclosed/malformed fences).
	// Uses smart quote detection (isStructuralQuote) to handle unescaped
	// double-quotes inside JSON string values that agents commonly produce
	// in markdown-heavy commentBody fields.
	let inString = false;
	let escaped = false;
	const braceStack: number[] = [];
	let lastCompleteStart = -1;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (inString && ch === "\\") {
			escaped = true;
			continue;
		}

		if (ch === '"') {
			if (inString && isStructuralQuote(raw, i)) {
				// Structural close — end of string value
				inString = false;
			} else if (!inString) {
				// Opening quote — start of string value or key
				inString = true;
			}
			// else: content quote — stay in string, don't toggle
			continue;
		}

		if (!inString) {
			if (ch === "{") {
				braceStack.push(i);
			} else if (ch === "}") {
				if (braceStack.length > 0) {
					const start = braceStack.pop()!;
					if (braceStack.length === 0) {
						lastCompleteStart = start;
					}
				}
			}
		}
	}

	if (lastCompleteStart >= 0) {
		// Find the matching closing brace (also string-boundary aware)
		// Uses smart quote detection for consistency with the first scan.
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
				if (strOpen && isStructuralQuote(raw, i)) {
					// Structural close — end of string value
					strOpen = false;
				} else if (!strOpen) {
					// Opening quote — start of string value or key
					strOpen = true;
				}
				// else: content quote — stay in string, don't toggle
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

	// Step 1.5: Strip "💭 " thinking prefix from lines
	// Agents with thinking:high emit JSON in thinking blocks, which get
	// pushed to fullLog with "💭 " per line. Stripping recovers valid JSON.
	const stripped = stripThinkingPrefix(clean);

	// Step 2: Extract JSON from text
	const jsonStr = extractLastJson(stripped);

	// Step 2.5: Sanitize JSON — escape literal newlines inside string values
	// Agents often produce commentBody with actual newlines instead of \\n escapes
	const sanitized = sanitizeJsonStrings(jsonStr);

	// Step 3: Parse JSON (sanitized to handle literal newlines in strings)
	let parsed: unknown;
	try {
		parsed = JSON.parse(sanitized);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		getDebugLogger().warn("agent-output", `JSON parse failed: ${msg}`, {
			jsonLen: jsonStr.length,
			sanitizedLen: sanitized.length,
		});
		return {
			error: `Failed to parse JSON from agent output: ${msg}`,
			rawOutput: output,
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		getDebugLogger().warn("agent-output", "Parsed JSON not an object");
		return {
			error: "Parsed JSON must be an object (not array or primitive)",
			rawOutput: output,
		};
	}

	const data = parsed as Record<string, unknown>;

	// Step 4: Validate
	const validation = validateAgentOutput(data);
	if (!validation.valid) {
		getDebugLogger().warn(
			"agent-output",
			`Schema validation failed: ${validation.errors.join("; ")}`,
			{
				action: data.action,
				agentName: data.agentName,
			},
		);
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
