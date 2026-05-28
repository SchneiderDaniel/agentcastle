import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Capability for tools operations.
 */
export type ToolsCapability = {
    listChanged?: boolean | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ToolsCapability$inboundSchema: z.ZodType<ToolsCapability, unknown>;
export declare function toolsCapabilityFromJSON(jsonString: string): SafeParseResult<ToolsCapability, SDKValidationError>;
//# sourceMappingURL=toolscapability.d.ts.map