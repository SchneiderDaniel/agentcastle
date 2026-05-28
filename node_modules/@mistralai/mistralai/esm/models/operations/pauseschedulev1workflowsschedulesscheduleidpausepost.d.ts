import * as z from "zod/v4";
import * as components from "../components/index.js";
export type PauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequest = {
    scheduleId: string;
    workflowSchedulePauseRequest?: components.WorkflowSchedulePauseRequest | null | undefined;
};
/** @internal */
export type PauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequest$Outbound = {
    schedule_id: string;
    WorkflowSchedulePauseRequest?: components.WorkflowSchedulePauseRequest$Outbound | null | undefined;
};
/** @internal */
export declare const PauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequest$outboundSchema: z.ZodType<PauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequest$Outbound, PauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequest>;
export declare function pauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequestToJSON(pauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequest: PauseScheduleV1WorkflowsSchedulesScheduleIdPausePostRequest): string;
//# sourceMappingURL=pauseschedulev1workflowsschedulesscheduleidpausepost.d.ts.map