import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { TasksElicitationCapability } from "./taskselicitationcapability.js";
import { TasksSamplingCapability } from "./taskssamplingcapability.js";
/**
 * Capability for tasks requests operations.
 */
export type ClientTasksRequestsCapability = {
    sampling?: TasksSamplingCapability | null | undefined;
    elicitation?: TasksElicitationCapability | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ClientTasksRequestsCapability$inboundSchema: z.ZodType<ClientTasksRequestsCapability, unknown>;
export declare function clientTasksRequestsCapabilityFromJSON(jsonString: string): SafeParseResult<ClientTasksRequestsCapability, SDKValidationError>;
//# sourceMappingURL=clienttasksrequestscapability.d.ts.map