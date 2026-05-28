import * as z from "zod/v4";
import { PartialScheduleDefinition, PartialScheduleDefinition$Outbound } from "./partialscheduledefinition.js";
export type WorkflowScheduleUpdateRequest = {
    /**
     * Schedule definition for partial updates.
     *
     * @remarks
     *
     * All fields are optional (inherited from _ScheduleRequestBase). Only explicitly-set
     * fields are applied during an update; unset fields preserve the existing schedule values.
     */
    schedule: PartialScheduleDefinition;
};
/** @internal */
export type WorkflowScheduleUpdateRequest$Outbound = {
    schedule: PartialScheduleDefinition$Outbound;
};
/** @internal */
export declare const WorkflowScheduleUpdateRequest$outboundSchema: z.ZodType<WorkflowScheduleUpdateRequest$Outbound, WorkflowScheduleUpdateRequest>;
export declare function workflowScheduleUpdateRequestToJSON(workflowScheduleUpdateRequest: WorkflowScheduleUpdateRequest): string;
//# sourceMappingURL=workflowscheduleupdaterequest.d.ts.map