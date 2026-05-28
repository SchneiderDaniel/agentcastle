import * as z from "zod/v4";
import * as components from "../components/index.js";
export type ResumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequest = {
    scheduleId: string;
    workflowSchedulePauseRequest?: components.WorkflowSchedulePauseRequest | null | undefined;
};
/** @internal */
export type ResumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequest$Outbound = {
    schedule_id: string;
    WorkflowSchedulePauseRequest?: components.WorkflowSchedulePauseRequest$Outbound | null | undefined;
};
/** @internal */
export declare const ResumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequest$outboundSchema: z.ZodType<ResumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequest$Outbound, ResumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequest>;
export declare function resumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequestToJSON(resumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequest: ResumeScheduleV1WorkflowsSchedulesScheduleIdResumePostRequest): string;
//# sourceMappingURL=resumeschedulev1workflowsschedulesscheduleidresumepost.d.ts.map