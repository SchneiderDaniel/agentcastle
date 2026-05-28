import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for tasks sampling operations.
 */
export type TasksSamplingCapability = {
    createMessage?: {
        [k: string]: any;
    } | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const TasksSamplingCapability$inboundSchema: z.ZodType<TasksSamplingCapability, unknown>;
export declare function tasksSamplingCapabilityFromJSON(jsonString: string): SafeParseResult<TasksSamplingCapability, SDKValidationError>;
//# sourceMappingURL=taskssamplingcapability.d.ts.map