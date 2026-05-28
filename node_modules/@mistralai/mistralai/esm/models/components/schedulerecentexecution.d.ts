import * as z from "zod/v4";
import { Result as SafeParseResult } from "../../types/fp.js";
import { SDKValidationError } from "../errors/sdkvalidationerror.js";
export type ScheduleRecentExecution = {
    /**
     * Time the execution was scheduled to run.
     */
    scheduledAt: Date;
    /**
     * Actual time the execution started.
     */
    startedAt: Date;
    /**
     * ID of the workflow execution that was started.
     */
    executionId: string;
};
/** @internal */
export declare const ScheduleRecentExecution$inboundSchema: z.ZodType<ScheduleRecentExecution, unknown>;
export declare function scheduleRecentExecutionFromJSON(jsonString: string): SafeParseResult<ScheduleRecentExecution, SDKValidationError>;
//# sourceMappingURL=schedulerecentexecution.d.ts.map