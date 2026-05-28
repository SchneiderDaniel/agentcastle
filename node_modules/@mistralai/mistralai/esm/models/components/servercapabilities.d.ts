import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { PromptsCapability } from "./promptscapability.js";
import { ResourcesCapability } from "./resourcescapability.js";
import { ServerTasksCapability } from "./servertaskscapability.js";
import { ToolsCapability } from "./toolscapability.js";
/**
 * Capabilities that a server may support.
 */
export type ServerCapabilities = {
    experimental?: {
        [k: string]: {
            [k: string]: any;
        };
    } | null | undefined;
    logging?: {
        [k: string]: any;
    } | null | undefined;
    prompts?: PromptsCapability | null | undefined;
    resources?: ResourcesCapability | null | undefined;
    tools?: ToolsCapability | null | undefined;
    completions?: {
        [k: string]: any;
    } | null | undefined;
    tasks?: ServerTasksCapability | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ServerCapabilities$inboundSchema: z.ZodType<ServerCapabilities, unknown>;
export declare function serverCapabilitiesFromJSON(jsonString: string): SafeParseResult<ServerCapabilities, SDKValidationError>;
//# sourceMappingURL=servercapabilities.d.ts.map