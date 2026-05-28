import * as z from "zod/v4";
export type WorkflowBulkArchiveRequest = {
    /**
     * List of workflow IDs to archive
     */
    workflowIds: Array<string>;
};
/** @internal */
export type WorkflowBulkArchiveRequest$Outbound = {
    workflow_ids: Array<string>;
};
/** @internal */
export declare const WorkflowBulkArchiveRequest$outboundSchema: z.ZodType<WorkflowBulkArchiveRequest$Outbound, WorkflowBulkArchiveRequest>;
export declare function workflowBulkArchiveRequestToJSON(workflowBulkArchiveRequest: WorkflowBulkArchiveRequest): string;
//# sourceMappingURL=workflowbulkarchiverequest.d.ts.map