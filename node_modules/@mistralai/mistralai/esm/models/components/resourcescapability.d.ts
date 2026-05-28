import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for resources operations.
 */
export type ResourcesCapability = {
    subscribe?: boolean | null | undefined;
    listChanged?: boolean | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ResourcesCapability$inboundSchema: z.ZodType<ResourcesCapability, unknown>;
export declare function resourcesCapabilityFromJSON(jsonString: string): SafeParseResult<ResourcesCapability, SDKValidationError>;
//# sourceMappingURL=resourcescapability.d.ts.map