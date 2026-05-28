import * as z from "zod/v4";
import { OpenEnum } from "../../types/enums.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { MCPServerAuthenticationRequirement } from "./mcpserverauthenticationrequirement.js";
import { MCPServerRemoteHeader } from "./mcpserverremoteheader.js";
/**
 * Transport type
 */
export declare const MCPServerRemoteType: {
    readonly StreamableHttp: "streamable-http";
    readonly Sse: "sse";
};
/**
 * Transport type
 */
export type MCPServerRemoteType = OpenEnum<typeof MCPServerRemoteType>;
/**
 * Remote transport endpoint (SEP-2127).
 */
export type MCPServerRemote = {
    /**
     * Transport type
     */
    type: MCPServerRemoteType;
    /**
     * Transport endpoint URL
     */
    url: string;
    supportedProtocolVersions?: Array<string> | null | undefined;
    headers?: Array<MCPServerRemoteHeader> | null | undefined;
    authentication?: MCPServerAuthenticationRequirement | null | undefined;
};
/** @internal */
export declare const MCPServerRemoteType$inboundSchema: z.ZodType<MCPServerRemoteType, unknown>;
/** @internal */
export declare const MCPServerRemote$inboundSchema: z.ZodType<MCPServerRemote, unknown>;
export declare function mcpServerRemoteFromJSON(jsonString: string): SafeParseResult<MCPServerRemote, SDKValidationError>;
//# sourceMappingURL=mcpserverremote.d.ts.map