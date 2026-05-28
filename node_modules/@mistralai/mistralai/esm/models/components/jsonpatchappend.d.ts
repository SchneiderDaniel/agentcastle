import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { EncryptedPatchValue } from "./encryptedpatchvalue.js";
/**
 * The value to use for the operation. A string to append to the existing value, or an EncryptedPatchValue wrapper when encryption is applied.
 */
export type JSONPatchAppendValue = EncryptedPatchValue | string;
export type JSONPatchAppend = {
    /**
     * A JSON Pointer (RFC 6901) identifying the target location within the document. Can be a string path (e.g., '/foo/bar'), '/', '', or an empty list [] for root-level operations.
     */
    path: string;
    /**
     * The value to use for the operation. A string to append to the existing value, or an EncryptedPatchValue wrapper when encryption is applied.
     */
    value: EncryptedPatchValue | string;
    /**
     * 'append' is an extension for efficient string concatenation in streaming scenarios.
     */
    op: "append";
};
/** @internal */
export declare const JSONPatchAppendValue$inboundSchema: z.ZodType<JSONPatchAppendValue, unknown>;
export declare function jsonPatchAppendValueFromJSON(jsonString: string): SafeParseResult<JSONPatchAppendValue, SDKValidationError>;
/** @internal */
export declare const JSONPatchAppend$inboundSchema: z.ZodType<JSONPatchAppend, unknown>;
export declare function jsonPatchAppendFromJSON(jsonString: string): SafeParseResult<JSONPatchAppend, SDKValidationError>;
//# sourceMappingURL=jsonpatchappend.d.ts.map