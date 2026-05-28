import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { TurbineMeta } from "./turbinemeta.js";
/**
 * Typed _meta for MCP server cards.
 *
 * @remarks
 *
 * Only the 'turbine' field is typed. Other fields are allowed via extra="allow".
 */
export type MCPServerCardMeta = {
    aiMistralTurbine?: TurbineMeta | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const MCPServerCardMeta$inboundSchema: z.ZodType<MCPServerCardMeta, unknown>;
export declare function mcpServerCardMetaFromJSON(jsonString: string): SafeParseResult<MCPServerCardMeta, SDKValidationError>;
//# sourceMappingURL=mcpservercardmeta.d.ts.map