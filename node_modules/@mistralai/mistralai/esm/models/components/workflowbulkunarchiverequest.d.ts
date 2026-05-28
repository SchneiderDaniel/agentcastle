import * as z from "zod/v4";
export type WorkflowBulkUnarchiveRequest = {
    /**
     * List of workflow IDs to unarchive
     */
    workflowIds: Array<string>;
};
/** @internal */
export type WorkflowBulkUnarchiveRequest$Outbound = {
    workflow_ids: Array<string>;
};
/** @internal */
export declare const WorkflowBulkUnarchiveRequest$outboundSchema: z.ZodType<WorkflowBulkUnarchiveRequest$Outbound, WorkflowBulkUnarchiveRequest>;
export declare function workflowBulkUnarchiveRequestToJSON(workflowBulkUnarchiveRequest: WorkflowBulkUnarchiveRequest): string;
//# sourceMappingURL=workflowbulkunarchiverequest.d.ts.map