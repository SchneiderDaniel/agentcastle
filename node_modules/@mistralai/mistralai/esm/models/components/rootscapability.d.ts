import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for root operations.
 */
export type RootsCapability = {
    listChanged?: boolean | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const RootsCapability$inboundSchema: z.ZodType<RootsCapability, unknown>;
export declare function rootsCapabilityFromJSON(jsonString: string): SafeParseResult<RootsCapability, SDKValidationError>;
//# sourceMappingURL=rootscapability.d.ts.map