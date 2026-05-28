import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ClientTasksRequestsCapability } from "./clienttasksrequestscapability.js";
/**
 * Capability for client tasks operations.
 */
export type ClientTasksCapability = {
    list?: {
        [k: string]: any;
    } | null | undefined;
    cancel?: {
        [k: string]: any;
    } | null | undefined;
    requests?: ClientTasksRequestsCapability | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ClientTasksCapability$inboundSchema: z.ZodType<ClientTasksCapability, unknown>;
export declare function clientTasksCapabilityFromJSON(jsonString: string): SafeParseResult<ClientTasksCapability, SDKValidationError>;
//# sourceMappingURL=clienttaskscapability.d.ts.map