/**
 * constants.ts — Shared constants for tool-call detection and agent-harness rules.
 *
 * Extracted from bash-command.ts and harness-rules.ts to eliminate
 * duplicate definitions. Both modules import from here.
 *
 * Zero pi dependencies — domain layer only.
 */

/** Bash file-reading commands that should use `read` tool instead. */
export const READ_BASH_CMDS: readonly string[] = Object.freeze([
	"cat",
	"head",
	"tail",
	"less",
	"more",
]);

/**
 * Bash commands that modify files — triggers read cache invalidation.
 */
export const FILE_MODIFY_SIGNALS: readonly string[] = Object.freeze([
	"sed",
	"echo",
	"cat",
	"tee",
	"mv",
	"cp",
	"rm",
	"chmod",
	"dd",
]);
