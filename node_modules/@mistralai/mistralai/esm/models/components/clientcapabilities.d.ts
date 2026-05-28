import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ClientTasksCapability } from "./clienttaskscapability.js";
import { ElicitationCapability } from "./elicitationcapability.js";
import { RootsCapability } from "./rootscapability.js";
import { SamplingCapability } from "./samplingcapability.js";
/**
 * Capabilities a client may support.
 */
export type ClientCapabilities = {
    experimental?: {
        [k: string]: {
            [k: string]: any;
        };
    } | null | undefined;
    sampling?: SamplingCapability | null | undefined;
    elicitation?: ElicitationCapability | null | undefined;
    roots?: RootsCapability | null | undefined;
    tasks?: ClientTasksCapability | null | undefined;
    [additionalProperties: string]: unknown;
};
/** @internal */
export declare const ClientCapabilities$inboundSchema: z.ZodType<ClientCapabilities, unknown>;
export declare function clientCapabilitiesFromJSON(jsonString: string): SafeParseResult<ClientCapabilities, SDKValidationError>;
//# sourceMappingURL=clientcapabilities.d.ts.map