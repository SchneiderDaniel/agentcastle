import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
export type VespaSchemaResponse = {
    name: string;
    documentCount: number | null;
};
/** @internal */
export declare const VespaSchemaResponse$inboundSchema: z.ZodType<VespaSchemaResponse, unknown>;
export declare function vespaSchemaResponseFromJSON(jsonString: string): SafeParseResult<VespaSchemaResponse, SDKValidationError>;
//# sourceMappingURL=vespaschemaresponse.d.ts.map