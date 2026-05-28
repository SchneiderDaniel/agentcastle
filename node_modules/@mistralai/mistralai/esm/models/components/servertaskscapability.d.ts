import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ServerTasksRequestsCapability } from "./servertasksrequestscapability.js";
/**
 * Capability for server tasks operations.
 */
export type ServerTasksCapability = {
    list?: {
        [k: string]: any;
    } | null | undefined;
    cancel?: {
        [k: string]: any;
    } | null | undefined;
    requests?: ServerTasksRequestsCapability | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ServerTasksCapability$inboundSchema: z.ZodType<ServerTasksCapability, unknown>;
export declare function serverTasksCapabilityFromJSON(jsonString: string): SafeParseResult<ServerTasksCapability, SDKValidationError>;
//# sourceMappingURL=servertaskscapability.d.ts.map