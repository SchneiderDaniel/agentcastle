import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * An argument for a prompt template.
 */
export type PromptArgument = {
    name: string;
    description?: string | null | undefined;
    required?: boolean | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const PromptArgument$inboundSchema: z.ZodType<PromptArgument, unknown>;
export declare function promptArgumentFromJSON(jsonString: string): SafeParseResult<PromptArgument, SDKValidationError>;
//# sourceMappingURL=promptargument.d.ts.map