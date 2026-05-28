import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Authentication requirements for a remote transport (SEP-2127).
 */
export type MCPServerAuthenticationRequirement = {
    /**
     * Whether authentication is mandatory
     */
    required: boolean;
    /**
     * Supported schemes (e.g. ['bearer', 'oauth2'])
     */
    schemes?: Array<string> | undefined;
};
/** @internal */
export declare const MCPServerAuthenticationRequirement$inboundSchema: z.ZodType<MCPServerAuthenticationRequirement, unknown>;
export declare function mcpServerAuthenticationRequirementFromJSON(jsonString: string): SafeParseResult<MCPServerAuthenticationRequirement, SDKValidationError>;
//# sourceMappingURL=mcpserverauthenticationrequirement.d.ts.map