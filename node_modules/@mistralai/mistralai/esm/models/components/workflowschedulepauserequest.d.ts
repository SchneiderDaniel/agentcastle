import * as z from "zod/v4";
export type WorkflowSchedulePauseRequest = {
    /**
     * Optional note recorded in Temporal when pausing or resuming a schedule
     */
    note?: string | null | undefined;
};
/** @internal */
export type WorkflowSchedulePauseRequest$Outbound = {
    note?: string | null | undefined;
};
/** @internal */
export declare const WorkflowSchedulePauseRequest$outboundSchema: z.ZodType<WorkflowSchedulePauseRequest$Outbound, WorkflowSchedulePauseRequest>;
export declare function workflowSchedulePauseRequestToJSON(workflowSchedulePauseRequest: WorkflowSchedulePauseRequest): string;
//# sourceMappingURL=workflowschedulepauserequest.d.ts.map