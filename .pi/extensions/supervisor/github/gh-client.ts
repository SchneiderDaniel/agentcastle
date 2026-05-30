// ─── gh CLI wrappers — typed versions ─────────────────────────────
// Low-level gh/ghJson/ghGraphQL with typed generic returns.
// Replaces raw `Promise<any>` returns from the old github.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── gh() — raw CLI wrapper ───────────────────────────────────────

export async function gh(
	pi: ExtensionAPI,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<string> {
	const result = await pi.exec("gh", args, {
		signal: opts?.signal,
		timeout: opts?.timeout ?? 30_000,
	});
	if (result.code !== 0) {
		throw new Error(`gh ${args[0]} failed: ${result.stderr || result.stdout}`);
	}
	return (result.stdout || "").trim();
}

// ─── ghJson<T>() — typed JSON output ──────────────────────────────

export async function ghJson<T = unknown>(
	pi: ExtensionAPI,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<T | null> {
	const output = await gh(pi, args, opts);
	if (!output) return null;
	return JSON.parse(output) as T;
}

// ─── ghGraphQL<T>() — typed GraphQL wrapper ───────────────────────

export async function ghGraphQL<T = unknown>(
	pi: ExtensionAPI,
	query: string,
	opts?: { signal?: AbortSignal; timeout?: number },
): Promise<T | null> {
	const result = await gh(
		pi,
		["api", "graphql", "--header", "Accept: application/vnd.github+json", "-f", `query=${query}`],
		opts,
	);
	if (!result) return null;
	return JSON.parse(result) as T;
}
