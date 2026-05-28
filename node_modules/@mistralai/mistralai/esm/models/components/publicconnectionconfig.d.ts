import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ConnectionConfigType } from "./connectionconfigtype.js";
export type PublicConnectionConfig = {
    type?: ConnectionConfigType | undefined;
    baseUrl?: string | null | undefined;
    headers?: {
        [k: string]: string;
    } | null | undefined;
    signed?: boolean | null | undefined;
};
/** @internal */
export declare const PublicConnectionConfig$inboundSchema: z.ZodType<PublicConnectionConfig, unknown>;
export declare function publicConnectionConfigFromJSON(jsonString: string): SafeParseResult<PublicConnectionConfig, SDKValidationError>;
//# sourceMappingURL=publicconnectionconfig.d.ts.map