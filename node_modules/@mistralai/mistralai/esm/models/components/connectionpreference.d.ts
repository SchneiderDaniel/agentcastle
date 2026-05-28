import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
import { ConsumerType } from "./consumertype.js";
import { ToolExecutionConfiguration } from "./toolexecutionconfiguration.js";
export type ConnectionPreference = {
    name: string;
    toolConfiguration: ToolExecutionConfiguration;
    isDefault?: boolean | null | undefined;
    consumerType?: ConsumerType | null | undefined;
};
/** @internal */
export declare const ConnectionPreference$inboundSchema: z.ZodType<ConnectionPreference, unknown>;
export declare function connectionPreferenceFromJSON(jsonString: string): SafeParseResult<ConnectionPreference, SDKValidationError>;
//# sourceMappingURL=connectionpreference.d.ts.map