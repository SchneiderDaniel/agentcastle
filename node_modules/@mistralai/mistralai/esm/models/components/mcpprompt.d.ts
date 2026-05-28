import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { MCPServerIcon } from "./mcpservericon.js";
import { PromptArgument } from "./promptargument.js";
export type MCPPrompt = {
    name: string;
    title?: string | null | undefined;
    description?: string | null | undefined;
    arguments?: Array<PromptArgument> | null | undefined;
    icons?: Array<MCPServerIcon> | null | undefined;
    meta?: {
        [k: string]: any;
    } | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const MCPPrompt$inboundSchema: z.ZodType<MCPPrompt, unknown>;
export declare function mcpPromptFromJSON(jsonString: string): SafeParseResult<MCPPrompt, SDKValidationError>;
//# sourceMappingURL=mcpprompt.d.ts.map