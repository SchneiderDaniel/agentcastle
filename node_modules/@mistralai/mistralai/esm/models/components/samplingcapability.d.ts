import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Sampling capability structure, allowing fine-grained capability advertisement.
 */
export type SamplingCapability = {
    context?: {
        [k: string]: any;
    } | null | undefined;
    tools?: {
        [k: string]: any;
    } | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const SamplingCapability$inboundSchema: z.ZodType<SamplingCapability, unknown>;
export declare function samplingCapabilityFromJSON(jsonString: string): SafeParseResult<SamplingCapability, SDKValidationError>;
//# sourceMappingURL=samplingcapability.d.ts.map