import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { EncodedPayloadOptions } from "./encodedpayloadoptions.js";
import { JSONPatchPayloadValueResponse } from "./jsonpatchpayloadvalueresponse.js";
/**
 * A payload containing a list of JSON Patch operations.
 *
 * @remarks
 *
 * Used for streaming incremental updates to workflow state.
 * When encrypted, the value field contains base64-encoded encrypted data
 * and encoding_options indicates the type of encryption applied.
 */
export type JSONPatchPayloadResponse = {
    /**
     * Discriminator indicating this is a JSON Patch payload.
     */
    type: "json_patch";
    value: JSONPatchPayloadValueResponse;
    /**
     * Encoding options applied to the payload.
     */
    encodingOptions?: Array<EncodedPayloadOptions> | null | undefined;
};
/** @internal */
export declare const JSONPatchPayloadResponse$inboundSchema: z.ZodType<JSONPatchPayloadResponse, unknown>;
export declare function jsonPatchPayloadResponseFromJSON(jsonString: string): SafeParseResult<JSONPatchPayloadResponse, SDKValidationError>;
//# sourceMappingURL=jsonpatchpayloadresponse.d.ts.map