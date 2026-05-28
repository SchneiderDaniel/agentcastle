import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ServerLocale } from "./serverlocale.js";
export type TurbineMeta = {
    systemPromptName?: string | null | undefined;
    locale?: ServerLocale | null | undefined;
};
/** @internal */
export declare const TurbineMeta$inboundSchema: z.ZodType<TurbineMeta, unknown>;
export declare function turbineMetaFromJSON(jsonString: string): SafeParseResult<TurbineMeta, SDKValidationError>;
//# sourceMappingURL=turbinemeta.d.ts.map