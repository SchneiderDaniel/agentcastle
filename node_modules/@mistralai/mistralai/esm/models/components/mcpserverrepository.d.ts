import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
/**
 * Source repository information (SEP-2127).
 */
export type MCPServerRepository = {
    /**
     * Repository URL
     */
    url: string;
    /**
     * Source identifier (e.g. 'github')
     */
    source: string;
    subfolder?: string | null | undefined;
};
/** @internal */
export declare const MCPServerRepository$inboundSchema: z.ZodType<MCPServerRepository, unknown>;
export declare function mcpServerRepositoryFromJSON(jsonString: string): SafeParseResult<MCPServerRepository, SDKValidationError>;
//# sourceMappingURL=mcpserverrepository.d.ts.map