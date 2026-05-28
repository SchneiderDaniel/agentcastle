import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for tasks tools operations.
 */
export type TasksToolsCapability = {
    call?: {
        [k: string]: any;
    } | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const TasksToolsCapability$inboundSchema: z.ZodType<TasksToolsCapability, unknown>;
export declare function tasksToolsCapabilityFromJSON(jsonString: string): SafeParseResult<TasksToolsCapability, SDKValidationError>;
//# sourceMappingURL=taskstoolscapability.d.ts.map