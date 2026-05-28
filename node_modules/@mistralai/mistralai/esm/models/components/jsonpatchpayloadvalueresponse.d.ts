import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { JSONPatch } from "./jsonpatch.js";
export type JSONPatchPayloadValueResponse = Array<JSONPatch> | string;
/** @internal */
export declare const JSONPatchPayloadValueResponse$inboundSchema: z.ZodType<JSONPatchPayloadValueResponse, unknown>;
export declare function jsonPatchPayloadValueResponseFromJSON(jsonString: string): SafeParseResult<JSONPatchPayloadValueResponse, SDKValidationError>;
//# sourceMappingURL=jsonpatchpayloadvalueresponse.d.ts.map