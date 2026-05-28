import { type ExecutionEnv, type ExecutionEnvExecOptions, ExecutionError, type Result } from "../types.js";
export interface ShellCaptureOptions extends Omit<ExecutionEnvExecOptions, "onStdout" | "onStderr"> {
    onChunk?: (chunk: string) => void;
}
export interface ShellCaptureResult {
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
}
export declare function sanitizeBinaryOutput(str: string): string;
export declare function executeShellWithCapture(env: ExecutionEnv, command: string, options?: ShellCaptureOptions): Promise<Result<ShellCaptureResult, ExecutionError>>;
//# sourceMappingURL=shell-output.d.ts.map