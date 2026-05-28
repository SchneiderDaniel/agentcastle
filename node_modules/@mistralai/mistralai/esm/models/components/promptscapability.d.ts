import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for prompts operations.
 */
export type PromptsCapability = {
    listChanged?: boolean | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const PromptsCapability$inboundSchema: z.ZodType<PromptsCapability, unknown>;
export declare function promptsCapabilityFromJSON(jsonString: string): SafeParseResult<PromptsCapability, SDKValidationError>;
//# sourceMappingURL=promptscapability.d.ts.map