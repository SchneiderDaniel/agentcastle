/** Create a successful {@link Result}. */
export function ok(value) {
    return { ok: true, value };
}
/** Create a failed {@link Result}. */
export function err(error) {
    return { ok: false, error };
}
/** Return the success value or throw the failure error. Intended for tests and explicit adapter boundaries. */
export function getOrThrow(result) {
    if (!result.ok)
        throw result.error;
    return result.value;
}
/** Return the success value or `undefined`. Only object values are allowed to avoid truthiness bugs with primitives. */
export function getOrUndefined(result) {
    return result.ok ? result.value : undefined;
}
/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error) {
    if (error instanceof Error)
        return error;
    if (typeof error === "string")
        return new Error(error);
    try {
        return new Error(JSON.stringify(error));
    }
    catch {
        return new Error(String(error));
    }
}
/** Error returned by {@link FileSystem} file operations. */
export class FileError extends Error {
    code;
    path;
    constructor(
    /** Backend-independent error code. */
    code, message, 
    /** Absolute addressed path associated with the failure, when available. */
    path, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.path = path;
        this.name = "FileError";
    }
}
/** Error returned by {@link ExecutionEnv.exec}. */
export class ExecutionError extends Error {
    code;
    constructor(
    /** Backend-independent error code. */
    code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.name = "ExecutionError";
    }
}
/** Error returned by compaction helpers. */
export class CompactionError extends Error {
    code;
    constructor(
    /** Backend-independent error code. */
    code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.name = "CompactionError";
    }
}
/** Error returned by branch summarization helpers. */
export class BranchSummaryError extends Error {
    code;
    constructor(
    /** Backend-independent error code. */
    code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.name = "BranchSummaryError";
    }
}
/** Error thrown by session storage, repositories, and session tree operations. */
export class SessionError extends Error {
    code;
    constructor(
    /** Session subsystem error code. */
    code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.name = "SessionError";
    }
}
/** Public AgentHarness failure with a stable top-level classification. */
export class AgentHarnessError extends Error {
    code;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.code = code;
        this.name = "AgentHarnessError";
    }
}
//# sourceMappingURL=types.js.map