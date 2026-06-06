/** ESLint diagnostic entry parsed from JSON output. */
export interface EslintDiagnostic {
	file: string;
	line: number;
	column: number;
	severity: "Error" | "Warning";
	message: string;
	ruleId: string | null;
}

/**
 * Parse ESLint JSON output into diagnostics array.
 */
export function parseEslintOutput(jsonOutput: string): EslintDiagnostic[] {
	try {
		const data = JSON.parse(jsonOutput);
		if (!Array.isArray(data)) return [];

		const diagnostics: EslintDiagnostic[] = [];

		for (const fileResult of data) {
			if (!fileResult || !Array.isArray(fileResult.messages)) continue;

			const filePath = fileResult.filePath || "unknown";

			for (const msg of fileResult.messages) {
				const severity: "Error" | "Warning" = msg.severity === 2 ? "Error" : "Warning";
				diagnostics.push({
					file: filePath,
					line: msg.line || 0,
					column: msg.column || 0,
					severity,
					message: msg.message || "",
					ruleId: msg.ruleId || null,
				});
			}
		}

		return diagnostics;
	} catch {
		return [];
	}
}

/** Format ESLint diagnostics into developer-readable follow-up message. */
export function formatEslintDiagnostics(diagnostics: EslintDiagnostic[]): string {
	if (!diagnostics || diagnostics.length === 0) return "";

	const byFile = new Map<string, EslintDiagnostic[]>();
	for (const d of diagnostics) {
		const list = byFile.get(d.file) || [];
		list.push(d);
		byFile.set(d.file, list);
	}

	const blocks: string[] = [];
	const files = [...byFile.keys()].sort();
	for (const file of files) {
		const diags = byFile.get(file)!;
		// Sort: errors first, then by line
		diags.sort((a, b) => {
			if (a.severity !== b.severity) return a.severity === "Error" ? -1 : 1;
			if (a.line !== b.line) return a.line - b.line;
			return a.column - b.column;
		});

		const lines: string[] = [];
		for (const d of diags) {
			let msg = d.message;
			if (msg.length > 500) msg = msg.slice(0, 497) + "...";
			const rulePart = d.ruleId ? ` (${d.ruleId})` : "";
			lines.push(`${d.file}, Line ${d.line}: [${d.severity}] ${msg}${rulePart}`);
		}
		if (blocks.length > 0) blocks.push("");
		blocks.push(lines.join("\n"));
	}

	return blocks.join("\n");
}

/** Exec function signature for adapter pattern. */
export type ExecFn = (
	command: string,
	args: string[],
	opts?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;

/**
 * Attempt to run ESLint with given extra args.
 * Returns formatted string on success (or lint errors found).
 * Returns null if ESLint exited with code 2 (config error).
 * Returns empty string if no issues.
 */
async function tryRunEslint(
	exec: ExecFn,
	filePath: string,
	cwd: string,
	extraArgs: string[],
): Promise<string | null> {
	const result = await exec(
		"npx",
		[
			"eslint",
			"--no-error-on-unmatched-pattern",
			"--format",
			"json",
			"--fix",
			...extraArgs,
			filePath,
		],
		{ cwd, timeout: 15_000 },
	);

	// Exit code 2 = config error — signal retry with --no-eslintrc
	if (result.code === 2) return null;

	// Exit code 0 or 1 — parse stdout for diagnostics
	if (result.code === 0 || result.code === 1) {
		const diags = parseEslintOutput(result.stdout);
		if (diags.length === 0) return "";
		return formatEslintDiagnostics(diags);
	}

	// Other error — skip silently
	return "";
}

/**
 * Run ESLint on a single file and return formatted diagnostics message.
 * Returns empty string if no issues found or ESLint is unavailable.
 *
 * ESLint exits code 0 = no errors, 1 = lint errors found, 2 = config error.
 * For code 1, stdout still contains valid JSON array.
 * pi.exec returns non-zero exit as result.code, not thrown exception.
 *
 * For code 2 (config error), retry with --no-eslintrc fallback.
 */
export async function runEslintOnFile(
	exec: ExecFn,
	filePath: string,
	cwd: string,
): Promise<string> {
	// Primary attempt with project ESLint config
	let result = await tryRunEslint(exec, filePath, cwd, []);
	if (result !== null) return result;

	// Config error (exit code 2) — retry with --no-eslintrc fallback
	result = await tryRunEslint(exec, filePath, cwd, ["--no-eslintrc"]);
	return result ?? "";
}
