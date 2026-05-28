import * as z from "zod/v4";
import * as discriminatedUnionTypes from "../../types/discriminatedUnion.js";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { JSONPatchAdd } from "./jsonpatchadd.js";
import { JSONPatchAppend } from "./jsonpatchappend.js";
import { JSONPatchRemove } from "./jsonpatchremove.js";
import { JSONPatchReplace } from "./jsonpatchreplace.js";
export type JSONPatch = JSONPatchAdd | JSONPatchAppend | JSONPatchRemove | JSONPatchReplace | discriminatedUnionTypes.Unknown<"op">;
/** @internal */
export declare const JSONPatch$inboundSchema: z.ZodType<JSONPatch, unknown>;
export declare function jsonPatchFromJSON(jsonString: string): SafeParseResult<JSONPatch, SDKValidationError>;
//# sourceMappingURL=jsonpatch.d.ts.map