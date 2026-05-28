import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for tasks elicitation operations.
 */
export type TasksElicitationCapability = {
    create?: {
        [k: string]: any;
    } | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const TasksElicitationCapability$inboundSchema: z.ZodType<TasksElicitationCapability, unknown>;
export declare function tasksElicitationCapabilityFromJSON(jsonString: string): SafeParseResult<TasksElicitationCapability, SDKValidationError>;
//# sourceMappingURL=taskselicitationcapability.d.ts.map