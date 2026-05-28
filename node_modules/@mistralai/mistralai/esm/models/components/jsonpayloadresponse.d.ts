import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { EncodedPayloadOptions } from "./encodedpayloadoptions.js";
/**
 * A payload containing arbitrary JSON data.
 *
 * @remarks
 *
 * Used for complete state snapshots or final results.
 * When encrypted, the value field contains base64-encoded encrypted data
 * and encoding_options indicates the type of encryption applied.
 */
export type JSONPayloadResponse = {
    /**
     * Discriminator indicating this is a raw JSON payload.
     */
    type: "json";
    /**
     * The JSON-serializable payload value. When encrypted, contains base64-encoded data.
     */
    value: any;
    /**
     * Encoding options applied to the payload.
     */
    encodingOptions?: Array<EncodedPayloadOptions> | null | undefined;
};
/** @internal */
export declare const JSONPayloadResponse$inboundSchema: z.ZodType<JSONPayloadResponse, unknown>;
export declare function jsonPayloadResponseFromJSON(jsonString: string): SafeParseResult<JSONPayloadResponse, SDKValidationError>;
//# sourceMappingURL=jsonpayloadresponse.d.ts.map