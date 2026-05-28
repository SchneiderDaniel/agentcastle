import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Header definition for a remote transport (SEP-2127).
 */
export type MCPServerRemoteHeader = {
    /**
     * Header name
     */
    name: string;
    /**
     * Human-readable description of the header
     */
    description: string;
    isRequired?: boolean | null | undefined;
    isSecret?: boolean | null | undefined;
    default?: string | null | undefined;
    choices?: Array<string> | null | undefined;
};
/** @internal */
export declare const MCPServerRemoteHeader$inboundSchema: z.ZodType<MCPServerRemoteHeader, unknown>;
export declare function mcpServerRemoteHeaderFromJSON(jsonString: string): SafeParseResult<MCPServerRemoteHeader, SDKValidationError>;
//# sourceMappingURL=mcpserverremoteheader.d.ts.map