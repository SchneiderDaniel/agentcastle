import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { Annotations } from "./annotations.js";
import { MCPServerIcon } from "./mcpservericon.js";
export type MCPResource = {
    name: string;
    title?: string | null | undefined;
    uri: string;
    description?: string | null | undefined;
    mimeType?: string | null | undefined;
    size?: number | null | undefined;
    icons?: Array<MCPServerIcon> | null | undefined;
    annotations?: Annotations | null | undefined;
    meta?: {
        [k: string]: any;
    } | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const MCPResource$inboundSchema: z.ZodType<MCPResource, unknown>;
export declare function mcpResourceFromJSON(jsonString: string): SafeParseResult<MCPResource, SDKValidationError>;
//# sourceMappingURL=mcpresource.d.ts.map