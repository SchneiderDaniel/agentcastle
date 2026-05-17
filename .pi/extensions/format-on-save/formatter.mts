import { buildPrettierArgs } from "./formatting.mts";
import type { ExecFn } from "./eslint.mts";

/**
 * Run prettier --write on a file using exec. Returns true on success.
 */
export async function formatFile(
	exec: ExecFn,
	filePath: string,
	configDir: string,
): Promise<boolean> {
	const { command, args } = buildPrettierArgs(configDir, filePath);
	const result = await exec(command, args, { cwd: configDir, timeout: 15_000 });
	// Non-zero exit is data, not exception
	return result.code === 0;
}
