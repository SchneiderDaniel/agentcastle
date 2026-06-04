/**
 * types — Shared type definitions for check-extensions extension
 *
 * Centralizes types used across multiple modules to avoid duplication.
 */

/** Exec function matching pi.exec injection pattern */
export type ExecFn = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
