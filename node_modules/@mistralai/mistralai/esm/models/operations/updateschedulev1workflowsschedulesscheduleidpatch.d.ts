import * as z from "zod/v4";
import * as components from "../components/index.js";
export type UpdateScheduleV1WorkflowsSchedulesScheduleIdPatchRequest = {
    scheduleId: string;
    workflowScheduleUpdateRequest: components.WorkflowScheduleUpdateRequest;
};
/** @internal */
export type UpdateScheduleV1WorkflowsSchedulesScheduleIdPatchRequest$Outbound = {
    schedule_id: string;
    WorkflowScheduleUpdateRequest: components.WorkflowScheduleUpdateRequest$Outbound;
};
/** @internal */
export declare const UpdateScheduleV1WorkflowsSchedulesScheduleIdPatchRequest$outboundSchema: z.ZodType<UpdateScheduleV1WorkflowsSchedulesScheduleIdPatchRequest$Outbound, UpdateScheduleV1WorkflowsSchedulesScheduleIdPatchRequest>;
export declare function updateScheduleV1WorkflowsSchedulesScheduleIdPatchRequestToJSON(updateScheduleV1WorkflowsSchedulesScheduleIdPatchRequest: UpdateScheduleV1WorkflowsSchedulesScheduleIdPatchRequest): string;
//# sourceMappingURL=updateschedulev1workflowsschedulesscheduleidpatch.d.ts.map