import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
export type ConnectorLocale = {
    name: {
        [k: string]: string;
    };
    description: {
        [k: string]: string;
    };
    usageSentence: {
        [k: string]: string;
    };
};
/** @internal */
export declare const ConnectorLocale$inboundSchema: z.ZodType<ConnectorLocale, unknown>;
export declare function connectorLocaleFromJSON(jsonString: string): SafeParseResult<ConnectorLocale, SDKValidationError>;
//# sourceMappingURL=connectorlocale.d.ts.map