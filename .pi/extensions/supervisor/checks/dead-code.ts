// ─── Dead Code Detection Gate ──────────────────────────────────────
// Pre-audit gate that runs knip on the full worktree, then filters
// results to only flag dead code in changed files (from
// git diff <default-branch> --name-only).
//
// If knip is unavailable, gracefully degrades with status "no_knip".
// The auditor agent then uses ripgrep_search / structural_search as fallback.

// ─── Types ──────────────────────────────────────────────────────────

export interface DeadCodeFinding {
	file: string;
	line: number;
	column?: number;
	type:
		| "unused-export"
		| "unreachable-code"
		| "dead-branch"
		| "orphaned-import"
		| "unused-parameter"
		| "empty-block"
		| "zombie-dependency";
	symbol?: string;
	confidence: "100%" | "90%" | "60%";
	snippet?: string;
}

export interface DeadCodeResult {
	status: "clean" | "dead_found" | "error" | "no_knip";
	findings: DeadCodeFinding[];
	totalDeadLines: number;
	changedFilesScanned: string[];
	/** Optional error message when status is "error" */
	message?: string;
}

// ─── Knip Output Types ──────────────────────────────────────────────

/** A single knip issue entry. */
export interface KnipIssue {
	file: string;
	line: number;
	col?: number;
	symbol?: string;
	symbolType?: string;
	message?: string;
}

/** Top-level knip JSON output structure. */
export interface KnipOutput {
	files?: string[];
	issues?: KnipIssue[];
}

// ─── Exec function type ─────────────────────────────────────────────

export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: Record<string, unknown>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

// ─── Pure Functions ─────────────────────────────────────────────────

/**
 * Map knip symbolType to DeadCodeFinding.type.
 * Unknown types gracefully default to "unused-export".
 */
export function mapKnipFindingType(symbolType: string | undefined): DeadCodeFinding["type"] {
	if (!symbolType) return "unused-export";
	switch (symbolType) {
		case "parameter":
			return "unused-parameter";
		case "import":
			return "orphaned-import";
		case "export":
		case "variable":
		case "type":
		case "function":
		case "class":
		case "interface":
		case "enum":
			return "unused-export";
		default:
			return "unused-export";
	}
}

/**
 * Map knip symbolType to confidence level.
 * - Types knip can detect with certainty (module-level unused exports) → 100%
 * - Parameter warnings → 90% (may be API contract)
 * - Unused files → 60% (may be intentionally reserved)
 */
function mapKnipConfidence(
	symbolType: string | undefined,
	isUnusedFile: boolean,
): DeadCodeFinding["confidence"] {
	if (isUnusedFile) return "60%";
	if (!symbolType) return "100%";
	if (symbolType === "parameter") return "90%";
	return "100%";
}

/**
 * Sum total dead code lines across all findings.
 * Each finding contributes 1 line (line must be > 0).
 */
export function sumDeadLines(findings: DeadCodeFinding[]): number {
	return findings.reduce((sum, f) => sum + (f.line > 0 ? 1 : 0), 0);
}

/**
 * Check if a finding's file is in the set of changed files.
 */
function findingInChangedFiles(finding: DeadCodeFinding, changedFiles: Set<string>): boolean {
	return changedFiles.has(finding.file);
}

/**
 * Filter dead code findings to only those in changed files.
 */
export function filterFindingsToChangedFiles(
	findings: DeadCodeFinding[],
	changedFiles: string[],
): DeadCodeFinding[] {
	if (findings.length === 0 || changedFiles.length === 0) return [];

	const changedSet = new Set(changedFiles);
	return findings.filter((f) => findingInChangedFiles(f, changedSet));
}

/**
 * Build a DeadCodeResult from filtered findings.
 */
export function buildResult(
	filteredFindings: DeadCodeFinding[],
	changedFilesScanned: string[],
): DeadCodeResult {
	const totalDeadLines = sumDeadLines(filteredFindings);

	if (filteredFindings.length === 0) {
		return {
			status: "clean",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned,
		};
	}

	return {
		status: "dead_found",
		findings: filteredFindings,
		totalDeadLines,
		changedFilesScanned,
	};
}

/**
 * Build a formatted string from DeadCodeResult for injection into auditor task context.
 * Returns null if no dead code found or result is null/empty.
 */
export function buildDeadCodeContext(result: DeadCodeResult | null): string | null {
	if (!result) return null;
	if (result.status !== "dead_found") return null;
	if (result.findings.length === 0) return null;

	const lines: string[] = [];
	lines.push(
		`**${result.findings.length} dead code finding(s) found (${result.totalDeadLines} total lines)**`,
	);
	lines.push("");

	for (let i = 0; i < result.findings.length; i++) {
		const finding = result.findings[i]!;
		const colStr = finding.column !== undefined ? `:${finding.column}` : "";
		const symbolStr = finding.symbol !== undefined ? ` \`${finding.symbol}\`` : "";
		const snippetStr = finding.snippet !== undefined ? ` — ${finding.snippet}` : "";

		lines.push(
			`#${i + 1}: \`${finding.file}\` line ${finding.line}${colStr} — **${finding.type}**${symbolStr} (confidence: ${finding.confidence})${snippetStr}`,
		);
	}

	return lines.join("\n");
}

/**
 * Parse knip JSON stdout into DeadCodeFinding[].
 * Returns null if parsing fails.
 */
export function parseKnipOutput(stdout: string): DeadCodeFinding[] | null {
	if (!stdout || stdout.trim() === "") return null;

	let parsed: KnipOutput;
	try {
		parsed = JSON.parse(stdout) as KnipOutput;
	} catch {
		return null;
	}

	const findings: DeadCodeFinding[] = [];

	// Parse unused files
	if (parsed.files && Array.isArray(parsed.files)) {
		for (const file of parsed.files) {
			findings.push({
				file,
				line: 0,
				type: "dead-branch",
				confidence: "60%",
				snippet: "Unused file — not imported anywhere",
			});
		}
	}

	// Parse issues
	if (parsed.issues && Array.isArray(parsed.issues)) {
		for (const issue of parsed.issues) {
			const findingType = mapKnipFindingType(issue.symbolType);
			const confidence = mapKnipConfidence(issue.symbolType, false);
			findings.push({
				file: issue.file,
				line: issue.line,
				column: issue.col,
				type: findingType,
				symbol: issue.symbol,
				confidence,
				snippet: issue.message,
			});
		}
	}

	return findings;
}

// ─── Main Orchestration ────────────────────────────────────────────

/**
 * Run dead code detection on the worktree.
 *
 * Steps:
 * 1. Get changed files via `git diff <defaultBranch> --name-only` from worktree
 * 2. Run knip on the full worktree
 * 3. Parse knip output and filter findings to those in changed files
 * 4. Return result
 *
 * @param exec - Exec function (from pi.exec or mock)
 * @param worktreePath - Path to the worktree
 * @param defaultBranch - Default branch name (e.g. "main")
 * @returns DeadCodeResult
 */
export async function runDeadCodeCheck(
	exec: ExecFn,
	worktreePath: string,
	defaultBranch: string,
): Promise<DeadCodeResult> {
	let changedFiles: string[] = [];

	// Step 1: Get changed files from git diff
	try {
		const diffResult = await exec("git", ["diff", defaultBranch, "--name-only"], {
			cwd: worktreePath,
			timeout: 10_000,
		});
		if (diffResult.code !== 0) {
			return {
				status: "error",
				findings: [],
				totalDeadLines: 0,
				changedFilesScanned: [],
				message: `git diff failed: ${diffResult.stderr || "unknown error"}`,
			};
		}
		changedFiles = (diffResult.stdout || "")
			.trim()
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);

		// No changed files → nothing to check
		if (changedFiles.length === 0) {
			return {
				status: "clean",
				findings: [],
				totalDeadLines: 0,
				changedFilesScanned: [],
			};
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: [],
			message: `git diff failed: ${msg}`,
		};
	}

	// Step 2: Run knip on the full worktree
	let knipStdout: string;
	try {
		const knipResult = await exec("npx", [
			"knip",
			"--reporter",
			"json",
			"--include-entry-exports",
			"--directory",
			worktreePath,
		]);
		// knip exits code 1 when issues found, code 0 when clean, code 2 on error
		if (knipResult.code === 2 && !knipResult.stdout) {
			return {
				status: "error",
				findings: [],
				totalDeadLines: 0,
				changedFilesScanned: changedFiles,
				message: `knip failed: ${knipResult.stderr || "exit code " + knipResult.code}`,
			};
		}
		knipStdout = knipResult.stdout || "";
	} catch (err: unknown) {
		// ENOENT means npx not installed
		if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				status: "no_knip",
				findings: [],
				totalDeadLines: 0,
				changedFilesScanned: changedFiles,
			};
		}
		const msg = err instanceof Error ? err.message : String(err);
		return {
			status: "error",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: changedFiles,
			message: `knip execution error: ${msg}`,
		};
	}

	// Step 3: Parse knip output
	const parsedFindings = parseKnipOutput(knipStdout);
	if (!parsedFindings) {
		return {
			status: "error",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: changedFiles,
			message: "knip returned non-JSON output",
		};
	}

	if (parsedFindings.length === 0) {
		return {
			status: "clean",
			findings: [],
			totalDeadLines: 0,
			changedFilesScanned: changedFiles,
		};
	}

	// Step 4: Filter to only findings in changed files
	const filteredFindings = filterFindingsToChangedFiles(parsedFindings, changedFiles);

	// Step 5: Build and return result
	return buildResult(filteredFindings, changedFiles);
}
