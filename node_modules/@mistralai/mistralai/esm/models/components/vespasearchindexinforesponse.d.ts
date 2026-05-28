import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { VespaSchemaResponse } from "./vespaschemaresponse.js";
export type VespaSearchIndexInfoResponse = {
    type: "vespa";
    k8sCluster: string;
    k8sNamespace: string;
    vespaInstanceName: string;
    schemas: Array<VespaSchemaResponse>;
};
/** @internal */
export declare const VespaSearchIndexInfoResponse$inboundSchema: z.ZodType<VespaSearchIndexInfoResponse, unknown>;
export declare function vespaSearchIndexInfoResponseFromJSON(jsonString: string): SafeParseResult<VespaSearchIndexInfoResponse, SDKValidationError>;
//# sourceMappingURL=vespasearchindexinforesponse.d.ts.map