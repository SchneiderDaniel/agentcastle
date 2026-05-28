import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
export type ScheduleFutureExecution = {
    /**
     * Time the execution is scheduled to run.
     */
    scheduledAt: Date;
};
/** @internal */
export declare const ScheduleFutureExecution$inboundSchema: z.ZodType<ScheduleFutureExecution, unknown>;
export declare function scheduleFutureExecutionFromJSON(jsonString: string): SafeParseResult<ScheduleFutureExecution, SDKValidationError>;
//# sourceMappingURL=schedulefutureexecution.d.ts.map