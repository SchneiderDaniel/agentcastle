import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for elicitation operations.
 *
 * @remarks
 *
 * Clients must support at least one mode (form or url).
 */
export type ElicitationCapability = {
    form?: {
        [k: string]: any;
    } | null | undefined;
    url?: {
        [k: string]: any;
    } | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ElicitationCapability$inboundSchema: z.ZodType<ElicitationCapability, unknown>;
export declare function elicitationCapabilityFromJSON(jsonString: string): SafeParseResult<ElicitationCapability, SDKValidationError>;
//# sourceMappingURL=elicitationcapability.d.ts.map