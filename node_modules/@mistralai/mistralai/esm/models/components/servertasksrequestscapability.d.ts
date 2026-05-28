import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { TasksToolsCapability } from "./taskstoolscapability.js";
/**
 * Capability for tasks requests operations.
 */
export type ServerTasksRequestsCapability = {
    tools?: TasksToolsCapability | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ServerTasksRequestsCapability$inboundSchema: z.ZodType<ServerTasksRequestsCapability, unknown>;
export declare function serverTasksRequestsCapabilityFromJSON(jsonString: string): SafeParseResult<ServerTasksRequestsCapability, SDKValidationError>;
//# sourceMappingURL=servertasksrequestscapability.d.ts.map