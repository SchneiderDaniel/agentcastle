import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
export type ServerLocale = {
    name?: {
        [k: string]: string;
    } | null | undefined;
    description?: {
        [k: string]: string;
    } | null | undefined;
    usageSentence?: {
        [k: string]: string;
    } | null | undefined;
    workingDescription?: {
        [k: string]: string;
    } | null | undefined;
    doneDescription?: {
        [k: string]: string;
    } | null | undefined;
};
/** @internal */
export declare const ServerLocale$inboundSchema: z.ZodType<ServerLocale, unknown>;
export declare function serverLocaleFromJSON(jsonString: string): SafeParseResult<ServerLocale, SDKValidationError>;
//# sourceMappingURL=serverlocale.d.ts.map